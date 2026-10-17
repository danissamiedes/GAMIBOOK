import type { PayableStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { accountingDate } from "@/lib/ledger/post";
import { money, type Money } from "@/lib/money";

/**
 * Everything this party has been billed and paid (SPEC §6).
 *
 * A vendor record on its own answers "what are their terms"; the question
 * anybody actually opens a vendor to ask is "what have we had from them and
 * what do we still owe". That lives in three tables — bills and direct
 * expenses, work orders, and payments — and nowhere together, which is why
 * this exists.
 *
 * Documents, not postings. The general ledger already shows the postings; a
 * list of debits and credits is not what somebody looking up DAVAO LIGHT
 * wants to read.
 */
export type PartyTransactionKind = "BILL" | "EXPENSE" | "WORK_ORDER" | "PAYMENT";

export type PartyTransaction = {
  id: string;
  date: Date;
  kind: PartyTransactionKind;
  /** What to call it on screen. */
  label: string;
  reference: string | null;
  description: string;
  /** The document's own currency and amount. */
  currency: string;
  amount: Money;
  /** The same amount in the company's base currency. */
  baseAmount: Money;
  /** What is still owed on it, in base currency. Null for a payment. */
  outstanding: Money | null;
  status: string;
  /** Where the document itself can be read. */
  href: string;
};

export type PartyTotals = {
  /** Everything billed or spent, in base currency. */
  spend: Money;
  /** Paid: payments applied, plus expenses that were paid when recorded. */
  paid: Money;
  /** Still owed on open bills and work orders. */
  outstanding: Money;
};

/** The most rows one tab shows. Older history is in the reports. */
export const PARTY_TRANSACTION_LIMIT = 200;

/**
 * How many documents the transactions tab would show.
 *
 * Three counts rather than three fetches, because the details tab needs the
 * number on the tab and nothing else, and a vendor page that reads every bill
 * to put a digit in a label is a page that got slower for no one.
 */
export async function partyTransactionCount(companyId: string, vendorId: string): Promise<number> {
  const where = { companyId, vendorId };
  const [expenses, workOrders, payments] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.workOrder.count({ where }),
    prisma.billPayment.count({ where }),
  ]);
  return expenses + workOrders + payments;
}

export async function partyTransactions(options: {
  companyId: string;
  vendorId: string;
  /** Inclusive, both ends. Omitted means everything on file. */
  from?: Date | null;
  to?: Date | null;
}): Promise<{ rows: PartyTransaction[]; totals: PartyTotals; truncated: boolean }> {
  // A period bounds the documents and therefore the totals with them: the
  // three figures at the top of the tab must be the three figures the rows
  // below add up to, or one of them is a lie.
  const period =
    options.from || options.to
      ? {
          ...(options.from ? { gte: accountingDate(options.from) } : {}),
          ...(options.to ? { lte: accountingDate(options.to) } : {}),
        }
      : undefined;
  const where = { companyId: options.companyId, vendorId: options.vendorId };

  const [expenses, workOrders, payments] = await Promise.all([
    prisma.expense.findMany({
      where: { ...where, ...(period ? { date: period } : {}) },
      orderBy: { date: "desc" },
      take: PARTY_TRANSACTION_LIMIT,
      select: {
        id: true,
        date: true,
        kind: true,
        currency: true,
        amount: true,
        baseTotal: true,
        baseRelieved: true,
        description: true,
        reference: true,
        status: true,
        voidedAt: true,
      },
    }),
    prisma.workOrder.findMany({
      where: { ...where, ...(period ? { issueDate: period } : {}) },
      orderBy: { issueDate: "desc" },
      take: PARTY_TRANSACTION_LIMIT,
      select: {
        id: true,
        issueDate: true,
        workOrderNumber: true,
        memo: true,
        currency: true,
        total: true,
        baseTotal: true,
        baseRelieved: true,
        status: true,
        voidedAt: true,
      },
    }),
    prisma.billPayment.findMany({
      where: { ...where, ...(period ? { date: period } : {}) },
      orderBy: { date: "desc" },
      take: PARTY_TRANSACTION_LIMIT,
      select: {
        id: true,
        date: true,
        amount: true,
        currency: true,
        fxRate: true,
        reference: true,
        method: true,
        notes: true,
        reversedAt: true,
        applications: { select: { amountApplied: true } },
      },
    }),
  ]);

  const rows: PartyTransaction[] = [];
  let spend = money(0);
  let paid = money(0);
  let outstanding = money(0);

  for (const expense of expenses) {
    const bill = expense.kind === "BILL";
    const base = money(expense.baseTotal);
    const open = base.minus(money(expense.baseRelieved));
    const live = !expense.voidedAt && expense.status !== "VOID";

    if (live) {
      spend = spend.plus(base);
      if (bill) outstanding = outstanding.plus(open);
      // A direct expense was paid out of an account the moment it was
      // recorded; no payment document will ever appear for it.
      else paid = paid.plus(base);
    }

    rows.push({
      id: expense.id,
      date: expense.date,
      kind: bill ? "BILL" : "EXPENSE",
      label: bill ? "Bill" : "Direct expense",
      reference: expense.reference,
      description: expense.description,
      currency: expense.currency,
      amount: money(expense.amount),
      baseAmount: base,
      outstanding: bill && live ? open : null,
      status: statusLabel(expense.status, expense.voidedAt),
      // The document's own page, not the list it happens to be on: a
      // reference that lands somebody in a list has not opened anything.
      href: `/expenses/${expense.id}`,
    });
  }

  for (const order of workOrders) {
    const base = money(order.baseTotal);
    const open = base.minus(money(order.baseRelieved));
    const live = !order.voidedAt && order.status !== "VOID";
    // A draft is a proposal, not a liability, and nothing has posted for it.
    const counted = live && order.status !== "DRAFT";

    if (counted) {
      spend = spend.plus(base);
      outstanding = outstanding.plus(open);
    }

    rows.push({
      id: order.id,
      date: order.issueDate,
      kind: "WORK_ORDER",
      label: "Work order",
      reference: order.workOrderNumber,
      description: order.memo ?? "",
      currency: order.currency,
      amount: money(order.total),
      baseAmount: base,
      outstanding: counted ? open : null,
      status: statusLabel(order.status, order.voidedAt),
      href: `/work-orders/${order.id}`,
    });
  }

  for (const payment of payments) {
    const base = money(payment.amount).times(money(payment.fxRate));
    if (!payment.reversedAt) paid = paid.plus(base);

    rows.push({
      id: payment.id,
      date: payment.date,
      kind: "PAYMENT",
      label: "Payment",
      reference: payment.reference,
      description:
        payment.notes ??
        `${payment.method.toLowerCase().replace(/_/g, " ")} · ${payment.applications.length} document${
          payment.applications.length === 1 ? "" : "s"
        }`,
      currency: payment.currency,
      amount: money(payment.amount),
      baseAmount: base,
      outstanding: null,
      status: payment.reversedAt ? "Reversed" : "Paid",
      href: `/bill-payments/${payment.id}/edit`,
    });
  }

  // One list in date order, because that is how somebody reads an account:
  // the bill, then what was paid against it.
  rows.sort((a, b) => b.date.getTime() - a.date.getTime() || a.label.localeCompare(b.label));

  const truncated = rows.length > PARTY_TRANSACTION_LIMIT;
  return {
    rows: truncated ? rows.slice(0, PARTY_TRANSACTION_LIMIT) : rows,
    totals: { spend, paid, outstanding },
    truncated,
  };
}

function statusLabel(status: PayableStatus, voidedAt: Date | null): string {
  if (voidedAt) return "Void";
  return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
}
