import type { PaymentMethod, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, sum, toCents } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { systemAccount } from "@/lib/ledger/chart";
import { postJournalEntry, reverseJournalEntry, accountingDate } from "@/lib/ledger/post";
import { isBaseCurrency, relieveProRata, toBase } from "@/lib/ledger/fx";
import { recalculateTotals } from "./service";
import { amendPosting } from "@/lib/ledger/amend";
import {
  ERASE_ENTRY_INCLUDE,
  eraseEntry,
  snapshotEntry,
  whyNotErasable,
} from "@/lib/ledger/erase";

/**
 * Payments received from clients (SPEC §7.1) and the settlement posting
 * (SPEC §4.3):
 *
 *   DR  Bank / Undeposited Funds   amount received, at the PAYMENT's rate
 *       CR  Accounts Receivable        amount applied, at the INVOICE's rate
 *   DR/CR  Realized FX Gain/Loss       the difference, if any
 *
 * The receivable is relieved at the **invoice's** historic rate, never the
 * payment's. That is the whole point: A/R was recorded in base currency at
 * issue and must come off at exactly that amount, or the control account never
 * clears to zero. One control-account line per invoice, each at its own rate.
 */

export type PaymentApplicationInput = { invoiceId: string; amountApplied: Prisma.Decimal.Value };

/**
 * Build the journal lines a customer payment posts, create its application
 * rows, and relieve the invoices it settles.
 *
 * Shared by recording a payment and by editing one, so a corrected payment
 * relieves A/R by exactly the arithmetic the original used.
 */
async function applyPayment(
  tx: Prisma.TransactionClient,
  context: {
    companyId: string;
    baseCurrency: string;
    customer: { id: string; name: string };
    paymentId: string;
    depositAccountId: string;
    amount: Prisma.Decimal;
    applied: Prisma.Decimal;
    currency: string;
    paymentRate: Prisma.Decimal;
    foreignPayment: boolean;
    applications: PaymentApplicationInput[];
  },
) {
    const receivable = await systemAccount(context.companyId, SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, tx);
    const lines: Parameters<typeof postJournalEntry>[0]["lines"] = [];

    // Cash leg, at the payment's own rate.
    const baseReceived = toBase(context.amount, context.paymentRate);
    lines.push({
      accountId: context.depositAccountId,
      debit: baseReceived,
      description: `Payment from ${context.customer.name}`,
      customerId: context.customer.id,
      ...(context.foreignPayment
        ? { currency: context.currency, fxRate: context.paymentRate, foreignAmount: context.amount }
        : {}),
    });

    let baseRelievedTotal = money(0);

    for (const application of context.applications) {
      const applicationAmount = toCents(money(application.amountApplied));
      if (applicationAmount.lessThanOrEqualTo(0)) {
        throw new PostingError("Each application must be more than zero");
      }

      const invoice = await tx.invoice.findFirst({
        where: { id: application.invoiceId, companyId: context.companyId },
      });
      if (!invoice) throw new PostingError("Invoice not found in this company");
      if (invoice.status === "DRAFT") {
        throw new PostingError(`Invoice ${invoice.id} is still a draft — issue it before paying it`);
      }
      if (invoice.status === "VOID") throw new PostingError("A void invoice cannot be paid");
      if (invoice.currency !== context.currency) {
        throw new PostingError(
          `Payment is in ${context.currency} but invoice ${invoice.invoiceNumber} is in ${invoice.currency}`,
        );
      }
      if (applicationAmount.greaterThan(money(invoice.balanceDue))) {
        throw new PostingError(
          `Applying ${applicationAmount.toFixed(2)} to invoice ${invoice.invoiceNumber} exceeds its balance of ${money(
            invoice.balanceDue,
          ).toFixed(2)}`,
        );
      }

      const settles = money(invoice.balanceDue).minus(applicationAmount).lessThanOrEqualTo(0);

      // Pro rata at the INVOICE's rate; the final payment takes the residual
      // so the document's base balance lands exactly on zero.
      const baseRelieved = relieveProRata({
        documentBaseTotal: invoice.baseTotal,
        alreadyRelieved: invoice.baseRelieved,
        documentForeignTotal: invoice.total,
        foreignApplied: applicationAmount,
        settlesDocument: settles,
      });

      baseRelievedTotal = baseRelievedTotal.plus(baseRelieved);

      lines.push({
        accountId: receivable.id,
        credit: baseRelieved,
        description: `Invoice ${invoice.invoiceNumber}`,
        customerId: context.customer.id,
        ...(invoice.currency !== context.baseCurrency
          ? {
              currency: invoice.currency,
              fxRate: money(invoice.fxRate),
              foreignAmount: applicationAmount,
            }
          : {}),
      });

      await tx.paymentApplication.create({
        data: {
          paymentId: context.paymentId,
          invoiceId: invoice.id,
          amountApplied: applicationAmount,
        },
      });

      await tx.invoice.update({
        where: { id: invoice.id },
        data: { baseRelieved: money(invoice.baseRelieved).plus(baseRelieved) },
      });

      await recalculateTotals(invoice.id, tx);
    }

    // Anything not applied is a credit on account — shown, never discarded.
    const unapplied = context.amount.minus(context.applied);
    if (unapplied.greaterThan(0)) {
      lines.push({
        accountId: receivable.id,
        credit: toBase(unapplied, context.paymentRate),
        description: "Unapplied — credit on account",
        customerId: context.customer.id,
        ...(context.foreignPayment
          ? {
              currency: context.currency,
              fxRate: context.paymentRate,
              foreignAmount: unapplied,
            }
          : {}),
      });
      baseRelievedTotal = baseRelievedTotal.plus(toBase(unapplied, context.paymentRate));
    }

    // Whatever the two legs disagree about is realized FX (SPEC §4.3).
    const difference = baseReceived.minus(baseRelievedTotal);
    if (!difference.isZero()) {
      const fx = await systemAccount(context.companyId, SYSTEM_ACCOUNTS.REALIZED_FX_GAIN_LOSS, tx);
      lines.push({
        accountId: fx.id,
        // More cash than receivable relieved: a gain, which is a credit.
        credit: difference.isPositive() ? difference : undefined,
        debit: difference.isNegative() ? difference.abs() : undefined,
        description: "Realized FX on settlement",
      });
    }


  return lines;
}

export async function recordPayment(input: {
  companyId: string;
  customerId: string;
  date: Date;
  amount: Prisma.Decimal.Value;
  currency: string;
  fxRate?: Prisma.Decimal.Value;
  depositAccountId: string;
  method?: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
  applications: PaymentApplicationInput[];
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const company = await tx.company.findUniqueOrThrow({
      where: { id: input.companyId },
      select: { baseCurrency: true },
    });

    const amount = toCents(money(input.amount));
    if (amount.lessThanOrEqualTo(0)) throw new PostingError("A payment must be more than zero");

    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, companyId: input.companyId },
    });
    if (!customer) throw new PostingError("Customer not found in this company");

    const deposit = await tx.account.findFirst({
      where: { id: input.depositAccountId, companyId: input.companyId, isActive: true },
    });
    if (!deposit) throw new PostingError("Deposit account not found in this company");

    const foreignPayment = !isBaseCurrency(input.currency, company.baseCurrency);
    const paymentRate = foreignPayment ? money(input.fxRate ?? 0) : money(1);
    if (foreignPayment && paymentRate.lessThanOrEqualTo(0)) {
      throw new PostingError("A foreign-currency payment needs an exchange rate");
    }

    const applied = sum(input.applications.map((application) => money(application.amountApplied)));
    if (applied.greaterThan(amount)) {
      throw new PostingError(
        `Applied ${applied.toFixed(2)} exceeds the payment of ${amount.toFixed(2)}`,
      );
    }

    const payment = await tx.payment.create({
      data: {
        companyId: input.companyId,
        customerId: input.customerId,
        date: accountingDate(input.date),
        amount,
        currency: input.currency.toUpperCase(),
        fxRate: paymentRate,
        depositAccountId: deposit.id,
        method: input.method ?? "BANK_TRANSFER",
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      },
    });

    const lines = await applyPayment(tx, {
      companyId: input.companyId,
      baseCurrency: company.baseCurrency,
      customer,
      paymentId: payment.id,
      depositAccountId: deposit.id,
      amount,
      applied,
      currency: input.currency.toUpperCase(),
      paymentRate,
      foreignPayment,
      applications: input.applications,
    });
    const entry = await postJournalEntry(
      {
        companyId: input.companyId,
        date: accountingDate(input.date),
        memo: `Payment from ${customer.name}`,
        sourceType: "INVOICE_PAYMENT",
        sourceId: payment.id,
        userId: input.userId,
        role: input.role,
        lines,
      },
      tx,
    );

    return { payment, entry };
  });
}

/**
 * Give each invoice back the base amount a payment's applications had
 * relieved, so a later payment relieves the right share at the document's own
 * rate. Shared by reversing a payment and by editing one.
 *
 * Callers must have taken the payment out of the running first — either by
 * stamping `reversedAt` or by deleting the application rows — because
 * `recalculateTotals` counts live applications.
 */
async function restoreInvoices(
  tx: Prisma.TransactionClient,
  applications: { invoiceId: string; amountApplied: Prisma.Decimal }[],
) {
  for (const application of applications) {
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: application.invoiceId } });
    const share = money(invoice.total).isZero()
      ? money(0)
      : toCents(
          money(invoice.baseTotal)
            .times(money(application.amountApplied))
            .dividedBy(money(invoice.total)),
        );
    const restored = money(invoice.baseRelieved).minus(share);
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { baseRelieved: restored.isNegative() ? money(0) : restored },
    });
  }
}

/**
 * Reversing a payment posts a reversing entry, deletes nothing, and recomputes
 * every invoice it touched (SPEC §7.1).
 */
export async function reversePayment(input: {
  companyId: string;
  paymentId: string;
  date: Date;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: input.paymentId, companyId: input.companyId },
      include: { applications: true },
    });
    if (!payment) throw new PostingError("Payment not found in this company");
    if (payment.reversedAt) throw new PostingError("This payment has already been reversed");

    const original = await tx.journalEntry.findFirst({
      where: { companyId: input.companyId, sourceType: "INVOICE_PAYMENT", sourceId: payment.id },
      orderBy: { postedAt: "asc" },
    });
    if (!original) throw new PostingError("No posting found for this payment");

    const reversal = await reverseJournalEntry(
      {
        companyId: input.companyId,
        entryId: original.id,
        date: input.date,
        memo: `Reversal of payment ${payment.reference ?? payment.id}`,
        userId: input.userId,
        role: input.role,
      },
      tx,
    );

    await restoreInvoices(tx, payment.applications);

    await tx.payment.update({
      where: { id: payment.id },
      data: { reversedAt: new Date(), reversalEntryId: reversal.id },
    });

    for (const application of payment.applications) {
      await recalculateTotals(application.invoiceId, tx);
    }

    return reversal;
  });
}

/**
 * Edit a customer payment (SPEC §4.2 rule 3, §7.1).
 *
 * The mirror of editing a bill payment, and the same three steps in the same
 * order: put the invoices back, apply the new amounts against those restored
 * balances, then reverse the old posting and write the corrected one. Applying
 * before restoring would measure each new application against a balance the
 * old payment is still sitting on.
 *
 * Refused once a bank line is matched to it — the statement says this money
 * arrived on a particular day for a particular amount.
 */
export async function updatePayment(input: {
  companyId: string;
  paymentId: string;
  date: Date;
  amount: Prisma.Decimal.Value;
  currency: string;
  fxRate?: Prisma.Decimal.Value;
  depositAccountId: string;
  method?: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
  applications: PaymentApplicationInput[];
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findFirst({
      where: { id: input.paymentId, companyId: input.companyId },
      include: { applications: true, customer: { select: { id: true, name: true } } },
    });
    if (!existing) throw new PostingError("Payment not found in this company");
    if (existing.reversedAt) {
      throw new PostingError("This payment has been reversed. Record a new one instead.");
    }

    const matched = await tx.bankTransaction.count({
      where: { companyId: input.companyId, matchedPaymentId: existing.id },
    });
    if (matched > 0) {
      throw new PostingError(
        "A bank line is matched to this payment. Unmatch it first, then edit it.",
      );
    }

    const company = await tx.company.findUniqueOrThrow({
      where: { id: input.companyId },
      select: { baseCurrency: true },
    });

    const amount = toCents(money(input.amount));
    if (amount.lessThanOrEqualTo(0)) throw new PostingError("A payment must be more than zero");

    const deposit = await tx.account.findFirst({
      where: { id: input.depositAccountId, companyId: input.companyId, isActive: true },
    });
    if (!deposit) throw new PostingError("Deposit account not found in this company");

    const currency = input.currency.toUpperCase();
    const foreignPayment = !isBaseCurrency(currency, company.baseCurrency);
    const paymentRate = foreignPayment ? money(input.fxRate ?? 0) : money(1);
    if (foreignPayment && paymentRate.lessThanOrEqualTo(0)) {
      throw new PostingError("A foreign-currency payment needs an exchange rate");
    }

    const applied = sum(input.applications.map((application) => money(application.amountApplied)));
    if (applied.greaterThan(amount)) {
      throw new PostingError(
        `Applied ${applied.toFixed(2)} exceeds the payment of ${amount.toFixed(2)}`,
      );
    }

    // Step 1: unwind, rows first so the recompute counts only what is live.
    const previous = existing.applications;
    await tx.paymentApplication.deleteMany({ where: { paymentId: existing.id } });
    await restoreInvoices(tx, previous);
    for (const application of previous) {
      await recalculateTotals(application.invoiceId, tx);
    }

    await tx.payment.update({
      where: { id: existing.id },
      data: {
        date: accountingDate(input.date),
        amount,
        currency,
        fxRate: paymentRate,
        depositAccountId: deposit.id,
        method: input.method ?? existing.method,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      },
    });

    // Step 2: apply the new amounts against the restored balances.
    const lines = await applyPayment(tx, {
      companyId: input.companyId,
      baseCurrency: company.baseCurrency,
      customer: existing.customer,
      paymentId: existing.id,
      depositAccountId: deposit.id,
      amount,
      applied,
      currency,
      paymentRate,
      foreignPayment,
      applications: input.applications,
    });

    // Step 3: correct the ledger.
    const { reposted } = await amendPosting(
      {
        companyId: input.companyId,
        sourceType: "INVOICE_PAYMENT",
        sourceId: existing.id,
        date: accountingDate(input.date),
        memo: `Payment from ${existing.customer.name}`,
        userId: input.userId,
        role: input.role,
        lines,
      },
      tx,
    );

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: existing.id },
      include: { applications: true },
    });
    return { payment, entry: reposted };
  });
}

/**
 * Why a customer payment cannot be deleted, or null if it can. Exported so the
 * list decides with the same rule the delete enforces.
 */
export type PaymentDeletableInput = {
  payment: { reversedAt: Date | null; createdAt: Date };
  entry: {
    date: Date;
    reversedByEntryId: string | null;
  } | null;
  postings: number;
  bankMatchCount: number;
  booksClosedThrough: Date | null;
};

export function whyNotDeletablePayment(input: PaymentDeletableInput): string | null {
  return whyNotErasable({
    noun: "payment",
    document: input.payment,
    entry: input.entry,
    postings: input.postings,
    bankMatchCount: input.bankMatchCount,
    booksClosedThrough: input.booksClosedThrough,
  });
}

/**
 * Erase a customer payment recorded by mistake — the payment, its applications
 * and its journal entry — and put the invoices it settled back to where they
 * were. Narrow on purpose; see `erase.ts`.
 */
export async function deletePayment(input: {
  companyId: string;
  paymentId: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: input.paymentId, companyId: input.companyId },
      include: { applications: true, customer: { select: { name: true } } },
    });
    if (!payment) throw new PostingError("Payment not found in this company");

    const entry = await tx.journalEntry.findFirst({
      where: { companyId: input.companyId, sourceType: "INVOICE_PAYMENT", sourceId: payment.id },
      orderBy: { postedAt: "asc" },
      include: ERASE_ENTRY_INCLUDE,
    });

    const [postings, bankMatchCount, company] = await Promise.all([
      tx.journalEntry.count({
        where: { companyId: input.companyId, sourceType: "INVOICE_PAYMENT", sourceId: payment.id },
      }),
      tx.bankTransaction.count({
        where: {
          companyId: input.companyId,
          OR: [
            { matchedPaymentId: payment.id },
            ...(entry ? [{ matchedJournalEntryId: entry.id }] : []),
          ],
        },
      }),
      tx.company.findUniqueOrThrow({
        where: { id: input.companyId },
        select: { booksClosedThrough: true },
      }),
    ]);

    const refusal = whyNotDeletablePayment({
      payment,
      entry,
      postings,
      bankMatchCount,
      booksClosedThrough: company.booksClosedThrough,
    });
    if (refusal) throw new PostingError(refusal);

    const snapshot = {
      payment: {
        id: payment.id,
        customerId: payment.customerId,
        customerName: payment.customer.name,
        date: payment.date.toISOString().slice(0, 10),
        amount: money(payment.amount).toFixed(2),
        currency: payment.currency,
        fxRate: money(payment.fxRate).toString(),
        depositAccountId: payment.depositAccountId,
        method: payment.method,
        reference: payment.reference,
        notes: payment.notes,
        createdAt: payment.createdAt.toISOString(),
      },
      applications: payment.applications.map((application) => ({
        invoiceId: application.invoiceId,
        amountApplied: money(application.amountApplied).toFixed(2),
      })),
      entry: snapshotEntry(entry!),
    };

    // Take the payment out of the running before recomputing, for the same
    // reason reversal does: the recompute counts live applications.
    const applications = payment.applications;
    await tx.paymentApplication.deleteMany({ where: { paymentId: payment.id } });
    await restoreInvoices(tx, applications);

    await eraseEntry(tx, entry!.id, input.companyId);
    await tx.payment.delete({ where: { id: payment.id } });

    for (const application of applications) {
      await recalculateTotals(application.invoiceId, tx);
    }

    await tx.auditLog.create({
      data: {
        companyId: input.companyId,
        userId: input.userId,
        action: "payment.deleted",
        entityType: "Payment",
        entityId: payment.id,
        summary: `Deleted payment of ${money(payment.amount).toFixed(2)} ${
          payment.currency
        } from ${payment.customer.name}, entry ${entry!.entryNumber}`,
        data: snapshot,
      },
    });

    return snapshot;
  });
}
