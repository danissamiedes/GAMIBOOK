import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { pageHref, pageSummary, readPage } from "@/lib/pagination";

export const metadata = { title: "Sales orders — Ledger" };

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  CONFIRMED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  INVOICED:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  CANCELLED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

export default async function SalesOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const scope = await sectionScope("SALES");

  const params = await searchParams;
  const page = readPage(params);
  const total = await prisma.salesOrder.count({ where: scope.where });
  const summary = pageSummary(page, total, "order");

  const orders = await prisma.salesOrder.findMany({
    where: scope.where,
    include: {
      customer: { select: { name: true } },
      invoice: { select: { id: true, invoiceNumber: true } },
    },
    orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
    skip: page.skip,
    take: page.take,
  });

  const agreed = orders
    .filter((order) => order.status === "CONFIRMED")
    .reduce((total, order) => total + Number(order.total), 0);

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageHeader
          title="Sales orders"
          description="What customers have agreed to buy. Nothing here posts to the ledger — invoicing does that."
        />
        <Link href="/sales-orders/new">
          <Button>New sales order</Button>
        </Link>
      </div>

      {orders.length === 0 ? (
        <EmptyState title="No sales orders yet">
          Use one when work is agreed but not yet billable.
        </EmptyState>
      ) : (
        <>
          <Card className="mb-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Confirmed and not yet invoiced
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {agreed.toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Deliberately absent from the P&amp;L — this is agreed work, not
              revenue.
            </p>
          </Card>

          <Card>
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Number</th>
                  <th className="py-2">Customer</th>
                  <th className="py-2">Date</th>
                  <th className="py-2">Status</th>
                  <th className="py-2">Invoice</th>
                  <th className="py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr
                    key={order.id}
                    className="border-b border-slate-100 dark:border-slate-800/60"
                  >
                    <td className="py-2 font-mono text-xs">
                      <Link
                        className="underline"
                        href={`/sales-orders/${order.id}`}
                      >
                        {order.orderNumber ?? "draft"}
                      </Link>
                    </td>
                    <td className="py-2">{order.customer.name}</td>
                    <td className="py-2">
                      {formatAccountingDate(order.orderDate)}
                    </td>
                    <td className="py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                          STATUS_STYLES[order.status]
                        }`}
                      >
                        {order.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="py-2 text-xs">
                      {order.invoice ? (
                        <Link
                          className="underline"
                          href={`/invoices/${order.invoice.id}`}
                        >
                          {order.invoice.invoiceNumber ?? "draft"}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(order.total.toFixed(2), order.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            <Pagination
              summary={summary}
              previousHref={pageHref("/sales-orders", params, page.page - 1)}
              nextHref={pageHref("/sales-orders", params, page.page + 1)}
            />
          </Card>
        </>
      )}
    </>
  );
}
