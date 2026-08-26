import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, toCents } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { systemAccount } from "@/lib/ledger/chart";
import { accountingDate, postJournalEntry, reverseJournalEntry } from "@/lib/ledger/post";
import { amendPosting } from "@/lib/ledger/amend";
import {
  ERASE_ENTRY_INCLUDE,
  eraseEntry,
  snapshotEntry,
  whyNotErasable,
} from "@/lib/ledger/erase";
import { isBaseCurrency, toBase } from "@/lib/ledger/fx";

/**
 * Expenses (SPEC §8.2). Two shapes, both fully modelled:
 *
 *   DIRECT   DR Expense / CR Bank        — paid as it is recorded, terminal
 *   BILL     DR Expense / CR A/P         — owed, cleared later by a BillPayment
 *
 * They share one model but are two forms in the UI, because a confusing toggle
 * is how a bill gets recorded as already paid.
 */

export async function recordExpense(input: {
  companyId: string;
  kind: "DIRECT" | "BILL";
  vendorId?: string | null;
  date: Date;
  currency: string;
  fxRate?: Prisma.Decimal.Value;
  amount: Prisma.Decimal.Value;
  expenseAccountId: string;
  /** Required for DIRECT, ignored for BILL. */
  paymentAccountId?: string | null;
  dueDate?: Date | null;
  description: string;
  reference?: string | null;
  receiptFileKey?: string | null;
  /** A link to the file wherever else it lives. */
  receiptUrl?: string | null;
  isBillable?: boolean;
  customerId?: string | null;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const company = await tx.company.findUniqueOrThrow({
      where: { id: input.companyId },
      select: { baseCurrency: true },
    });

    const amount = toCents(money(input.amount));
    if (amount.lessThanOrEqualTo(0)) throw new PostingError("An expense must be more than zero");

    const expenseAccount = await tx.account.findFirst({
      where: { id: input.expenseAccountId, companyId: input.companyId, isActive: true },
    });
    if (!expenseAccount) throw new PostingError("Expense account not found in this company");

    let vendor = null;
    if (input.vendorId) {
      vendor = await tx.vendor.findFirst({
        where: { id: input.vendorId, companyId: input.companyId },
      });
      if (!vendor) throw new PostingError("Vendor not found in this company");
    }
    if (input.kind === "BILL" && !vendor) {
      // A/P lines carry a party so aging can be built from the ledger (§4.2).
      throw new PostingError("A bill needs a vendor — that is who you owe");
    }

    const foreign = !isBaseCurrency(input.currency, company.baseCurrency);
    const fxRate = foreign ? money(input.fxRate ?? 0) : money(1);
    if (foreign && fxRate.lessThanOrEqualTo(0)) {
      throw new PostingError("A foreign-currency expense needs an exchange rate");
    }
    const baseAmount = toBase(amount, fxRate);

    let paymentAccount = null;
    if (input.kind === "DIRECT") {
      if (!input.paymentAccountId) {
        throw new PostingError("A direct expense needs the account it was paid from");
      }
      paymentAccount = await tx.account.findFirst({
        where: { id: input.paymentAccountId, companyId: input.companyId, isActive: true },
      });
      if (!paymentAccount) throw new PostingError("Payment account not found in this company");
    }

    const expense = await tx.expense.create({
      data: {
        companyId: input.companyId,
        vendorId: vendor?.id ?? null,
        date: accountingDate(input.date),
        kind: input.kind,
        currency: input.currency.toUpperCase(),
        fxRate,
        paymentAccountId: paymentAccount?.id ?? null,
        expenseAccountId: expenseAccount.id,
        amount,
        description: input.description,
        reference: input.reference ?? null,
        receiptFileKey: input.receiptFileKey ?? null,
        receiptUrl: input.receiptUrl ?? null,
        isBillable: input.isBillable ?? false,
        customerId: input.customerId ?? null,
        dueDate: input.kind === "BILL" ? (input.dueDate ? accountingDate(input.dueDate) : null) : null,
        // A direct expense is paid the moment it is recorded and is terminal.
        status: input.kind === "DIRECT" ? "PAID" : "APPROVED",
        amountPaid: input.kind === "DIRECT" ? amount : 0,
        balanceDue: input.kind === "DIRECT" ? 0 : amount,
        baseTotal: baseAmount,
      },
    });

    const creditAccountId =
      input.kind === "DIRECT"
        ? paymentAccount!.id
        : (await systemAccount(input.companyId, SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, tx)).id;

    const entry = await postJournalEntry(
      {
        companyId: input.companyId,
        date: accountingDate(input.date),
        memo: input.description,
        sourceType: "EXPENSE",
        sourceId: expense.id,
        userId: input.userId,
        role: input.role,
        lines: [
          {
            accountId: expenseAccount.id,
            debit: baseAmount,
            description: input.description,
            vendorId: vendor?.id ?? null,
            ...(foreign ? { currency: input.currency.toUpperCase(), fxRate, foreignAmount: amount } : {}),
          },
          {
            accountId: creditAccountId,
            credit: baseAmount,
            description: input.description,
            vendorId: vendor?.id ?? null,
            ...(foreign ? { currency: input.currency.toUpperCase(), fxRate, foreignAmount: amount } : {}),
          },
        ],
      },
      tx,
    );

    return { expense, entry };
  });
}

/** Reverses the posting and marks the expense void. Blocked once paid. */
export async function voidExpense(input: {
  companyId: string;
  expenseId: string;
  date: Date;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const expense = await tx.expense.findFirst({
      where: { id: input.expenseId, companyId: input.companyId },
      include: { applications: { include: { billPayment: true } } },
    });
    if (!expense) throw new PostingError("Expense not found in this company");
    if (expense.status === "VOID") throw new PostingError("This expense is already void");

    const live = expense.applications.filter((a) => !a.billPayment.reversedAt);
    if (live.length > 0) {
      throw new PostingError("This bill has payments applied. Reverse them first.");
    }

    const original = await tx.journalEntry.findFirst({
      where: { companyId: input.companyId, sourceType: "EXPENSE", sourceId: expense.id },
      orderBy: { postedAt: "asc" },
    });
    if (original && !original.reversedByEntryId) {
      await reverseJournalEntry(
        {
          companyId: input.companyId,
          entryId: original.id,
          date: input.date,
          memo: `Void of expense ${expense.description}`,
          userId: input.userId,
          role: input.role,
        },
        tx,
      );
    }

    return tx.expense.update({
      where: { id: expense.id },
      data: { status: "VOID", voidedAt: new Date(), balanceDue: 0, baseRelieved: 0 },
    });
  });
}

/**
 * Change an expense that has already posted (SPEC §4.2 rule 3, §8.2).
 *
 * An expense has no draft state — recording one posts it — so every edit here
 * is a correction to the ledger, not a change to a scratch document. The
 * posting is reversed and rewritten by `amendPosting`; the row itself is
 * updated in place, because the row is not the accounting record, the entry is.
 *
 * The kind is fixed. DIRECT credits the bank and BILL credits A/P, and turning
 * one into the other silently would move money between two accounts that mean
 * very different things. Void it and record it again.
 */
export async function updateExpense(input: {
  companyId: string;
  expenseId: string;
  vendorId?: string | null;
  date: Date;
  currency: string;
  fxRate?: Prisma.Decimal.Value;
  amount: Prisma.Decimal.Value;
  expenseAccountId: string;
  paymentAccountId?: string | null;
  dueDate?: Date | null;
  description: string;
  reference?: string | null;
  /** A link to the file wherever else it lives. */
  receiptUrl?: string | null;
  isBillable?: boolean;
  customerId?: string | null;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.expense.findFirst({
      where: { id: input.expenseId, companyId: input.companyId },
      include: { applications: { include: { billPayment: { select: { reversedAt: true } } } } },
    });
    if (!existing) throw new PostingError("Expense not found in this company");
    if (existing.status === "VOID") {
      throw new PostingError("A void expense cannot be edited. Record it again instead.");
    }

    // SPEC §7.1: editing is blocked entirely once payments are applied. Letting
    // the amount move under a payment would leave the bill and the cash that
    // settled it disagreeing, with nothing on either screen saying so.
    const live = existing.applications.filter((a) => !a.billPayment.reversedAt);
    if (live.length > 0) {
      throw new PostingError(
        "This bill has payments applied. Reverse them first, then edit it.",
      );
    }

    const company = await tx.company.findUniqueOrThrow({
      where: { id: input.companyId },
      select: { baseCurrency: true },
    });

    const kind = existing.kind;
    const amount = toCents(money(input.amount));
    if (amount.lessThanOrEqualTo(0)) throw new PostingError("An expense must be more than zero");

    const expenseAccount = await tx.account.findFirst({
      where: { id: input.expenseAccountId, companyId: input.companyId, isActive: true },
    });
    if (!expenseAccount) throw new PostingError("Expense account not found in this company");

    let vendor = null;
    if (input.vendorId) {
      vendor = await tx.vendor.findFirst({
        where: { id: input.vendorId, companyId: input.companyId },
      });
      if (!vendor) throw new PostingError("Vendor not found in this company");
    }
    if (kind === "BILL" && !vendor) {
      throw new PostingError("A bill needs a vendor — that is who you owe");
    }

    const foreign = !isBaseCurrency(input.currency, company.baseCurrency);
    const fxRate = foreign ? money(input.fxRate ?? 0) : money(1);
    if (foreign && fxRate.lessThanOrEqualTo(0)) {
      throw new PostingError("A foreign-currency expense needs an exchange rate");
    }
    const baseAmount = toBase(amount, fxRate);

    let paymentAccount = null;
    if (kind === "DIRECT") {
      if (!input.paymentAccountId) {
        throw new PostingError("A direct expense needs the account it was paid from");
      }
      paymentAccount = await tx.account.findFirst({
        where: { id: input.paymentAccountId, companyId: input.companyId, isActive: true },
      });
      if (!paymentAccount) throw new PostingError("Payment account not found in this company");
    }

    const creditAccountId =
      kind === "DIRECT"
        ? paymentAccount!.id
        : (await systemAccount(input.companyId, SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, tx)).id;

    const currency = input.currency.toUpperCase();
    const expense = await tx.expense.update({
      where: { id: existing.id },
      data: {
        vendorId: vendor?.id ?? null,
        date: accountingDate(input.date),
        currency,
        fxRate,
        paymentAccountId: paymentAccount?.id ?? null,
        expenseAccountId: expenseAccount.id,
        amount,
        description: input.description,
        reference: input.reference ?? null,
        receiptUrl: input.receiptUrl ?? null,
        isBillable: input.isBillable ?? false,
        customerId: input.customerId ?? null,
        dueDate: kind === "BILL" ? (input.dueDate ? accountingDate(input.dueDate) : null) : null,
        // No payments survive the check above, so the paid side goes back to
        // what a freshly recorded expense of this kind looks like.
        status: kind === "DIRECT" ? "PAID" : "APPROVED",
        amountPaid: kind === "DIRECT" ? amount : 0,
        balanceDue: kind === "DIRECT" ? 0 : amount,
        baseTotal: baseAmount,
        baseRelieved: 0,
      },
    });

    const { reposted } = await amendPosting(
      {
        companyId: input.companyId,
        sourceType: "EXPENSE",
        sourceId: expense.id,
        date: accountingDate(input.date),
        memo: input.description,
        userId: input.userId,
        role: input.role,
        lines: [
          {
            accountId: expenseAccount.id,
            debit: baseAmount,
            description: input.description,
            vendorId: vendor?.id ?? null,
            ...(foreign ? { currency, fxRate, foreignAmount: amount } : {}),
          },
          {
            accountId: creditAccountId,
            credit: baseAmount,
            description: input.description,
            vendorId: vendor?.id ?? null,
            ...(foreign ? { currency, fxRate, foreignAmount: amount } : {}),
          },
        ],
      },
      tx,
    );

    return { expense, entry: reposted };
  });
}

/**
 * Why this expense cannot be deleted, or null if it can. Exported so the list
 * can decide whether to offer the button and say why when it does not.
 */
export type ExpenseDeletableInput = {
  expense: {
    kind: "DIRECT" | "BILL";
    voidedAt: Date | null;
    createdAt: Date;
    applications: { billPayment: { reversedAt: Date | null } }[];
  };
  entry: {
    date: Date;
    reversedByEntryId: string | null;
  } | null;
  postings: number;
  bankMatchCount: number;
  booksClosedThrough: Date | null;
};

export function whyNotDeletableExpense(input: ExpenseDeletableInput): string | null {
  const noun = input.expense.kind === "BILL" ? "bill" : "expense";
  const live = input.expense.applications.filter((a) => !a.billPayment.reversedAt);
  return whyNotErasable({
    noun,
    document: input.expense,
    entry: input.entry,
    postings: input.postings,
    bankMatchCount: input.bankMatchCount,
    booksClosedThrough: input.booksClosedThrough,
    dependency:
      live.length > 0
        ? "This bill has payments applied. Reverse them first, or reverse the bill instead of deleting it."
        : null,
  });
}

/**
 * Erase an expense recorded by mistake — the expense and its journal entry —
 * as if it had never been recorded. Narrow on purpose; see `erase.ts`.
 */
export async function deleteExpense(input: {
  companyId: string;
  expenseId: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const expense = await tx.expense.findFirst({
      where: { id: input.expenseId, companyId: input.companyId },
      include: {
        applications: { include: { billPayment: { select: { reversedAt: true } } } },
        vendor: { select: { name: true } },
        receipt: { select: { id: true } },
      },
    });
    if (!expense) throw new PostingError("Expense not found in this company");

    const entry = await tx.journalEntry.findFirst({
      where: { companyId: input.companyId, sourceType: "EXPENSE", sourceId: expense.id },
      orderBy: { postedAt: "asc" },
      include: ERASE_ENTRY_INCLUDE,
    });

    const [postings, bankMatchCount, company] = await Promise.all([
      tx.journalEntry.count({
        where: { companyId: input.companyId, sourceType: "EXPENSE", sourceId: expense.id },
      }),
      entry
        ? tx.bankTransaction.count({
            where: { companyId: input.companyId, matchedJournalEntryId: entry.id },
          })
        : Promise.resolve(0),
      tx.company.findUniqueOrThrow({
        where: { id: input.companyId },
        select: { booksClosedThrough: true },
      }),
    ]);

    const refusal = whyNotDeletableExpense({
      expense,
      entry,
      postings,
      bankMatchCount,
      booksClosedThrough: company.booksClosedThrough,
    });
    if (refusal) throw new PostingError(refusal);

    // A receipt that was approved into this expense goes back to the inbox
    // rather than being destroyed with it: the photo is the evidence, and the
    // person deleting a mistyped expense still wants to enter it correctly.
    if (expense.receipt) {
      await tx.receiptUpload.update({
        where: { id: expense.receipt.id },
        data: { status: "READY", expenseId: null },
      });
    }

    const snapshot = {
      expense: {
        id: expense.id,
        kind: expense.kind,
        vendorId: expense.vendorId,
        vendorName: expense.vendor?.name ?? null,
        date: expense.date.toISOString().slice(0, 10),
        amount: money(expense.amount).toFixed(2),
        currency: expense.currency,
        fxRate: money(expense.fxRate).toString(),
        expenseAccountId: expense.expenseAccountId,
        paymentAccountId: expense.paymentAccountId,
        dueDate: expense.dueDate ? expense.dueDate.toISOString().slice(0, 10) : null,
        description: expense.description,
        reference: expense.reference,
        receiptUrl: expense.receiptUrl,
        receiptFileKey: expense.receiptFileKey,
        isBillable: expense.isBillable,
        customerId: expense.customerId,
        createdAt: expense.createdAt.toISOString(),
      },
      entry: snapshotEntry(entry!),
    };

    await eraseEntry(tx, entry!.id, input.companyId);
    await tx.expense.delete({ where: { id: expense.id } });

    await tx.auditLog.create({
      data: {
        companyId: input.companyId,
        userId: input.userId,
        action: "expense.deleted",
        entityType: "Expense",
        entityId: expense.id,
        summary: `Deleted ${expense.kind === "BILL" ? "bill" : "expense"} ${money(
          expense.amount,
        ).toFixed(2)} ${expense.currency} — ${expense.description}, entry ${entry!.entryNumber}`,
        data: snapshot,
      },
    });

    return snapshot;
  });
}
