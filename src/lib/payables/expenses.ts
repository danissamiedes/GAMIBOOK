import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, toCents } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { systemAccount } from "@/lib/ledger/chart";
import { accountingDate, postJournalEntry, reverseJournalEntry } from "@/lib/ledger/post";
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
