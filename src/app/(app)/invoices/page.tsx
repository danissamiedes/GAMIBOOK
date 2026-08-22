import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { formatAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money } from "@/lib/money";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { pageHref, pageSummary, readPage } from "@/lib/pagination";

export const metadata = { title: pageTitle("Invoices") };

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  ISSUED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  PARTIALLY_PAID:
    "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  PAID: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  VOID: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const params = await searchParams;
  const { status } = params;
  const page = readPage(params);

  const invoiceWhere = {
    ...scope.where,
    ...(status && status !== "ALL"
      ? {
          status: status as
            | "DRAFT"
            | "ISSUED"
            | "PARTIALLY_PAID"
            | "PAID"
            | "VOID",
        }
      : {}),
  };

  const invoices = await prisma.invoice.findMany({
    where: invoiceWhere,
    include: { customer: { select: { name: true } } },
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    skip: page.skip,
    take: page.take,
  });

  const total = await prisma.invoice.count({ where: invoiceWhere });
  const summary = pageSummary(page, total, "invoice");

  // Whether the screen is empty because there is nothing, or because the
  // filter excluded everything. Telling someone with 400 invoices that they
  // have none is worse than saying nothing.
  const filtering = Boolean(status && status !== "ALL");
  // Only asked when it can change the answer: the screen is empty and a filter
  // is on.
  const hiddenByFilter =
    invoices.length === 0 &&
    filtering &&
    (await prisma.invoice.count({ where: scope.where })) > 0;

  const now = today();

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageHeader title="Invoices" />
        <Link href="/invoices/new">
          <Button>New invoice</Button>
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {["ALL", "DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID"].map(
          (value) => (
            <Link key={value} href={`/invoices?status=${value}`}>
              <Button
                variant={(status ?? "ALL") === value ? "primary" : "secondary"}
              >
                {value.replace("_", " ").toLowerCase()}
              </Button>
            </Link>
          ),
        )}
      </div>

      {invoices.length === 0 ? (
        hiddenByFilter ? (
          <EmptyState
            title={`No ${(status ?? "").replace("_", " ").toLowerCase()} invoices`}
            action={{ href: "/invoices", label: "Show all invoices" }}
          >
            Other invoices exist — this filter just excludes them.
          </EmptyState>
        ) : (
          <EmptyState
            title="No invoices yet"
            action={{ href: "/invoices/new", label: "New invoice" }}
          >
            An invoice needs a customer and at least one line. Issuing it — not
            emailing it — is what posts it to the ledger and allocates its
            number.
          </EmptyState>
        )
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Number</th>
                <th className="py-2">Customer</th>
                <th className="py-2">Issued</th>
                <th className="py-2">Due</th>
                <th className="py-2">Status</th>
                <th className="py-2 text-right">Total</th>
                <th className="py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => {
                const overdue =
                  invoice.dueDate < now &&
                  money(invoice.balanceDue).greaterThan(0) &&
                  ["ISSUED", "PARTIALLY_PAID"].includes(invoice.status);
                return (
                  <tr
                    key={invoice.id}
                    className="border-b border-slate-100 dark:border-slate-800/60"
                  >
                    <td className="py-2 font-mono text-xs">
                      <Link
                        className="underline"
                        href={`/invoices/${invoice.id}`}
                      >
                        {invoice.invoiceNumber ?? "draft"}
                      </Link>
                    </td>
                    <td className="py-2">{invoice.customer.name}</td>
                    <td className="py-2">
                      {formatAccountingDate(invoice.issueDate)}
                    </td>
                    <td
                      className={`py-2 ${overdue ? "text-red-600 dark:text-red-400" : ""}`}
                    >
                      {formatAccountingDate(invoice.dueDate)}
                      {overdue ? " · overdue" : ""}
                    </td>
                    <td className="py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                          STATUS_STYLES[invoice.status]
                        }`}
                      >
                        {invoice.status.replace("_", " ").toLowerCase()}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(
                        money(invoice.total).toFixed(2),
                        invoice.currency,
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(
                        money(invoice.balanceDue).toFixed(2),
                        invoice.currency,
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          <Pagination
            summary={summary}
            previousHref={pageHref("/invoices", params, page.page - 1)}
            nextHref={pageHref("/invoices", params, page.page + 1)}
          />
        </Card>
      )}
    </>
  );
}
