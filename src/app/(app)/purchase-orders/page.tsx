import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { pageHref, pageSummary, readPage } from "@/lib/pagination";
import { FilterSelect } from "@/components/filter-select";

export const metadata = { title: pageTitle("Purchase orders") };

/** The states an order moves through, in order. */
const STATUS_OPTIONS = [
  { value: "ALL", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "ISSUED", label: "Issued" },
  { value: "RECEIVED", label: "Received" },
  { value: "CANCELLED", label: "Cancelled" },
];

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  ISSUED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  RECEIVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  CANCELLED: "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

/**
 * What has been ordered from vendors (SPEC §8.1a).
 *
 * The mirror of the work orders list, with one difference worth keeping in
 * mind while reading it: none of these rows is in the ledger. The money
 * column is what was ordered, not what is owed.
 */
export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    vendor?: string;
    page?: string;
    saved?: string;
    deleted?: string;
    error?: string;
  }>;
}) {
  const scope = await sectionScope("VENDORS");
  const params = await searchParams;

  const status = STATUS_OPTIONS.some((option) => option.value === params.status)
    ? params.status!
    : "ALL";
  const where = {
    ...scope.where,
    ...(status === "ALL" ? {} : { status: status as "DRAFT" | "ISSUED" | "RECEIVED" | "CANCELLED" }),
    ...(params.vendor && params.vendor !== "ALL" ? { vendorId: params.vendor } : {}),
  };

  const page = readPage(params);
  const [company, vendors, total, orders] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { baseCurrency: true },
    }),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "REGULAR" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.purchaseOrder.count({ where }),
    prisma.purchaseOrder.findMany({
      where,
      include: { vendor: { select: { name: true } }, expense: { select: { id: true } } },
      orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
      skip: page.skip,
      take: page.take,
    }),
  ]);
  const summary = pageSummary(page, total, "purchase order");

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Purchase orders"
          description="What has been ordered from vendors. An order posts nothing — the bill does, when the goods arrive."
        />
        <div className="flex flex-wrap gap-2">
          <Link href="/purchase-orders/send">
            <Button variant="secondary">Send</Button>
          </Link>
          <Link href="/purchase-orders/export">
            <Button variant="secondary">Export to Excel</Button>
          </Link>
          <Link href="/purchase-orders/import">
            <Button variant="secondary">Import</Button>
          </Link>
          <Link href="/purchase-orders/new">
            <Button>New purchase order</Button>
          </Link>
        </div>
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? <Alert tone="success">Saved.</Alert> : null}
      {params.deleted ? <Alert tone="success">Draft deleted.</Alert> : null}

      <Card className="mb-4">
        <form className="flex flex-wrap items-end gap-3">
          <FilterSelect name="status" label="Status" value={status} options={STATUS_OPTIONS} />
          <FilterSelect
            name="vendor"
            label="Vendor"
            value={params.vendor ?? "ALL"}
            options={[
              { value: "ALL", label: "All vendors" },
              ...vendors.map((vendor) => ({ value: vendor.id, label: vendor.name })),
            ]}
          />
          <Button type="submit">Apply</Button>
          <Link href="/purchase-orders">
            <Button type="button" variant="ghost">
              Reset
            </Button>
          </Link>
        </form>
      </Card>

      {orders.length === 0 ? (
        <EmptyState title="No purchase orders yet">
          A purchase order says what you want from a vendor, and can be emailed to them. When the
          goods arrive, it makes the bill in one click.
        </EmptyState>
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Number</th>
                <th className="py-2">Date</th>
                <th className="py-2">Vendor</th>
                <th className="py-2">Wanted by</th>
                <th className="py-2 pr-4 text-right">Total</th>
                <th className="py-2">Status</th>
                <th className="py-2">Sent</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2 font-mono text-xs">
                    <Link href={`/purchase-orders/${order.id}`} className="underline">
                      {order.orderNumber ?? "draft"}
                    </Link>
                  </td>
                  <td className="py-2">{formatAccountingDate(order.orderDate)}</td>
                  <td className="py-2">{order.vendor.name}</td>
                  <td className="py-2 text-slate-500">
                    {order.expectedDate ? formatAccountingDate(order.expectedDate) : "—"}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatMoney(order.total.toFixed(2), order.currency)}
                    {order.currency !== company.baseCurrency ? (
                      <span className="block text-xs text-slate-500">at {order.fxRate.toString()}</span>
                    ) : null}
                  </td>
                  <td className="py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_STYLES[order.status] ?? ""
                      }`}
                    >
                      {order.status.toLowerCase()}
                    </span>
                  </td>
                  <td className="py-2 text-xs text-slate-500">
                    {order.lastEmailedAt ? formatAccountingDate(order.lastEmailedAt) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          <Pagination
            summary={summary}
            previousHref={pageHref("/purchase-orders", params, page.page - 1)}
            nextHref={pageHref("/purchase-orders", params, page.page + 1)}
          />
        </Card>
      )}
    </>
  );
}
