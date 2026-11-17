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
  /**
   * Exactly these documents, whatever the other filters and however many
   * there are. The screen browses a capped list; a selection made from it is
   * then read back by name, which is not the same question (SPEC §6).
   */
  only?: { kind: PayableKind; id: string }[] | null;
};

/** How many of each kind the browsing list shows before it is cut short. */
export const BROWSE_LIMIT = 500;

/**
 * Everything owed to a consultant that is still open, oldest first.
 *
 * Both kinds in one list, sorted as a person reads a payment run: by whom,
 * then by how long it has been waiting.
 *
 * The cap is on browsing, not on paying. `only` lifts it, because a document
 * somebody has ticked has to be found whether or not it was in the first five
 * hundred — and until it was asked for by id, a selection made under a filter
 * could vanish when the unfiltered list was read back.
 */
export async function payableConsultantDocuments(options: Filter): Promise<PayableDocument[]> {
  const billIds = options.only
    ? options.only.filter((entry) => entry.kind === "bill").map((entry) => entry.id)
    : null;
  const workOrderIds = options.only
    ? options.only.filter((entry) => entry.kind === "workOrder").map((entry) => entry.id)
    : null;

  const [bills, workOrders] = await Promise.all([
    billIds && billIds.length === 0
      ? []
      : prisma.expense.findMany({
          where: {
            companyId: options.companyId,
            kind: "BILL",
            vendor: { kind: "CONSULTANT" },
            status: { in: ["APPROVED", "PARTIALLY_PAID"] },
            balanceDue: { gt: 0 },
            ...(billIds ? { id: { in: billIds } } : {}),
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
          // Oldest first, and by id after that: a cap that cuts an arbitrary
          // five hundred is a cap that cuts a different five hundred on the
          // next page load.
          orderBy: [{ date: "asc" }, { id: "asc" }],
          ...(billIds ? {} : { take: BROWSE_LIMIT }),
        }),
    workOrderIds && workOrderIds.length === 0
      ? []
      : prisma.workOrder.findMany({
          where: {
            companyId: options.companyId,
            // Only the ones that are payables in their own right. Everything
            // raised since is owed through the bill it became, and would
            // otherwise be offered for payment twice (SPEC §8.1b).
            postedOnApproval: true,
            status: { in: ["APPROVED", "PARTIALLY_PAID"] },
            balanceDue: { gt: 0 },
            ...(workOrderIds ? { id: { in: workOrderIds } } : {}),
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
          orderBy: [{ issueDate: "asc" }, { id: "asc" }],
          ...(workOrderIds ? {} : { take: BROWSE_LIMIT }),
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
  const documents = await payableConsultantDocuments({
    companyId: options.companyId,
    only: options.lines.map((line) => ({ kind: line.kind, id: line.documentId })),
  });

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
  /** Consultants in this run still waiting to be paid when the call handed back. */
  remaining: number;
  /** True when nothing is left: the caller can stop asking. */
  done: boolean;
};

/**
 * How many consultants one request posts before handing back.
 *
 * A payment is a transaction of its own — read the bills, write the payment,
 * post the journal, update each balance — and on a managed database every one
 * of those is a round trip. Sixty consultants is comfortably more than the
 * sixty seconds a serverless function gets, and what the reader saw when it
 * ran out was the app's own "something went wrong".
 */
export const RUN_CHUNK = 20;

/**
 * Stop posting with time in hand rather than being killed mid-run. The
 * reasoning, and the number, are the import's: nothing is lost either way,
 * because each payment is its own transaction and its run is stamped on it,
 * but being killed costs a round trip and shows the reader a fault.
 */
export const RUN_BUDGET_MS = 45_000;

/**
 * Record the run: one payment per consultant, each on its own.
 *
 * Deliberately not one transaction over the whole run. Eighteen postings in one
 * transaction means the eighteenth failing silently unwinds the seventeen that
 * were right, and a payment run half-recorded is easier to finish than one that
 * vanished. So each consultant stands alone and the failures are named.
 *
 * For the same reason it is not one *request* either. The caller keeps calling
 * until `done`, and each call picks up where the last stopped. Two things make
 * that safe to repeat. A bill that has been settled is no longer outstanding,
 * so it drops out of the plan on its own; and where it has only been
 * part-settled — paying less than the balance leaves it on the list — the
 * payments already made under this `runId` name their consultants, who are
 * skipped. Without a `runId` there is no second call to be safe about: the
 * whole run happens at once, as it did before.
 */
export async function recordBulkPay(options: {
  companyId: string;
  lines: BulkPayLine[];
  date: Date;
  paymentAccountId: string;
  reference?: string | null;
  userId?: string | null;
  role?: Role | null;
  /** Identifies one run across its chunks, and keeps a resumed one honest. */
  runId?: string | null;
  /** Consultants to pay in this call. Defaults to all of them. */
  limit?: number;
  /** Hand back after this long, whatever is left. */
  budgetMs?: number;
}): Promise<BulkPayResult> {
  const startedAt = Date.now();
  const plan = await planBulkPay({ companyId: options.companyId, lines: options.lines });

  // Consultants this run has already paid. A chunk that was interrupted after
  // posting but before answering would otherwise be repeated by the retry.
  const alreadyPaid = options.runId
    ? new Set(
        (
          await prisma.billPayment.findMany({
            where: { companyId: options.companyId, bulkRunId: options.runId },
            select: { vendorId: true },
          })
        ).map((payment) => payment.vendorId),
      )
    : new Set<string>();

  const outstanding = plan.payable.filter((payment) => !alreadyPaid.has(payment.vendorId));

  if (plan.payable.length === 0 && alreadyPaid.size === 0) {
    throw new PostingError("None of the selected documents can be paid — see the reasons listed");
  }
  if (plan.payable.length > MAX_BULK_PAYMENTS) {
    throw new PostingError(
      `That is ${plan.payable.length} consultants in one run; the limit is ${MAX_BULK_PAYMENTS}. Narrow the selection.`,
    );
  }

  const paid: BulkPayResult["paid"] = [];
  const failed: BulkPayResult["failed"] = [];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const budgetMs = options.budgetMs ?? Number.POSITIVE_INFINITY;
  let attempted = 0;

  for (const payment of outstanding) {
    // Always post at least one, so a budget too small for a single payment
    // cannot leave the caller looping over a run that never advances.
    if (attempted > 0 && (attempted >= limit || Date.now() - startedAt >= budgetMs)) break;
    attempted++;
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
        bulkRunId: options.runId ?? null,
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

  // Each chunk writes its own entry rather than one at the end of the run:
  // an audit trail that only appears once the last chunk lands is no use for
  // working out what a run that stopped halfway actually did. The run id ties
  // them back together.
  if (paid.length > 0 || failed.length > 0) {
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
        runId: options.runId ?? null,
      },
    });
  }

  // What is left for the next call: the consultants this one did not reach.
  // Those it tried are not among them, paid or refused alike — the caller
  // drops a refused consultant from the next chunk, because retrying a
  // refusal at the head of every chunk would spend the run failing the same
  // way, which is the import's reasoning for its own refused rows.
  const remaining = Math.max(0, outstanding.length - attempted);

  return {
    paid,
    failed,
    skipped: plan.excluded,
    remaining,
    done: remaining === 0,
  };
}
