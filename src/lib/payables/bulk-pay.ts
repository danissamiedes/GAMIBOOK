import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { money, sum, toCents } from "@/lib/money";
import { recordBillPayment } from "./bill-payments";

/**
 * Paying many consultants at once (SPEC §6).
 *
 * Settling eighteen bills one screen at a time is the same eighteen decisions
 * typed eighteen times. This makes it one screen — but not one payment.
 *
 * **One payment per consultant, never one across them.** A `BillPayment` names
 * a single vendor, and that is not an implementation detail to route around:
 * you do not write one cheque to eighteen people, and a payment carrying
 * several creditors would put the wrong party on the A/P lines. So a run
 * groups the selection by consultant and records one payment for each, sharing
 * the date, the account and the reference — which is what a disbursement run
 * actually is.
 *
 * Each consultant's payment is its own transaction. One that cannot be
 * recorded — a closed period, a balance that moved while the screen was open —
 * fails alone and is reported by name, rather than taking the other seventeen
 * with it.
 *
 * **Two kinds of document sit in this queue.** A consultant's bill is the
 * ordinary one (SPEC §8.1b): work is agreed on a work order, the work order
 * becomes a bill, and the bill is what gets paid. Work orders raised before
 * that posted to accounts payable on approval and are payable in their own
 * right, so they appear here too until the last of them is settled. A run can
 * carry both for the same consultant — it is one payment either way.
 */

/** How many consultants one run may pay. Past this, the run is two runs. */
export const MAX_BULK_PAYMENTS = 100;

/** Which table a line names. One payment can settle a mix of both. */
export type PayableKind = "bill" | "workOrder";

export type BulkPayLine = {
  kind: PayableKind;
  documentId: string;
  /** What to apply. Defaults to the whole balance on the planning screen. */
  amount: Prisma.Decimal.Value;
};

export type PayableDocument = {
  kind: PayableKind;
  id: string;
  vendorId: string;
  consultantName: string;
  /** The work order's number, or the bill's reference, or its description. */
  label: string;
  date: Date;
  dueDate: Date | null;
  currency: string;
  balanceDue: Prisma.Decimal;
};

export type PlannedPayment = {
  vendorId: string;
  consultantName: string;
  currency: string;
  /** The documents this consultant's payment settles. */
  lines: {
    kind: PayableKind;
    documentId: string;
    label: string;
    balanceDue: Prisma.Decimal;
    amount: Prisma.Decimal;
  }[];
  total: Prisma.Decimal;
  /** Set when this consultant cannot be paid in this run, with the reason. */
  excludedReason?: string;
};

export type BulkPayPlan = {
  payments: PlannedPayment[];
  payable: PlannedPayment[];
  excluded: PlannedPayment[];
  total: Prisma.Decimal;
  /** Base-currency total is meaningless across currencies; null when mixed. */
  currency: string | null;
};

type Filter = {
  companyId: string;
  consultantId?: string | null;
  from?: Date | null;
  to?: Date | null;
};

/**
 * Everything owed to a consultant that is still open, oldest first.
 *
 * Both kinds in one list, sorted as a person reads a payment run: by whom,
 * then by how long it has been waiting.
 */
export async function payableConsultantDocuments(options: Filter): Promise<PayableDocument[]> {
  const [bills, workOrders] = await Promise.all([
    prisma.expense.findMany({
      where: {
        companyId: options.companyId,
        kind: "BILL",
        vendor: { kind: "CONSULTANT" },
        status: { in: ["APPROVED", "PARTIALLY_PAID"] },
        balanceDue: { gt: 0 },
        ...(options.consultantId ? { vendorId: options.consultantId } : {}),
        ...(options.from || options.to
          ? {
              date: {
                ...(options.from ? { gte: options.from } : {}),
                ...(options.to ? { lte: options.to } : {}),
              },
            }
          : {}),
      },
      include: { vendor: { select: { id: true, name: true } } },
      take: 500,
    }),
    prisma.workOrder.findMany({
      where: {
        companyId: options.companyId,
        // Only the ones that are payables in their own right. Everything
        // raised since is owed through the bill it became, and would
        // otherwise be offered for payment twice (SPEC §8.1b).
        postedOnApproval: true,
        status: { in: ["APPROVED", "PARTIALLY_PAID"] },
        balanceDue: { gt: 0 },
        ...(options.consultantId ? { vendorId: options.consultantId } : {}),
        ...(options.from || options.to
          ? {
              issueDate: {
                ...(options.from ? { gte: options.from } : {}),
                ...(options.to ? { lte: options.to } : {}),
              },
            }
          : {}),
      },
      include: { vendor: { select: { id: true, name: true } } },
      take: 500,
    }),
  ]);

  const documents: PayableDocument[] = [
    ...bills.map((bill) => ({
      kind: "bill" as const,
      id: bill.id,
      vendorId: bill.vendorId!,
      consultantName: bill.vendor?.name ?? "(removed)",
      label: bill.reference ?? bill.description,
      date: bill.date,
      dueDate: bill.dueDate,
      currency: bill.currency,
      balanceDue: bill.balanceDue,
    })),
    ...workOrders.map((order) => ({
      kind: "workOrder" as const,
      id: order.id,
      vendorId: order.vendorId,
      consultantName: order.vendor.name,
      label: order.workOrderNumber ?? "(unnumbered)",
      date: order.issueDate,
      dueDate: order.dueDate,
      currency: order.currency,
      balanceDue: order.balanceDue,
    })),
  ];

  return documents.sort(
    (a, b) =>
      a.consultantName.localeCompare(b.consultantName) || a.date.getTime() - b.date.getTime(),
  );
}

/**
 * What the confirmation screen shows before anything is posted.
 *
 * Everything refusable is decided here so the person sees it as a list rather
 * than as a run that stops halfway.
 */
export async function planBulkPay(options: {
  companyId: string;
  lines: BulkPayLine[];
}): Promise<BulkPayPlan> {
  if (options.lines.length === 0) throw new PostingError("Nothing selected");

  // Read back from the database rather than trusted from the form: a balance
  // can move while a screen is open, and the figure that matters is the one
  // that is true now.
  const wanted = new Map(options.lines.map((line) => [`${line.kind}:${line.documentId}`, line]));
  const documents = (
    await payableConsultantDocuments({ companyId: options.companyId })
  ).filter((document) => wanted.has(`${document.kind}:${document.id}`));

  if (documents.length === 0) throw new PostingError("Nothing selected is still outstanding");

  const groups = new Map<string, PayableDocument[]>();
  for (const document of documents) {
    groups.set(document.vendorId, [...(groups.get(document.vendorId) ?? []), document]);
  }

  const payments: PlannedPayment[] = [];
  for (const documentsFor of groups.values()) {
    const name = documentsFor[0].consultantName;
    const lines = documentsFor.map((document) => ({
      kind: document.kind,
      documentId: document.id,
      label: document.label,
      balanceDue: document.balanceDue,
      amount: toCents(
        money(wanted.get(`${document.kind}:${document.id}`)!.amount ?? document.balanceDue),
      ),
    }));

    const currencies = [...new Set(documentsFor.map((document) => document.currency))];
    const overpaid = lines.filter((line) => money(line.amount).greaterThan(money(line.balanceDue)));
    const nonPositive = lines.filter((line) => money(line.amount).lessThanOrEqualTo(0));

    // A payment names one currency, so a consultant owed in two cannot be
    // settled in one. Said here rather than discovered on posting.
    const excludedReason =
      currencies.length > 1
        ? `${name} is owed in ${currencies.join(" and ")}. Pay each currency separately.`
        : nonPositive.length > 0
          ? `${nonPositive[0].label} has no amount to pay.`
          : overpaid.length > 0
            ? `${overpaid[0].label} is only owed ${money(overpaid[0].balanceDue).toFixed(2)}.`
            : undefined;

    payments.push({
      vendorId: documentsFor[0].vendorId,
      consultantName: name,
      currency: currencies[0],
      lines,
      total: sum(lines.map((line) => money(line.amount))),
      excludedReason,
    });
  }

  const payable = payments.filter((payment) => !payment.excludedReason);
  const currencies = [...new Set(payable.map((payment) => payment.currency))];

  return {
    payments,
    payable,
    excluded: payments.filter((payment) => payment.excludedReason),
    total: sum(payable.map((payment) => payment.total)),
    currency: currencies.length === 1 ? currencies[0] : null,
  };
}

export type BulkPayResult = {
  paid: { vendorId: string; consultantName: string; billPaymentId: string; total: string }[];
  failed: { vendorId: string; consultantName: string; reason: string }[];
  skipped: PlannedPayment[];
};

/**
 * Record the run: one payment per consultant, each on its own.
 *
 * Deliberately not one transaction over the whole run. Eighteen postings in one
 * transaction means the eighteenth failing silently unwinds the seventeen that
 * were right, and a payment run half-recorded is easier to finish than one that
 * vanished. So each consultant stands alone and the failures are named.
 */
export async function recordBulkPay(options: {
  companyId: string;
  lines: BulkPayLine[];
  date: Date;
  paymentAccountId: string;
  reference?: string | null;
  userId?: string | null;
  role?: Role | null;
}): Promise<BulkPayResult> {
  const plan = await planBulkPay({ companyId: options.companyId, lines: options.lines });

  if (plan.payable.length === 0) {
    throw new PostingError("None of the selected documents can be paid — see the reasons listed");
  }
  if (plan.payable.length > MAX_BULK_PAYMENTS) {
    throw new PostingError(
      `That is ${plan.payable.length} consultants in one run; the limit is ${MAX_BULK_PAYMENTS}. Narrow the selection.`,
    );
  }

  const paid: BulkPayResult["paid"] = [];
  const failed: BulkPayResult["failed"] = [];

  for (const payment of plan.payable) {
    try {
      const recorded = await recordBillPayment({
        companyId: options.companyId,
        vendorId: payment.vendorId,
        date: options.date,
        amount: payment.total,
        currency: payment.currency,
        paymentAccountId: options.paymentAccountId,
        reference: options.reference ?? null,
        applications: payment.lines.map((line) =>
          line.kind === "bill"
            ? { expenseId: line.documentId, amountApplied: line.amount }
            : { workOrderId: line.documentId, amountApplied: line.amount },
        ),
        userId: options.userId,
        role: options.role,
      });
      paid.push({
        vendorId: payment.vendorId,
        consultantName: payment.consultantName,
        billPaymentId: recorded.payment.id,
        total: money(payment.total).toFixed(2),
      });
    } catch (error) {
      failed.push({
        vendorId: payment.vendorId,
        consultantName: payment.consultantName,
        reason: error instanceof PostingError ? error.message : "Could not be recorded",
      });
    }
  }

  await writeAudit({
    companyId: options.companyId,
    userId: options.userId,
    action: "consultant_bill.bulk_paid",
    entityType: "BillPayment",
    entityId: paid[0]?.billPaymentId ?? null,
    summary: `${paid.length} consultant(s) paid${failed.length ? `, ${failed.length} failed` : ""}`,
    data: {
      paid: paid.map((entry) => ({ consultant: entry.consultantName, total: entry.total })),
      failed,
      reference: options.reference ?? null,
    },
  });

  return { paid, failed, skipped: plan.excluded };
}
