import type { Prisma, PurchaseOrderStatus, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, sum, toCents } from "@/lib/money";
import { allocateNumber } from "@/lib/ledger/post";
import { recordExpense } from "./expenses";

/**
 * Purchase orders (SPEC §8.1a).
 *
 * The mirror of a sales order, and deliberately not of a work order. A work
 * order commits to a consultant's fee, so approving one lands in accounts
 * payable; ordering cement owes the supplier nothing until the cement turns
 * up. So **a purchase order posts nothing**: issuing it allocates a number
 * and makes it sendable, and the ledger only hears about it when the goods
 * arrive and the bill is made from it.
 *
 * That bill is an ordinary bill, recorded through `recordExpense` like any
 * other, with the order and the bill pointing at each other so the trail
 * reads both ways.
 */

export type PurchaseOrderLineInput = {
  itemId?: string | null;
  description: string;
  quantity: Prisma.Decimal.Value;
  rate: Prisma.Decimal.Value;
  expenseAccountId: string;
};

export function computePurchaseOrderLine(line: {
  quantity: Prisma.Decimal.Value;
  rate: Prisma.Decimal.Value;
}) {
  return toCents(money(line.quantity).times(money(line.rate)));
}

export async function recalculatePurchaseOrder(
  purchaseOrderId: string,
  tx: Prisma.TransactionClient,
) {
  const order = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    include: { lines: true },
  });
  return tx.purchaseOrder.update({
    where: { id: order.id },
    data: { total: sum(order.lines.map((line) => money(line.amount))) },
  });
}

/** DRAFT → ISSUED. Allocates the number, so it can be sent. Posts nothing. */
export async function issuePurchaseOrder(input: { companyId: string; purchaseOrderId: string }) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.purchaseOrder.findFirst({
      where: { id: input.purchaseOrderId, companyId: input.companyId },
      include: { lines: true },
    });
    if (!order) throw new PostingError("Purchase order not found in this company");
    if (order.status !== "DRAFT") throw new PostingError("Only a draft order can be issued");
    if (order.lines.length === 0) {
      throw new PostingError("A purchase order needs at least one line");
    }

    await recalculatePurchaseOrder(order.id, tx);
    const { formatted } = await allocateNumber(tx, input.companyId, "PURCHASE_ORDER");

    return tx.purchaseOrder.update({
      where: { id: order.id },
      data: { orderNumber: formatted, status: "ISSUED", issuedAt: new Date() },
    });
  });
}

/**
 * The goods arrived: make the bill (SPEC §8.1a).
 *
 * This is the moment the cost reaches the books, and it reaches them the
 * ordinary way — one bill against the vendor, through `recordExpense`, which
 * is what posts to A/P. The order keeps its own record and the two point at
 * each other.
 *
 * One line, not many: an expense carries a single account, and a purchase
 * order's lines may be coded to several. Where they all share one account the
 * bill is coded to it; where they do not, the bill asks for one. Splitting a
 * received order across several bills is a bigger feature than this.
 */
export async function receivePurchaseOrder(input: {
  companyId: string;
  purchaseOrderId: string;
  /** The bill's date — when the goods and the invoice arrived. */
  date: Date;
  dueDate?: Date | null;
  /** The vendor's own invoice number. Required, as on any expense. */
  reference: string;
  /** Needed only when the order's lines are coded to more than one account. */
  expenseAccountId?: string | null;
  userId?: string | null;
  role?: Role | null;
}) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: input.purchaseOrderId, companyId: input.companyId },
    include: { lines: { orderBy: { lineNumber: "asc" } }, vendor: true, expense: true },
  });
  if (!order) throw new PostingError("Purchase order not found in this company");
  if (order.status === "DRAFT") {
    throw new PostingError("Issue the order before receiving it");
  }
  if (order.status === "CANCELLED") {
    throw new PostingError("A cancelled order cannot be received");
  }
  if (order.status === "RECEIVED" || order.expense) {
    throw new PostingError("This order has already been received — its bill exists");
  }
  if (order.lines.length === 0) throw new PostingError("This order has no lines");

  const accounts = new Set(order.lines.map((line) => line.expenseAccountId));
  const accountId =
    input.expenseAccountId ?? (accounts.size === 1 ? order.lines[0].expenseAccountId : null);
  if (!accountId) {
    throw new PostingError(
      "This order is coded to more than one account — choose the one the bill should go to",
    );
  }

  const total = sum(order.lines.map((line) => money(line.amount)));
  if (total.lessThanOrEqualTo(0)) {
    throw new PostingError("A bill must be more than zero");
  }

  // Posted first, linked second: recordExpense opens its own transaction, and
  // a bill that posted while the link failed is recoverable — a link with no
  // posting behind it is not.
  const { expense } = await recordExpense({
    companyId: input.companyId,
    kind: "BILL",
    vendorId: order.vendorId,
    date: input.date,
    dueDate: input.dueDate ?? null,
    currency: order.currency,
    fxRate: order.fxRate,
    amount: total,
    expenseAccountId: accountId,
    description: order.memo?.trim() || `Purchase order ${order.orderNumber ?? ""}`.trim(),
    reference: input.reference,
    userId: input.userId,
    role: input.role,
  });

  await prisma.$transaction([
    prisma.expense.update({
      where: { id: expense.id },
      data: { purchaseOrderId: order.id },
    }),
    prisma.purchaseOrder.update({
      where: { id: order.id },
      data: { status: "RECEIVED", receivedAt: new Date() },
    }),
  ]);

  return prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
}

export async function cancelPurchaseOrder(input: { companyId: string; purchaseOrderId: string }) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: input.purchaseOrderId, companyId: input.companyId },
  });
  if (!order) throw new PostingError("Purchase order not found in this company");
  if (order.status === "RECEIVED") {
    throw new PostingError("This order has been received. Void its bill instead.");
  }
  if (order.status === "CANCELLED") throw new PostingError("This order is already cancelled");
  return prisma.purchaseOrder.update({
    where: { id: order.id },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
}

/**
 * Change what was ordered.
 *
 * Allowed after issuing, which an invoice would never permit — but an order
 * is a request, not a record of anything that happened, and vendors are
 * phoned up and asked for two more sheets of plywood all the time. Once it
 * has become a bill the bill is the record, and that is what gets corrected.
 */
export async function updatePurchaseOrder(input: {
  companyId: string;
  purchaseOrderId: string;
  vendorId?: string;
  orderDate?: Date;
  expectedDate?: Date | null;
  currency?: string;
  fxRate?: Prisma.Decimal.Value;
  shipTo?: string | null;
  memo?: string | null;
  lines: PurchaseOrderLineInput[];
}) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.purchaseOrder.findFirst({
      where: { id: input.purchaseOrderId, companyId: input.companyId },
    });
    if (!order) throw new PostingError("Purchase order not found in this company");
    if (order.status === "RECEIVED") {
      throw new PostingError("This order has become a bill. Edit the bill instead.");
    }
    if (order.status === "CANCELLED") {
      throw new PostingError("A cancelled order cannot be edited. Raise a new one instead.");
    }
    if (input.lines.length === 0) {
      throw new PostingError("A purchase order needs at least one line");
    }

    if (input.vendorId && input.vendorId !== order.vendorId) {
      const vendor = await tx.vendor.findFirst({
        where: { id: input.vendorId, companyId: input.companyId, kind: "REGULAR" },
      });
      if (!vendor) throw new PostingError("Vendor not found in this company");
    }

    await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: order.id } });
    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: {
        vendorId: input.vendorId ?? order.vendorId,
        orderDate: input.orderDate ?? order.orderDate,
        expectedDate: input.expectedDate === undefined ? order.expectedDate : input.expectedDate,
        currency: input.currency ? input.currency.toUpperCase() : order.currency,
        fxRate: input.fxRate ?? order.fxRate,
        shipTo: input.shipTo === undefined ? order.shipTo : input.shipTo,
        memo: input.memo === undefined ? order.memo : input.memo,
        lines: {
          create: input.lines.map((line, index) => ({
            lineNumber: index + 1,
            itemId: line.itemId ?? null,
            description: line.description,
            quantity: line.quantity,
            rate: line.rate,
            amount: computePurchaseOrderLine(line),
            expenseAccountId: line.expenseAccountId,
          })),
        },
      },
    });

    await recalculatePurchaseOrder(order.id, tx);
    return tx.purchaseOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: { orderBy: { lineNumber: "asc" } } },
    });
  });
}

/**
 * Why a purchase order cannot be deleted, or null if it can.
 *
 * Nothing posted, so none of the ledger's erase rules apply: what has to hold
 * is that nothing has been built on it. Once it is a bill, the bill is the
 * record and the order is its history.
 */
export function whyNotDeletablePurchaseOrder(order: {
  status: PurchaseOrderStatus;
  expense: { id: string } | null;
}): string | null {
  if (order.status === "RECEIVED" || order.expense) {
    return "This order has become a bill. Delete the bill first if it was a mistake.";
  }
  return null;
}

export async function deletePurchaseOrder(input: {
  companyId: string;
  purchaseOrderId: string;
}) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: input.purchaseOrderId, companyId: input.companyId },
    include: { expense: { select: { id: true } } },
  });
  if (!order) throw new PostingError("Purchase order not found in this company");
  const refusal = whyNotDeletablePurchaseOrder(order);
  if (refusal) throw new PostingError(refusal);

  // Lines go with it: they are part of the document, not records of their own.
  return prisma.purchaseOrder.delete({ where: { id: order.id } });
}
