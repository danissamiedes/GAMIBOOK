import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { postJournalEntry, reverseJournalEntry } from "@/lib/ledger/post";
import { recordPayment, reversePayment } from "@/lib/invoices/payments";
import {
  recordBillPayment,
  reverseBillPayment,
} from "@/lib/payables/bill-payments";
import { money, type Money } from "@/lib/money";
import { formatAccountingDate, today } from "@/lib/dates";

/**
 * Matching a bank line to the books (SPEC §8.4).
 *
 * The spec is blunt about the trap here, so it is worth restating: there are
 * three outcomes, they must not overlap, and the one implementers skip is the
 * first. Skipping it is what double-counts cash — the payment is already in the
 * ledger, and "matching" it by posting again records the money twice.
 *
 *   1. LINK      — the payment already exists. Posts NOTHING.
 *   2. SETTLE    — no payment yet; create one against an open document.
 *   3. CATEGORISE— no document at all; post straight to an account.
 *
 * Every matched line ends up pointing at exactly one journal entry, and
 * `createdEntry` records whether this match wrote that entry, so unmatching
 * knows whether it has anything to undo.
 */

/** How far apart a bank line and a payment may be and still be suggested. */
export const MATCH_DAY_TOLERANCE = 5;

export type Candidate = {
  kind: "payment" | "billPayment";
  id: string;
  date: Date;
  party: string;
  amount: Money;
  reference: string | null;
  /** Days between the bank line and the payment; 0 is an exact date match. */
  dayGap: number;
};

/**
 * Payments already recorded that could be this bank line.
 *
 * Amount must match exactly — a bank line is the bank's word for what moved,
 * and a payment that differs is a different payment, not a near miss. The date
 * gets tolerance because a transfer initiated on Friday clears on Monday.
 */
export async function suggestCandidates(options: {
  companyId: string;
  transactionId: string;
}): Promise<Candidate[]> {
  const transaction = await prisma.bankTransaction.findFirstOrThrow({
    where: { id: options.transactionId, companyId: options.companyId },
  });

  const amount = money(transaction.amount);
  const from = new Date(
    transaction.date.getTime() - MATCH_DAY_TOLERANCE * 86_400_000,
  );
  const to = new Date(
    transaction.date.getTime() + MATCH_DAY_TOLERANCE * 86_400_000,
  );
  const gap = (date: Date) =>
    Math.round(
      Math.abs(date.getTime() - transaction.date.getTime()) / 86_400_000,
    );

  // Money in is a customer paying us; money out is us paying somebody. Looking
  // on the wrong side would offer nonsense and invite a wrong match.
  if (amount.greaterThan(0)) {
    const payments = await prisma.payment.findMany({
      where: {
        companyId: options.companyId,
        date: { gte: from, lte: to },
        amount: amount.toFixed(2),
        reversedAt: null,
        bankTransactions: { none: {} },
      },
      include: { customer: { select: { name: true } } },
      take: 20,
    });
    return payments
      .map((payment) => ({
        kind: "payment" as const,
        id: payment.id,
        date: payment.date,
        party: payment.customer.name,
        amount: money(payment.amount),
        reference: payment.reference,
        dayGap: gap(payment.date),
      }))
      .sort((a, b) => a.dayGap - b.dayGap);
  }

  const billPayments = await prisma.billPayment.findMany({
    where: {
      companyId: options.companyId,
      date: { gte: from, lte: to },
      amount: amount.abs().toFixed(2),
      reversedAt: null,
      bankTransactions: { none: {} },
    },
    include: { vendor: { select: { name: true } } },
    take: 20,
  });
  return billPayments
    .map((payment) => ({
      kind: "billPayment" as const,
      id: payment.id,
      date: payment.date,
      party: payment.vendor.name,
      amount: money(payment.amount).negated(),
      reference: payment.reference,
      dayGap: gap(payment.date),
    }))
    .sort((a, b) => a.dayGap - b.dayGap);
}

async function claim(
  tx: Prisma.TransactionClient,
  companyId: string,
  transactionId: string,
) {
  const transaction = await tx.bankTransaction.findFirst({
    where: { id: transactionId, companyId },
  });
  if (!transaction)
    throw new PostingError("Bank transaction not found in this company");
  if (transaction.status === "MATCHED") {
    throw new PostingError("That line is already matched. Unmatch it first.");
  }
  if (transaction.status === "EXCLUDED") {
    throw new PostingError(
      "That line is excluded. Restore it before matching it.",
    );
  }
  return transaction;
}

/**
 * Outcome 1: the payment is already in the books.
 *
 * Posts nothing, on purpose. The bank line is the bank confirming what the
 * app already recorded, so it takes the entry that payment wrote rather than
 * writing another one.
 */
export async function linkToPayment(options: {
  companyId: string;
  transactionId: string;
  paymentId?: string;
  billPaymentId?: string;
  userId?: string | null;
  /**
   * True only when the caller created this payment for this bank line, which
   * is how unmatching knows to reverse it. A payment that already existed is
   * not this line's to undo.
   */
  createdByThisMatch?: boolean;
}) {
  if (Boolean(options.paymentId) === Boolean(options.billPaymentId)) {
    throw new PostingError("Link to one payment, not none and not both");
  }

  return prisma.$transaction(async (tx) => {
    const transaction = await claim(
      tx,
      options.companyId,
      options.transactionId,
    );

    const sourceType = options.paymentId
      ? "INVOICE_PAYMENT"
      : "CONSULTANT_PAYMENT";
    const sourceId = options.paymentId ?? options.billPaymentId!;

    const payment = options.paymentId
      ? await tx.payment.findFirst({
          where: { id: options.paymentId, companyId: options.companyId },
        })
      : await tx.billPayment.findFirst({
          where: { id: options.billPaymentId!, companyId: options.companyId },
        });
    if (!payment) throw new PostingError("Payment not found in this company");
    if (payment.reversedAt)
      throw new PostingError("That payment has been reversed");

    // One bank line per payment, both ways: two lines pointing at one payment
    // would say the money moved twice.
    const alreadyLinked = await tx.bankTransaction.findFirst({
      where: options.paymentId
        ? { matchedPaymentId: options.paymentId }
        : { matchedBillPaymentId: options.billPaymentId! },
    });
    if (alreadyLinked) {
      throw new PostingError(
        "That payment is already linked to another bank line",
      );
    }

    const expected = options.paymentId
      ? money(payment.amount)
      : money(payment.amount).negated();
    if (!expected.equals(money(transaction.amount))) {
      throw new PostingError(
        `The payment is ${expected.toFixed(2)} but the bank line is ${money(transaction.amount).toFixed(2)}`,
      );
    }

    const entry = await tx.journalEntry.findFirst({
      where: { companyId: options.companyId, sourceType, sourceId },
      orderBy: { postedAt: "asc" },
      select: { id: true },
    });
    if (!entry)
      throw new PostingError("That payment has no posting to point at");

    return tx.bankTransaction.update({
      where: { id: transaction.id },
      data: {
        status: "MATCHED",
        matchedPaymentId: options.paymentId ?? null,
        matchedBillPaymentId: options.billPaymentId ?? null,
        matchedJournalEntryId: entry.id,
        // The defining distinction: did this match cause the entry, or merely
        // find one that was already there? Unmatching turns on it.
        createdEntry: options.createdByThisMatch ?? false,
        matchedAt: new Date(),
        matchedByUserId: options.userId ?? null,
      },
    });
  });
}

/**
 * Outcome 2: no payment yet — create one against an open document.
 *
 * Goes through the same payment services as everything else, so settlement,
 * FX relief and status transitions behave identically to a payment entered by
 * hand (SPEC §4.3).
 */
export async function settleWithPayment(options: {
  companyId: string;
  transactionId: string;
  customerId?: string;
  vendorId?: string;
  applications: {
    invoiceId?: string;
    workOrderId?: string;
    expenseId?: string;
    amountApplied: string;
  }[];
  userId?: string | null;
  role?: Role | null;
}) {
  const transaction = await prisma.bankTransaction.findFirstOrThrow({
    where: { id: options.transactionId, companyId: options.companyId },
    include: { bankAccount: true },
  });
  if (transaction.status !== "UNMATCHED") {
    throw new PostingError("That line is not waiting to be matched");
  }

  const amount = money(transaction.amount);
  const incoming = amount.greaterThan(0);

  if (incoming) {
    if (!options.customerId)
      throw new PostingError("Money in settles a customer invoice");
    const { payment } = await recordPayment({
      companyId: options.companyId,
      customerId: options.customerId,
      date: transaction.date,
      amount: amount.toFixed(2),
      currency: transaction.bankAccount.currency,
      depositAccountId: transaction.bankAccount.accountId,
      reference: transaction.reference,
      notes: `Bank: ${transaction.description}`,
      applications: options.applications.map((application) => ({
        invoiceId: application.invoiceId!,
        amountApplied: application.amountApplied,
      })),
      userId: options.userId,
      role: options.role,
    });
    return linkToPayment({
      companyId: options.companyId,
      transactionId: options.transactionId,
      paymentId: payment.id,
      userId: options.userId,
      createdByThisMatch: true,
    });
  }

  if (!options.vendorId)
    throw new PostingError("Money out settles a vendor's document");
  const { payment } = await recordBillPayment({
    companyId: options.companyId,
    vendorId: options.vendorId,
    date: transaction.date,
    amount: amount.abs().toFixed(2),
    currency: transaction.bankAccount.currency,
    paymentAccountId: transaction.bankAccount.accountId,
    reference: transaction.reference,
    notes: `Bank: ${transaction.description}`,
    applications: options.applications.map((application) => ({
      workOrderId: application.workOrderId,
      expenseId: application.expenseId,
      amountApplied: application.amountApplied,
    })),
    userId: options.userId,
    role: options.role,
  });
  return linkToPayment({
    companyId: options.companyId,
    transactionId: options.transactionId,
    billPaymentId: payment.id,
    userId: options.userId,
    createdByThisMatch: true,
  });
}

/**
 * Outcome 3: nothing in the books to match — a bank fee, interest, a small
 * expense. Posts the entry itself, against the bank's own GL account.
 */
export async function categoriseDirectly(options: {
  companyId: string;
  transactionId: string;
  accountId: string;
  memo?: string | null;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const transaction = await claim(
      tx,
      options.companyId,
      options.transactionId,
    );
    const bankAccount = await tx.bankAccount.findUniqueOrThrow({
      where: { id: transaction.bankAccountId },
    });

    const amount = money(transaction.amount);
    if (amount.isZero())
      throw new PostingError("A zero line has nothing to post");

    const incoming = amount.greaterThan(0);
    const entry = await postJournalEntry(
      {
        companyId: options.companyId,
        date: transaction.date,
        memo: options.memo?.trim() || transaction.description,
        sourceType: "BANK_TRANSACTION",
        sourceId: transaction.id,
        userId: options.userId,
        role: options.role,
        lines: incoming
          ? [
              { accountId: bankAccount.accountId, debit: amount.toFixed(2) },
              { accountId: options.accountId, credit: amount.toFixed(2) },
            ]
          : [
              { accountId: options.accountId, debit: amount.abs().toFixed(2) },
              {
                accountId: bankAccount.accountId,
                credit: amount.abs().toFixed(2),
              },
            ],
      },
      tx,
    );

    return tx.bankTransaction.update({
      where: { id: transaction.id },
      data: {
        status: "MATCHED",
        matchedJournalEntryId: entry.id,
        // This match wrote the entry, so unmatching must reverse it.
        createdEntry: true,
        matchedAt: new Date(),
        matchedByUserId: options.userId ?? null,
      },
    });
  });
}

/**
 * Undo a match, reversing whatever it created — and nothing when it created
 * nothing, which is the case that matters (SPEC §8.4).
 */
export async function unmatch(options: {
  companyId: string;
  transactionId: string;
  date?: Date;
  userId?: string | null;
  role?: Role | null;
}) {
  const transaction = await prisma.bankTransaction.findFirstOrThrow({
    where: { id: options.transactionId, companyId: options.companyId },
  });
  if (transaction.status !== "MATCHED")
    throw new PostingError("That line is not matched");

  const date = options.date ?? today();

  // A payment this line created is reversed through its own service, so the
  // documents it settled go back to being owed. A payment that merely *found*
  // an entry is left alone: the money really did move, and the bank line was
  // only ever its confirmation.
  if (transaction.createdEntry) {
    if (transaction.matchedPaymentId) {
      await reversePayment({
        companyId: options.companyId,
        paymentId: transaction.matchedPaymentId,
        date,
        userId: options.userId,
        role: options.role,
      });
    } else if (transaction.matchedBillPaymentId) {
      await reverseBillPayment({
        companyId: options.companyId,
        billPaymentId: transaction.matchedBillPaymentId,
        date,
        userId: options.userId,
        role: options.role,
      });
    } else if (transaction.matchedJournalEntryId) {
      await reverseJournalEntry({
        companyId: options.companyId,
        entryId: transaction.matchedJournalEntryId,
        date,
        memo: `Unmatched bank line ${formatAccountingDate(transaction.date)}`,
        userId: options.userId,
        role: options.role,
      });
    }
  }

  return prisma.bankTransaction.update({
    where: { id: transaction.id },
    data: {
      status: "UNMATCHED",
      matchedPaymentId: null,
      matchedBillPaymentId: null,
      matchedJournalEntryId: null,
      createdEntry: false,
      matchedAt: null,
      matchedByUserId: null,
    },
  });
}

/** Set aside a line that is not ours to account for — an opening balance row. */
export async function setExcluded(options: {
  companyId: string;
  transactionId: string;
  excluded: boolean;
}) {
  const transaction = await prisma.bankTransaction.findFirstOrThrow({
    where: { id: options.transactionId, companyId: options.companyId },
  });
  if (transaction.status === "MATCHED") {
    throw new PostingError("Unmatch it before excluding it");
  }
  return prisma.bankTransaction.update({
    where: { id: transaction.id },
    data: { status: options.excluded ? "EXCLUDED" : "UNMATCHED" },
  });
}

/** The badge count the spec calls the daily driver of the workflow. */
export function unmatchedCount(companyId: string): Promise<number> {
  return prisma.bankTransaction.count({
    where: { companyId, status: "UNMATCHED" },
  });
}
