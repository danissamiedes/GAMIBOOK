import type { Prisma, SalesOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, sum, toCents } from "@/lib/money";
import { allocateNumber } from "@/lib/ledger/post";

/**
 * Sales orders (SPEC §7.1a).
 *
 * The whole point of this document is that it **posts nothing**. It records
 * what a customer has agreed to buy; revenue is recognised only when the
 * invoice it becomes is issued. Anything else books income for work that has
 * not been billed, which is exactly the kind of thing a real ledger exists to
 * prevent.
 */

export type SalesOrderLineInput = {
  itemId?: string | null;
  description: string;
  quantity: Prisma.Decimal.Value;
  rate: Prisma.Decimal.Value;
  incomeAccountId: string;
};

export function computeSalesOrderLine(line: {
  quantity: Prisma.Decimal.Value;
  rate: Prisma.Decimal.Value;
}) {
  return toCents(money(line.quantity).times(money(line.rate)));
}

export async function recalculateSalesOrder(salesOrderId: string, tx: Prisma.TransactionClient) {
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: salesOrderId },
    include: { lines: true },
  });
  return tx.salesOrder.update({
    where: { id: order.id },
    data: { total: sum(order.lines.map((line) => money(line.amount))) },
  });
}

/** DRAFT → CONFIRMED. Allocates the number. Still posts nothing. */
export async function confirmSalesOrder(input: { companyId: string; salesOrderId: string }) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.findFirst({
      where: { id: input.salesOrderId, companyId: input.companyId },
      include: { lines: true },
    });
    if (!order) throw new PostingError("Sales order not found in this company");
    if (order.status !== "DRAFT") throw new PostingError("Only a draft order can be confirmed");
    if (order.lines.length === 0) throw new PostingError("A sales order needs at least one line");

    await recalculateSalesOrder(order.id, tx);
    const { formatted } = await allocateNumber(tx, input.companyId, "SALES_ORDER");

    return tx.salesOrder.update({
      where: { id: order.id },
      data: { orderNumber: formatted, status: "CONFIRMED", confirmedAt: new Date() },
    });
  });
}

/**
 * Convert to a **draft** invoice, carrying the lines across and linking the
 * two. Issuing that invoice is what finally posts (SPEC §7.1). One order
 * becomes one invoice; partial invoicing is out of scope for the MVP.
 */
export async function convertToInvoice(input: {
  companyId: string;
  salesOrderId: string;
  issueDate: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.findFirst({
      where: { id: input.salesOrderId, companyId: input.companyId },
      include: { lines: { orderBy: { lineNumber: "asc" } }, customer: true },
    });
    if (!order) throw new PostingError("Sales order not found in this company");
    if (order.status === "INVOICED") throw new PostingError("This order has already been invoiced");
    if (order.status === "CANCELLED") throw new PostingError("A cancelled order cannot be invoiced");
    if (order.status === "DRAFT") throw new PostingError("Confirm the order before invoicing it");

    const invoice = await tx.invoice.create({
      data: {
        companyId: order.companyId,
        customerId: order.customerId,
        salesOrderId: order.id,
        issueDate: input.issueDate,
        dueDate: new Date(
          input.issueDate.getTime() + order.customer.paymentTermsDays * 86_400_000,
        ),
        currency: order.currency,
        fxRate: order.fxRate,
        memo: order.memo,
        terms: `Net ${order.customer.paymentTermsDays}`,
        lines: {
          create: order.lines.map((line) => ({
            lineNumber: line.lineNumber,
            itemId: line.itemId,
            description: line.description,
            quantity: line.quantity,
            rate: line.rate,
            amount: line.amount,
            incomeAccountId: line.incomeAccountId,
          })),
        },
      },
      include: { lines: true },
    });

    await tx.salesOrder.update({ where: { id: order.id }, data: { status: "INVOICED" } });

    return invoice;
  });
}

export async function cancelSalesOrder(input: { companyId: string; salesOrderId: string }) {
  const order = await prisma.salesOrder.findFirst({
    where: { id: input.salesOrderId, companyId: input.companyId },
  });
  if (!order) throw new PostingError("Sales order not found in this company");
  if (order.status === "INVOICED") {
    throw new PostingError("This order has been invoiced. Void the invoice instead.");
  }
  return prisma.salesOrder.update({
    where: { id: order.id },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
}

export async function deleteDraftSalesOrder(companyId: string, salesOrderId: string) {
  const order = await prisma.salesOrder.findFirst({ where: { id: salesOrderId, companyId } });
  if (!order) throw new PostingError("Sales order not found in this company");
  if (order.status !== "DRAFT") throw new PostingError("Only a draft order can be deleted");
  await prisma.salesOrder.delete({ where: { id: salesOrderId } });
}

/**
 * Edit a sales order (SPEC §7.1a).
 *
 * The one document here with no ledger consequences at all, in either state:
 * confirming allocates a number and posts nothing. So DRAFT and CONFIRMED are
 * both freely editable and there is no reverse-and-repost to do — the general
 * immutability rule in §4.2 has nothing to bite on.
 *
 * INVOICED is where it stops. By then the lines have been copied into an
 * invoice which may itself be issued and posted; changing the order underneath
 * it would leave two documents claiming to be the same agreement while saying
 * different things. Edit the invoice instead.
 */
export async function updateSalesOrder(input: {
  companyId: string;
  salesOrderId: string;
  customerId?: string;
  orderDate?: Date;
  expectedDate?: Date | null;
  currency?: string;
  fxRate?: Prisma.Decimal.Value;
  memo?: string | null;
  lines: SalesOrderLineInput[];
}) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.findFirst({
      where: { id: input.salesOrderId, companyId: input.companyId },
    });
    if (!order) throw new PostingError("Sales order not found in this company");
    if (order.status === "INVOICED") {
      throw new PostingError(
        "This order has been turned into an invoice. Edit the invoice instead.",
      );
    }
    if (order.status === "CANCELLED") {
      throw new PostingError("A cancelled order cannot be edited. Raise a new one instead.");
    }
    if (input.lines.length === 0) throw new PostingError("A sales order needs at least one line");

    if (input.customerId && input.customerId !== order.customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, companyId: input.companyId },
      });
      if (!customer) throw new PostingError("Customer not found in this company");
    }

    await tx.salesOrderLine.deleteMany({ where: { salesOrderId: order.id } });
    await tx.salesOrder.update({
      where: { id: order.id },
      data: {
        customerId: input.customerId ?? order.customerId,
        orderDate: input.orderDate ?? order.orderDate,
        expectedDate: input.expectedDate === undefined ? order.expectedDate : input.expectedDate,
        currency: input.currency ? input.currency.toUpperCase() : order.currency,
        fxRate: input.fxRate ?? order.fxRate,
        memo: input.memo === undefined ? order.memo : input.memo,
        lines: {
          create: input.lines.map((line, index) => ({
            lineNumber: index + 1,
            itemId: line.itemId ?? null,
            description: line.description,
            quantity: line.quantity,
            rate: line.rate,
            amount: computeSalesOrderLine(line),
            incomeAccountId: line.incomeAccountId,
          })),
        },
      },
    });

    await recalculateSalesOrder(order.id, tx);
    return tx.salesOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: { orderBy: { lineNumber: "asc" } } },
    });
  });
}

/**
 * Why a sales order cannot be deleted, or null if it can.
 *
 * The odd one out. A sales order posts nothing, so there is no journal entry
 * to erase, no period to be closed against it and no bank line that can point
 * at it — none of the rules in `erase.ts` apply. What has to hold is simply
 * that nothing has been built on it: once it has become an invoice, the
 * invoice is the record and the order is its history.
 */
export function whyNotDeletableSalesOrder(order: {
  status: SalesOrderStatus;
  invoice: { id: string } | null;
}): string | null {
  if (order.status === "INVOICED" || order.invoice) {
    return "This order has been invoiced. Delete the invoice first, or void it — the invoice is the accounting record, not the order.";
  }
  return null;
}

/**
 * Erase a sales order — draft, confirmed or cancelled alike — and its lines.
 *
 * Deliberately not gated on the 24-hour window the posted documents use. That
 * window exists because deleting a posting destroys accounting history; a
 * sales order has none to destroy. What it loses is the order number, and the
 * audit row keeps that.
 */
export async function deleteSalesOrder(input: {
  companyId: string;
  salesOrderId: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.findFirst({
      where: { id: input.salesOrderId, companyId: input.companyId },
      include: {
        lines: { orderBy: { lineNumber: "asc" } },
        invoice: { select: { id: true } },
        customer: { select: { name: true } },
      },
    });
    if (!order) throw new PostingError("Sales order not found in this company");

    const refusal = whyNotDeletableSalesOrder(order);
    if (refusal) throw new PostingError(refusal);

    const snapshot = {
      salesOrder: {
        id: order.id,
        orderNumber: order.orderNumber,
        customerId: order.customerId,
        customerName: order.customer.name,
        orderDate: order.orderDate.toISOString().slice(0, 10),
        expectedDate: order.expectedDate ? order.expectedDate.toISOString().slice(0, 10) : null,
        currency: order.currency,
        fxRate: money(order.fxRate).toString(),
        status: order.status,
        memo: order.memo,
        total: money(order.total).toFixed(2),
        createdAt: order.createdAt.toISOString(),
        lines: order.lines.map((line) => ({
          lineNumber: line.lineNumber,
          itemId: line.itemId,
          description: line.description,
          quantity: money(line.quantity).toString(),
          rate: money(line.rate).toString(),
          amount: money(line.amount).toFixed(2),
          incomeAccountId: line.incomeAccountId,
        })),
      },
    };

    // Lines cascade with the order.
    await tx.salesOrder.delete({ where: { id: order.id } });

    await tx.auditLog.create({
      data: {
        companyId: input.companyId,
        userId: input.userId,
        action: "salesOrder.deleted",
        entityType: "SalesOrder",
        entityId: order.id,
        summary: `Deleted sales order ${order.orderNumber ?? order.id} for ${money(
          order.total,
        ).toFixed(2)} ${order.currency} to ${order.customer.name}`,
        data: snapshot,
      },
    });

    return snapshot;
  });
}
