import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { salesByCustomer } from "@/lib/reports/sales-by-customer";
import { periodPresets } from "@/lib/reports/periods";
import { fiscalYearStart, formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { DateField, ReportControls } from "@/components/report-controls";

export const metadata = { title: "Sales by customer — Ledger" };

/** SPEC §12.8 — lives in the Sales section, not Reports. */
export default async function SalesByCustomerPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const to = parseAccountingDate(params.to ?? "") ?? today();
  const from =
    parseAccountingDate(params.from ?? "") ?? fiscalYearStart(to, company.fiscalYearStartMonth);

  const report = await salesByCustomer({ companyId: scope.companyId, from, to });

  return (
    <>
      <PageHeader
        title="Sales by customer"
        description={`${company.name} · ${formatAccountingDate(from)} to ${formatAccountingDate(
          to,
        )} · ${company.baseCurrency}`}
      />

      <ReportControls
        presets={periodPresets(company.fiscalYearStartMonth, "/reports/sales-by-customer")}
        csvHref={`/reports/sales-by-customer/csv?from=${formatAccountingDate(
          from,
        )}&to=${formatAccountingDate(to)}`}
      >
        <DateField label="From" name="from" value={formatAccountingDate(from)} />
        <DateField label="To" name="to" value={formatAccountingDate(to)} />
      </ReportControls>

      {report.rows.length === 0 ? (
        <EmptyState title="Nothing invoiced in this period" />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Customer</th>
                <th className="py-2 text-right">Invoices</th>
                <th className="py-2 text-right">Invoiced</th>
                <th className="py-2 text-right">Paid</th>
                <th className="py-2 text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.customerId} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2">
                    <Link className="underline decoration-dotted underline-offset-2" href="/customers">
                      {row.customerName}
                    </Link>
                    {row.currency !== company.baseCurrency ? (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">
                        invoiced in {row.currency}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 text-right tabular-nums">{row.invoiceCount}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(row.invoiced.toFixed(2), company.baseCurrency)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(row.paid.toFixed(2), company.baseCurrency)}
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums">
                    {formatMoney(row.outstanding.toFixed(2), company.baseCurrency)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                <td className="py-2">Total</td>
                <td className="py-2 text-right tabular-nums">{report.totals.invoiceCount}</td>
                <td className="py-2 text-right tabular-nums">
                  {formatMoney(report.totals.invoiced.toFixed(2), company.baseCurrency)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatMoney(report.totals.paid.toFixed(2), company.baseCurrency)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatMoney(report.totals.outstanding.toFixed(2), company.baseCurrency)}
                </td>
              </tr>
            </tfoot>
          </table>
          <p className="mt-3 text-xs text-slate-500">
            Draft and void invoices are excluded — neither is a sale. Foreign-currency invoices are
            converted at their own rate, the one they sit in the ledger at.
          </p>
        </Card>
      )}
    </>
  );
}
