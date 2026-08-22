import Link from "next/link";
import { failTo } from "@/lib/fail";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import {
  cancelSalesOrder,
  confirmSalesOrder,
  convertToInvoice,
  deleteDraftSalesOrder,
} from "@/lib/invoices/sales-orders";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { PostingError } from "@/lib/errors";
import { Alert, Button, Card, DataTable, Field, Input, PageHeader } from "@/components/ui";

export default async function SalesOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const { id } = await params;
  const { error } = await searchParams;

  const order = await prisma.salesOrder.findFirst({
    where: { id, ...scope.where },
    include: {
      customer: true,
      lines: { orderBy: { lineNumber: "asc" } },
      invoice: { select: { id: true, invoiceNumber: true, status: true } },
    },
  });
  if (!order) notFound();

  async function confirm() {
    "use server";
    const inner = await sectionScope("SALES");
    try {
      const confirmed = await confirmSalesOrder({ companyId: inner.companyId, salesOrderId: id });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "sales_order.confirmed",
        entityType: "SalesOrder",
        entityId: id,
        summary: `Confirmed as ${confirmed.orderNumber}`,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/sales-orders/${id}`, thrown.message);
      else throw thrown;
    }
    redirect(`/sales-orders/${id}`);
  }

  async function invoice(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    let created;
    try {
      created = await convertToInvoice({
        companyId: inner.companyId,
        salesOrderId: id,
        issueDate: parseAccountingDate(String(formData.get("issueDate") || "")) ?? today(),
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "sales_order.invoiced",
        entityType: "SalesOrder",
        entityId: id,
        summary: `Converted to draft invoice ${created.id}`,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/sales-orders/${id}`, thrown.message);
      else throw thrown;
    }
    redirect(`/invoices/${created!.id}`);
  }

  async function cancel() {
    "use server";
    const inner = await sectionScope("SALES");
    try {
      await cancelSalesOrder({ companyId: inner.companyId, salesOrderId: id });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/sales-orders/${id}`, thrown.message);
      else throw thrown;
    }
    redirect(`/sales-orders/${id}`);
  }

  async function discard() {
    "use server";
    const inner = await sectionScope("SALES");
    try {
      await deleteDraftSalesOrder(inner.companyId, id);
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/sales-orders/${id}`, thrown.message);
      else throw thrown;
    }
    redirect("/sales-orders");
  }

  return (
    <>
      <PageHeader
        title={order.orderNumber ? `Sales order ${order.orderNumber}` : "Draft sales order"}
        description={`${order.customer.name} · ${formatAccountingDate(order.orderDate)} · ${order.status.toLowerCase()}`}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      <Alert tone="info">
        A sales order posts nothing. Revenue appears only when the invoice it becomes is issued.
      </Alert>

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Description</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Rate</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2">{line.description}</td>
                  <td className="py-2 text-right tabular-nums">{line.quantity.toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">{line.rate.toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(line.amount.toFixed(2), order.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td colSpan={3} className="py-2 text-right">
                  Total
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatMoney(order.total.toFixed(2), order.currency)}
                </td>
              </tr>
            </tfoot>
          </DataTable>

          {order.invoice ? (
            <p className="mt-4 text-sm">
              Invoiced as{" "}
              <Link className="underline" href={`/invoices/${order.invoice.id}`}>
                {order.invoice.invoiceNumber ?? "a draft invoice"}
              </Link>{" "}
              ({order.invoice.status.toLowerCase().replace("_", " ")}).
            </p>
          ) : null}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Actions</h2>
          <div className="space-y-3">
              {order.status === "DRAFT" || order.status === "CONFIRMED" ? (
                <Link
                  href={`/sales-orders/${order.id}/edit`}
                  className="mb-3 flex h-9 w-full items-center justify-center rounded-md border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Edit order
                </Link>
              ) : null}

            {order.status === "DRAFT" ? (
              <>
                <form action={confirm}>
                  <Button type="submit" className="w-full">
                    Confirm order
                  </Button>
                </form>
                <form action={discard}>
                  <Button type="submit" variant="secondary" className="w-full">
                    Discard draft
                  </Button>
                </form>
              </>
            ) : null}

            {order.status === "CONFIRMED" ? (
              <>
                <form action={invoice} className="space-y-2">
                  <Field label="Invoice date">
                    <Input type="date" name="issueDate" defaultValue={formatAccountingDate(today())} />
                  </Field>
                  <Button type="submit" className="w-full">
                    Convert to invoice
                  </Button>
                  <p className="text-xs text-slate-500">
                    Creates a draft invoice with these lines. Issuing it is what posts.
                  </p>
                </form>
                <form action={cancel}>
                  <Button type="submit" variant="danger" className="w-full">
                    Cancel order
                  </Button>
                </form>
              </>
            ) : null}

            {order.status === "INVOICED" ? (
              <p className="text-sm text-slate-500">This order has been invoiced.</p>
            ) : null}
            {order.status === "CANCELLED" ? (
              <p className="text-sm text-slate-500">This order was cancelled.</p>
            ) : null}
          </div>
        </Card>
      </div>
    </>
  );
}
