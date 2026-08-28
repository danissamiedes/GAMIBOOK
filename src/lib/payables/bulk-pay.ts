import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { money, sum, toCents } from "@/lib/money";
import { recordBillPayment } from "./bill-payments";

/**
 * Paying many work orders at once (SPEC §6).
 *
 * Settling eighteen work orders one screen at a time is the same eighteen
 * decisions typed eighteen times. This makes it one screen — but not one
 * payment.
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
 */

/** How many consultants one run may pay. Past this, the run is two runs. */
export const MAX_BULK_PAYMENTS = 100;

export type BulkPayLine = {
  workOrderId: string;
  /** What to apply. Defaults to the whole balance on the planning screen. */
  amount: Prisma.Decimal.Value;
};

export type PlannedPayment = {
  vendorId: string;
  consultantName: string;
  currency: string;
  /** The work orders this consultant's payment settles. */
  lines: {
    workOrderId: string;
    number: string;
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

/** Work orders with something still owing, newest first. */
export async function payableWorkOrders(options: {
  companyId: string;
  consultantId?: string | null;
  from?: Date | null;
  to?: Date | null;
}) {
  return prisma.workOrder.findMany({
    where: {
      companyId: options.companyId,
      status: { in: ["APPROVED", "PARTIALLY_PAID"] },
      balanceDue: { gt: 0 },
      ...(options.consultantId ? { vendorId: options.consultantId } : {}),
      ...(options.from ? { issueDate: { gte: options.from } } : {}),
      ...(options.to ? { issueDate: { lte: options.to } } : {}),
    },
    include: { vendor: true },
    orderBy: [{ vendor: { name: "asc" } }, { issueDate: "asc" }],
    take: 500,
  });
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
  if (options.lines.length === 0) throw new PostingError("No work orders selected");

  const workOrders = await prisma.workOrder.findMany({
    where: {
      id: { in: options.lines.map((line) => line.workOrderId) },
      companyId: options.companyId,
    },
    include: { vendor: true },
    orderBy: [{ vendor: { name: "asc" } }, { issueDate: "asc" }],
  });
  if (workOrders.length === 0) throw new PostingError("No work orders selected");

  const amounts = new Map(options.lines.map((line) => [line.workOrderId, money(line.amount)]));

  const groups = new Map<string, typeof workOrders>();
  for (const workOrder of workOrders) {
    groups.set(workOrder.vendorId, [...(groups.get(workOrder.vendorId) ?? []), workOrder]);
  }

  const payments: PlannedPayment[] = [];
  for (const documents of groups.values()) {
    const vendor = documents[0].vendor;
    const lines = documents.map((workOrder) => ({
      workOrderId: workOrder.id,
      number: workOrder.workOrderNumber ?? "(unnumbered)",
      balanceDue: workOrder.balanceDue,
      amount: toCents(amounts.get(workOrder.id) ?? money(workOrder.balanceDue)),
    }));

    const currencies = [...new Set(documents.map((workOrder) => workOrder.currency))];
    const overpaid = lines.filter((line) => money(line.amount).greaterThan(money(line.balanceDue)));
    const nonPositive = lines.filter((line) => money(line.amount).lessThanOrEqualTo(0));

    // A payment names one currency, so a consultant holding work orders in two
    // cannot be settled in one. Said here rather than discovered on posting.
    const excludedReason =
      currencies.length > 1
        ? `${vendor.name} has work orders in ${currencies.join(" and ")}. Pay each currency separately.`
        : nonPositive.length > 0
          ? `${nonPositive[0].number} has no amount to pay.`
          : overpaid.length > 0
            ? `${overpaid[0].number} is only owed ${money(overpaid[0].balanceDue).toFixed(2)}.`
            : undefined;

    payments.push({
      vendorId: vendor.id,
      consultantName: vendor.name,
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
    throw new PostingError("None of the selected work orders can be paid — see the reasons listed");
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
        applications: payment.lines.map((line) => ({
          workOrderId: line.workOrderId,
          amountApplied: line.amount,
        })),
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
    action: "work_order.bulk_paid",
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
