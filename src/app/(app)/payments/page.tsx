import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import {
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { pageHref, pageSummary, readPage } from "@/lib/pagination";

export const metadata = { title: pageTitle("Customer payments") };

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const scope = await sectionScope("SALES");

  const params = await searchParams;
  const page = readPage(params);
  const total = await prisma.payment.count({ where: scope.where });
  const summary = pageSummary(page, total, "payment");

  const payments = await prisma.payment.findMany({
    where: scope.where,
    include: {
      customer: { select: { name: true } },
      applications: {
        include: { invoice: { select: { id: true, invoiceNumber: true } } },
      },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    skip: page.skip,
    take: page.take,
  });

  return (
    <>
      <PageHeader
        title="Customer payments"
        description="Money in. Reversal deletes nothing."
      />
      {payments.length === 0 ? (
        <EmptyState
          title="No payments recorded yet"
          action={{ href: "/invoices", label: "Go to invoices" }}
        >
          Record one from an open invoice.
        </EmptyState>
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Date</th>
                <th className="py-2">Customer</th>
                <th className="py-2">Applied to</th>
                <th className="py-2">Method</th>
                <th className="py-2 text-right">Amount</th>
                <th className="py-2 text-right">Unapplied</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => {
                const applied = sum(
                  payment.applications.map((application) =>
                    money(application.amountApplied),
                  ),
                );
                const unapplied = money(payment.amount).minus(applied);
                return (
                  <tr
                    key={payment.id}
                    className="border-b border-slate-100 dark:border-slate-800/60"
                  >
                    <td className="py-2">
                      {formatAccountingDate(payment.date)}
                    </td>
                    <td className="py-2">
                      {payment.customer.name}
                      {payment.reversedAt ? (
                        <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-800 dark:bg-red-950 dark:text-red-200">
                          reversed
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2">
                      {payment.applications.length === 0
                        ? "—"
                        : payment.applications.map((application, index) => (
                            <span key={application.id}>
                              {index > 0 ? ", " : ""}
                              <Link
                                className="underline"
                                href={`/invoices/${application.invoice.id}`}
                              >
                                {application.invoice.invoiceNumber ?? "draft"}
                              </Link>
                            </span>
                          ))}
                    </td>
                    <td className="py-2 text-slate-500">
                      {payment.method.replace("_", " ").toLowerCase()}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(payment.amount.toFixed(2), payment.currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {unapplied.isZero()
                        ? "—"
                        : formatMoney(unapplied.toFixed(2), payment.currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          <Pagination
            summary={summary}
            previousHref={pageHref("/payments", params, page.page - 1)}
            nextHref={pageHref("/payments", params, page.page + 1)}
          />
        </Card>
      )}
    </>
  );
}
