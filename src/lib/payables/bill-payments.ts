import type { PaymentMethod, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, sum, toCents } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { systemAccount } from "@/lib/ledger/chart";
import { accountingDate, postJournalEntry, reverseJournalEntry } from "@/lib/ledger/post";
import { isBaseCurrency, relieveProRata, toBase } from "@/lib/ledger/fx";
import { amendPosting } from "@/lib/ledger/amend";
import { eraseEntry, snapshotEntry, whyNotErasable } from "@/lib/ledger/erase";
import { recalculateWorkOrder } from "./work-orders";

/**
 * Payments to consultants and vendors (SPEC §8.1) — the mirror of the receipts
 * side, and the same rule (SPEC §4.3):
 *
 *   DR  Accounts Payable    amount applied, at the DOCUMENT's fx rate
 *       CR  Bank                amount paid, at the PAYMENT's fx rate
 *   DR/CR  Realized FX Gain/Loss
 *
 * A/P comes off at the rate the payable was booked at, or the control account
 * never clears. One A/P line per document, each at its own rate.
 */

export type BillApplicationInput = {
  workOrderId?: string;
  expenseId?: string;
  amountApplied: Prisma.Decimal.Value;
};

type OpenDocument = {
  id: string;
  kind: "workOrder" | "expense";
  currency: string;
  fxRate: Prisma.Decimal;
  balanceDue: Prisma.Decimal;
  baseTotal: Prisma.Decimal;
  baseRelieved: Prisma.Decimal;
  total: Prisma.Decimal;
  label: string;
  status: string;
};

/**
 * The document an application points at, proven to belong to the vendor being
 * paid.
 *
 * The vendor check is not a nicety. Without it a payment recorded against one
 * vendor settles another's document: the document goes to PAID, and the A/P
 * lines carry the *payer* as their party while the original credit carries the
 * real creditor — so the control account still nets to zero and the aging
 * total still ties, while per vendor the ledger is wrong in both directions.
 * It is also a hole in section access (SPEC §2.1), since it would let a
 * vendors-only user settle a consultant's work order by naming its id.
 */
async function loadDocument(
  tx: Prisma.TransactionClient,
  companyId: string,
  vendorId: string,
  application: BillApplicationInput,
): Promise<OpenDocument> {
  if (application.workOrderId && application.expenseId) {
    throw new PostingError("An application points at one document, not two");
  }

  if (application.workOrderId) {
    const workOrder = await tx.workOrder.findFirst({
      where: { id: application.workOrderId, companyId },
    });
    if (!workOrder) throw new PostingError("Work order not found in this company");
    if (workOrder.vendorId !== vendorId) {
      throw new PostingError(
        `Work order ${workOrder.workOrderNumber ?? "draft"} is owed to a different vendor. Record the payment against the vendor it belongs to.`,
      );
    }
    return {
      id: workOrder.id,
      kind: "workOrder",
      currency: workOrder.currency,
      fxRate: workOrder.fxRate,
      balanceDue: workOrder.balanceDue,
      baseTotal: workOrder.baseTotal,
      baseRelieved: workOrder.baseRelieved,
      total: workOrder.total,
      label: `Work order ${workOrder.workOrderNumber ?? "draft"}`,
      status: workOrder.status,
    };
  }

  if (application.expenseId) {
    const expense = await tx.expense.findFirst({
      where: { id: application.expenseId, companyId },
    });
    if (!expense) throw new PostingError("Bill not found in this company");
    if (expense.vendorId !== vendorId) {
      throw new PostingError(
        `"${expense.description}" is owed to a different vendor. Record the payment against the vendor it belongs to.`,
      );
    }
    if (expense.kind !== "BILL") {
      throw new PostingError("That expense was paid when it was recorded — there is nothing to settle");
    }
    return {
      id: expense.id,
      kind: "expense",
      currency: expense.currency,
      fxRate: expense.fxRate,
      balanceDue: expense.balanceDue,
      baseTotal: expense.baseTotal,
      baseRelieved: expense.baseRelieved,
      total: expense.amount,
      label: expense.description,
      status: expense.status,
    };
  }

  throw new PostingError("An application must name a work order or a bill");
}

/**
 * What a vendor still owes on, newest debt last. Work orders and bills are the
 * same kind of thing to whoever is paying, so they come back as one list.
 */
export async function openDocumentsForVendor(companyId: string, vendorId: string) {
  const [workOrders, bills] = await Promise.all([
    prisma.workOrder.findMany({
      where: { companyId, vendorId, status: { in: ["APPROVED", "PARTIALLY_PAID"] } },
      orderBy: { dueDate: "asc" },
    }),
    prisma.expense.findMany({
      where: {
        companyId,
        vendorId,
        kind: "BILL",
        status: { in: ["APPROVED", "PARTIALLY_PAID"] },
      },
      orderBy: { date: "asc" },
    }),
  ]);

  return [
    ...workOrders.map((workOrder) => ({
      id: workOrder.id,
      type: "workOrder" as const,
      label: `Work order ${workOrder.workOrderNumber ?? "draft"}`,
      dueDate: workOrder.dueDate,
      currency: workOrder.currency,
      balanceDue: workOrder.balanceDue,
    })),
    ...bills.map((bill) => ({
      id: bill.id,
      type: "expense" as const,
      label: bill.description,
      dueDate: bill.dueDate ?? bill.date,
      currency: bill.currency,
      balanceDue: bill.balanceDue,
    })),
  ]
    .filter((document) => money(document.balanceDue).greaterThan(0))
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

/**
 * Build the journal lines a bill payment posts, create its application rows,
 * and relieve the documents it settles.
 *
 * Shared by recording a payment and by editing one. An edit puts the old
 * applications back before calling this, so from here the two are the same
 * operation: apply these amounts to these documents, each at the document's
 * own fx rate, and say what that cost in the base currency.
 */
async function applyBillPayment(
  tx: Prisma.TransactionClient,
  context: {
    companyId: string;
    baseCurrency: string;
    vendor: { id: string; name: string };
    paymentId: string;
    paymentAccountId: string;
    amount: Prisma.Decimal;
    currency: string;
    paymentRate: Prisma.Decimal;
    foreignPayment: boolean;
    applications: BillApplicationInput[];
  },
) {
  const payable = await systemAccount(context.companyId, SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, tx);
  const lines: Parameters<typeof postJournalEntry>[0]["lines"] = [];
  let baseRelievedTotal = money(0);

  for (const application of context.applications) {
    const applicationAmount = toCents(money(application.amountApplied));
    if (applicationAmount.lessThanOrEqualTo(0)) {
      throw new PostingError("Each application must be more than zero");
    }

    const document = await loadDocument(tx, context.companyId, context.vendor.id, application);
    if (document.status === "DRAFT") {
      throw new PostingError(`${document.label} is still a draft — approve it before paying it`);
    }
    if (document.status === "VOID") throw new PostingError("A void document cannot be paid");
    if (document.currency !== context.currency) {
      throw new PostingError(
        `Payment is in ${context.currency} but ${document.label} is in ${document.currency}`,
      );
    }
    if (applicationAmount.greaterThan(money(document.balanceDue))) {
      throw new PostingError(
        `Applying ${applicationAmount.toFixed(2)} to ${document.label} exceeds its balance of ${money(
          document.balanceDue,
        ).toFixed(2)}`,
      );
    }

    const settles = money(document.balanceDue).minus(applicationAmount).lessThanOrEqualTo(0);
    const baseRelieved = relieveProRata({
      documentBaseTotal: document.baseTotal,
      alreadyRelieved: document.baseRelieved,
      documentForeignTotal: document.total,
      foreignApplied: applicationAmount,
      settlesDocument: settles,
    });
    baseRelievedTotal = baseRelievedTotal.plus(baseRelieved);

    lines.push({
      accountId: payable.id,
      debit: baseRelieved,
      description: document.label,
      vendorId: context.vendor.id,
      ...(document.currency !== context.baseCurrency
        ? {
            currency: document.currency,
            fxRate: money(document.fxRate),
            foreignAmount: applicationAmount,
          }
        : {}),
    });

    await tx.billPaymentApplication.create({
      data: {
        billPaymentId: context.paymentId,
        workOrderId: document.kind === "workOrder" ? document.id : null,
        expenseId: document.kind === "expense" ? document.id : null,
        amountApplied: applicationAmount,
      },
    });

    if (document.kind === "workOrder") {
      await tx.workOrder.update({
        where: { id: document.id },
        data: { baseRelieved: money(document.baseRelieved).plus(baseRelieved) },
      });
      await recalculateWorkOrder(document.id, tx);
    } else {
      const paidNow = money(document.total)
        .minus(money(document.balanceDue))
        .plus(applicationAmount);
      const balance = money(document.total).minus(paidNow);
      await tx.expense.update({
        where: { id: document.id },
        data: {
          baseRelieved: money(document.baseRelieved).plus(baseRelieved),
          amountPaid: paidNow,
          balanceDue: balance,
          status: balance.lessThanOrEqualTo(0) ? "PAID" : "PARTIALLY_PAID",
        },
      });
    }
  }

  // Cash leg, at the payment's own rate.
  const basePaid = toBase(context.amount, context.paymentRate);
  lines.push({
    accountId: context.paymentAccountId,
    credit: basePaid,
    description: `Payment to ${context.vendor.name}`,
    vendorId: context.vendor.id,
    ...(context.foreignPayment
      ? {
          currency: context.currency,
          fxRate: context.paymentRate,
          foreignAmount: context.amount,
        }
      : {}),
  });

  const difference = baseRelievedTotal.minus(basePaid);
  if (!difference.isZero()) {
    const fx = await systemAccount(context.companyId, SYSTEM_ACCOUNTS.REALIZED_FX_GAIN_LOSS, tx);
    lines.push({
      accountId: fx.id,
      // Relieved more payable than cash paid: settling cost less than the
      // liability was booked at, which is a gain.
      credit: difference.isPositive() ? difference : undefined,
      debit: difference.isNegative() ? difference.abs() : undefined,
      description: "Realized FX on settlement",
    });
  }

  return lines;
}

export async function recordBillPayment(input: {
  companyId: string;
  vendorId: string;
  date: Date;
  amount: Prisma.Decimal.Value;
  currency: string;
  fxRate?: Prisma.Decimal.Value;
  paymentAccountId: string;
  method?: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
  applications: BillApplicationInput[];
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

    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, companyId: input.companyId },
    });
    if (!vendor) throw new PostingError("Vendor not found in this company");

    const paymentAccount = await tx.account.findFirst({
      where: { id: input.paymentAccountId, companyId: input.companyId, isActive: true },
    });
    if (!paymentAccount) throw new PostingError("Payment account not found in this company");

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
    if (applied.lessThan(amount)) {
      throw new PostingError(
        "Apply the whole payment. Paying a vendor more than you owe them is an advance, which is not in scope here.",
      );
    }

    const payment = await tx.billPayment.create({
      data: {
        companyId: input.companyId,
        vendorId: vendor.id,
        date: accountingDate(input.date),
        amount,
        currency: input.currency.toUpperCase(),
        fxRate: paymentRate,
        paymentAccountId: paymentAccount.id,
        method: input.method ?? "BANK_TRANSFER",
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      },
    });

    const lines = await applyBillPayment(tx, {
      companyId: input.companyId,
      baseCurrency: company.baseCurrency,
      vendor,
      paymentId: payment.id,
      paymentAccountId: paymentAccount.id,
      amount,
      currency: input.currency.toUpperCase(),
      paymentRate,
      foreignPayment,
      applications: input.applications,
    });
    const entry = await postJournalEntry(
      {
        companyId: input.companyId,
        date: accountingDate(input.date),
        memo: `Payment to ${vendor.name}`,
        sourceType: "CONSULTANT_PAYMENT",
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
 * Put the documents a payment settled back the way they were. Shared by
 * reversal and by same-day delete: what happens to the ledger differs between
 * the two, what happens to the documents does not.
 *
 * Callers must have taken the payment out of the running first — a payment
 * still counted as live leaves its documents looking part-paid after their
 * money has come back.
 */
async function restoreDocuments(
  tx: Prisma.TransactionClient,
  applications: { workOrderId: string | null; expenseId: string | null; amountApplied: Prisma.Decimal }[],
) {
  for (const application of applications) {
    if (application.workOrderId) {
      const workOrder = await tx.workOrder.findUniqueOrThrow({
        where: { id: application.workOrderId },
      });
      const share = money(workOrder.total).isZero()
        ? money(0)
        : toCents(
            money(workOrder.baseTotal)
              .times(money(application.amountApplied))
              .dividedBy(money(workOrder.total)),
          );
      const restored = money(workOrder.baseRelieved).minus(share);
      await tx.workOrder.update({
        where: { id: workOrder.id },
        data: { baseRelieved: restored.isNegative() ? money(0) : restored },
      });
      await recalculateWorkOrder(workOrder.id, tx);
    }

    if (application.expenseId) {
      const expense = await tx.expense.findUniqueOrThrow({ where: { id: application.expenseId } });
      const share = money(expense.amount).isZero()
        ? money(0)
        : toCents(
            money(expense.baseTotal)
              .times(money(application.amountApplied))
              .dividedBy(money(expense.amount)),
          );
      const restoredBase = money(expense.baseRelieved).minus(share);
      const paid = money(expense.amountPaid).minus(money(application.amountApplied));
      const balance = money(expense.amount).minus(paid);
      await tx.expense.update({
        where: { id: expense.id },
        data: {
          baseRelieved: restoredBase.isNegative() ? money(0) : restoredBase,
          amountPaid: paid.isNegative() ? money(0) : paid,
          balanceDue: balance,
          status: paid.lessThanOrEqualTo(0) ? "APPROVED" : "PARTIALLY_PAID",
        },
      });
    }
  }
}

export async function reverseBillPayment(input: {
  companyId: string;
  billPaymentId: string;
  date: Date;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.billPayment.findFirst({
      where: { id: input.billPaymentId, companyId: input.companyId },
      include: { applications: true },
    });
    if (!payment) throw new PostingError("Payment not found in this company");
    if (payment.reversedAt) throw new PostingError("This payment has already been reversed");

    const original = await tx.journalEntry.findFirst({
      where: {
        companyId: input.companyId,
        sourceType: "CONSULTANT_PAYMENT",
        sourceId: payment.id,
      },
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

    // Mark the payment reversed before recomputing anything: the recompute
    // counts live applications, and a payment that is still "live" would leave
    // its documents looking part-paid after their money had been taken back.
    await tx.billPayment.update({
      where: { id: payment.id },
      data: { reversedAt: new Date(), reversalEntryId: reversal.id },
    });

    await restoreDocuments(tx, payment.applications);

    return reversal;
  });
}

/** Said in two places, so it reads the same in the list and from the action. */
export const MULTIPLE_POSTINGS =
  "This payment has more than one posting against it. Reverse it instead.";

/**
 * Why a payment cannot be deleted, or null if it can. Exported so the list can
 * decide whether to offer the button and say why when it does not — the same
 * rules the delete itself enforces, read from one place.
 *
 * The rules themselves are `whyNotErasable`, shared with the other six
 * documents. This keeps the payment-shaped argument the list already builds.
 */
export type DeletableInput = {
  payment: { reversedAt: Date | null; createdAt: Date };
  entry: { postedAt: Date; date: Date; createdByUserId: string | null; reversedByEntryId: string | null } | null;
  bankMatchCount: number;
  booksClosedThrough: Date | null;
  userId: string;
};

export function whyNotDeletable(input: DeletableInput): string | null {
  return whyNotErasable({
    noun: "payment",
    document: input.payment,
    entry: input.entry,
    // The caller counts postings itself and reports MULTIPLE_POSTINGS, which
    // predates the shared rules and reads the same.
    postings: 1,
    bankMatchCount: input.bankMatchCount,
    booksClosedThrough: input.booksClosedThrough,
    userId: input.userId,
  });
}

/**
 * Erase a payment recorded by mistake — the payment, its applications and its
 * journal entry — and put the documents it settled back the way they were.
 *
 * This is the one place in the app that destroys a posting, and it is narrow on
 * purpose: your own payment, within a day, before a bank line or a period close
 * has come to depend on it. Outside that, reversal is the answer and the answer
 * is not negotiable.
 *
 * What is lost is real: nothing afterwards shows that the payment ever existed
 * except the audit row written here, which carries the whole of it, and the gap
 * it leaves in the journal numbering. Both are deliberate — a missing entry
 * number is the thread an auditor pulls.
 */
export async function deleteBillPayment(input: {
  companyId: string;
  billPaymentId: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.billPayment.findFirst({
      where: { id: input.billPaymentId, companyId: input.companyId },
      include: { applications: true, vendor: { select: { name: true } } },
    });
    if (!payment) throw new PostingError("Payment not found in this company");

    const entry = await tx.journalEntry.findFirst({
      where: {
        companyId: input.companyId,
        sourceType: "CONSULTANT_PAYMENT",
        sourceId: payment.id,
      },
      orderBy: { postedAt: "asc" },
      include: { lines: { orderBy: { lineNumber: "asc" } } },
    });

    const [postings, bankMatchCount, company] = await Promise.all([
      tx.journalEntry.count({
        where: { companyId: input.companyId, sourceType: "CONSULTANT_PAYMENT", sourceId: payment.id },
      }),
      tx.bankTransaction.count({
        where: {
          companyId: input.companyId,
          OR: [
            { matchedBillPaymentId: payment.id },
            ...(entry ? [{ matchedJournalEntryId: entry.id }] : []),
          ],
        },
      }),
      tx.company.findUniqueOrThrow({
        where: { id: input.companyId },
        select: { booksClosedThrough: true },
      }),
    ]);

    const refusal = whyNotDeletable({
      payment,
      entry,
      bankMatchCount,
      booksClosedThrough: company.booksClosedThrough,
      userId: input.userId,
    });
    if (refusal) throw new PostingError(refusal);

    // Checked after the rest, because a reversed payment also has two postings
    // and "already reversed" is the more useful thing to be told. More than one
    // posting otherwise means something else has built on this payment, and
    // unwinding the first would leave the ledger holding the rest.
    if (postings > 1) {
      throw new PostingError(MULTIPLE_POSTINGS);
    }

    // Everything about to be destroyed, kept verbatim. The audit trail is
    // append-only (SPEC §13), so this row is the only thing that will still
    // know what the payment was.
    const snapshot = {
      payment: {
        id: payment.id,
        vendorId: payment.vendorId,
        vendorName: payment.vendor.name,
        date: payment.date.toISOString().slice(0, 10),
        amount: money(payment.amount).toFixed(2),
        currency: payment.currency,
        fxRate: money(payment.fxRate).toString(),
        paymentAccountId: payment.paymentAccountId,
        method: payment.method,
        reference: payment.reference,
        notes: payment.notes,
        createdAt: payment.createdAt.toISOString(),
      },
      applications: payment.applications.map((application) => ({
        workOrderId: application.workOrderId,
        expenseId: application.expenseId,
        amountApplied: money(application.amountApplied).toFixed(2),
      })),
      entry: snapshotEntry(entry!),
    };

    // Take the payment out of the running before recomputing, for the same
    // reason reversal does: the recompute counts live applications.
    await tx.billPaymentApplication.deleteMany({ where: { billPaymentId: payment.id } });
    await restoreDocuments(tx, payment.applications);

    await eraseEntry(tx, entry!.id, input.companyId);
    await tx.billPayment.delete({ where: { id: payment.id } });

    await tx.auditLog.create({
      data: {
        companyId: input.companyId,
        userId: input.userId,
        action: "billPayment.deleted",
        entityType: "BillPayment",
        entityId: payment.id,
        summary: `Deleted payment of ${money(payment.amount).toFixed(2)} ${payment.currency} to ${
          payment.vendor.name
        }, entry ${entry!.entryNumber}`,
        data: snapshot,
      },
    });

    return snapshot;
  });
}

/**
 * Edit a bill payment (SPEC §4.2 rule 3, §8.1).
 *
 * A payment has no draft state, so this is always a correction to the ledger.
 * The sequence matters and is the whole difficulty:
 *
 *   1. put the documents the old applications relieved back as they were,
 *   2. apply the new ones against those restored balances,
 *   3. reverse the old posting and write the corrected one.
 *
 * Doing 2 before 1 would measure every new application against a balance that
 * still has the old payment sitting on it, and a payment being edited from
 * 4,000 to 5,000 would be told it exceeds a balance it is itself the reason
 * for.
 *
 * Refused once a bank line is matched: the statement says this payment cleared
 * for a particular amount on a particular day, and changing it underneath the
 * match makes the reconciliation a lie. Unmatch first.
 */
export async function updateBillPayment(input: {
  companyId: string;
  billPaymentId: string;
  date: Date;
  amount: Prisma.Decimal.Value;
  currency: string;
  fxRate?: Prisma.Decimal.Value;
  paymentAccountId: string;
  method?: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
  applications: BillApplicationInput[];
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.billPayment.findFirst({
      where: { id: input.billPaymentId, companyId: input.companyId },
      include: { applications: true, vendor: { select: { id: true, name: true } } },
    });
    if (!existing) throw new PostingError("Payment not found in this company");
    if (existing.reversedAt) {
      throw new PostingError("This payment has been reversed. Record a new one instead.");
    }

    const matched = await tx.bankTransaction.count({
      where: { companyId: input.companyId, matchedBillPaymentId: existing.id },
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

    const paymentAccount = await tx.account.findFirst({
      where: { id: input.paymentAccountId, companyId: input.companyId, isActive: true },
    });
    if (!paymentAccount) throw new PostingError("Payment account not found in this company");

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
    if (applied.lessThan(amount)) {
      throw new PostingError(
        "Apply the whole payment. Paying a vendor more than you owe them is an advance, which is not in scope here.",
      );
    }

    // Step 1: unwind. The rows go first so the recompute inside
    // `restoreDocuments` counts only what is still live.
    const previous = existing.applications;
    await tx.billPaymentApplication.deleteMany({ where: { billPaymentId: existing.id } });
    await restoreDocuments(tx, previous);

    await tx.billPayment.update({
      where: { id: existing.id },
      data: {
        date: accountingDate(input.date),
        amount,
        currency,
        fxRate: paymentRate,
        paymentAccountId: paymentAccount.id,
        method: input.method ?? existing.method,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      },
    });

    // Step 2: apply the new ones against the restored balances.
    const lines = await applyBillPayment(tx, {
      companyId: input.companyId,
      baseCurrency: company.baseCurrency,
      vendor: existing.vendor,
      paymentId: existing.id,
      paymentAccountId: paymentAccount.id,
      amount,
      currency,
      paymentRate,
      foreignPayment,
      applications: input.applications,
    });

    // Step 3: correct the ledger.
    const { reposted } = await amendPosting(
      {
        companyId: input.companyId,
        sourceType: "CONSULTANT_PAYMENT",
        sourceId: existing.id,
        date: accountingDate(input.date),
        memo: `Payment to ${existing.vendor.name}`,
        userId: input.userId,
        role: input.role,
        lines,
      },
      tx,
    );

    const payment = await tx.billPayment.findUniqueOrThrow({
      where: { id: existing.id },
      include: { applications: true },
    });
    return { payment, entry: reposted };
  });
}
