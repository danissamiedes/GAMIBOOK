import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import {
  profitAndLossByMonth,
  type Series,
} from "@/lib/reports/profit-loss-by-month";
import { periodPresets } from "@/lib/reports/periods";
import { fiscalYearStart, formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { DateField, ReportControls } from "@/components/report-controls";

export const metadata = { title: pageTitle("Profit & Loss by month") };

/**
 * One line across the months, then the period total.
 *
 * Declared at module scope so it is not rebuilt on every render, and so the
 * three kinds of line — account, section total, summary — cannot drift apart
 * in how they lay out their columns.
 */
function Row({
  label,
  series,
  href,
  bold,
  indent,
  currency,
  rule,
}: {
  label: string;
  series: Series;
  href?: string;
  bold?: boolean;
  indent?: boolean;
  currency: string;
  rule?: boolean;
}) {
  return (
    <tr
      className={`${bold ? "font-semibold" : ""} ${
        rule ? "border-t border-slate-200 dark:border-slate-700" : ""
      }`}
    >
      <th
        scope="row"
        className={`sticky left-0 z-10 bg-white py-1.5 text-left font-normal dark:bg-slate-950 ${
          indent ? "pl-6" : ""
        } ${bold ? "font-semibold" : ""}`}
      >
        {href ? (
          <Link className="underline decoration-dotted underline-offset-2" href={href}>
            {label}
          </Link>
        ) : (
          label
        )}
      </th>
      {series.months.map((amount, index) => (
        <td key={index} className="whitespace-nowrap py-1.5 pl-6 text-right tabular-nums">
          {formatMoney(amount.toFixed(2), currency)}
        </td>
      ))}
      <td className="whitespace-nowrap border-l border-slate-200 py-1.5 pl-6 text-right font-semibold tabular-nums dark:border-slate-700">
        {formatMoney(series.total.toFixed(2), currency)}
      </td>
    </tr>
  );
}

/**
 * Profit & Loss by month (SPEC §12.1).
 *
 * The same report as Profit & Loss, one column per month with the period total
 * on the right. Twelve columns do not fit a phone and will not be made to, so
 * the table scrolls sideways inside its card with the account column pinned —
 * a figure whose row you cannot see is not a figure.
 */
export default async function ProfitLossMonthlyPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const scope = await sectionScope("REPORTS");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const to = parseAccountingDate(params.to ?? "") ?? today();
  const from =
    parseAccountingDate(params.from ?? "") ?? fiscalYearStart(to, company.fiscalYearStartMonth);

  const report = await profitAndLossByMonth({ companyId: scope.companyId, from, to });

  const query = `from=${isoDate(from)}&to=${isoDate(to)}`;
  const drill = (accountId: string) => `/reports/account/${accountId}?${query}`;

  const empty = report.sections.every((section) => section.rows.length === 0);

  return (
    <>
      <PageHeader
        title="Profit & Loss by month"
        description={`${company.name} · ${formatAccountingDate(from)} to ${formatAccountingDate(
          to,
        )} · accrual basis · ${company.baseCurrency}`}
      />

      <ReportControls
        presets={periodPresets(company.fiscalYearStartMonth, "/reports/profit-loss-monthly")}
        csvHref={`/reports/profit-loss-monthly/csv?${query}`}
      >
        <DateField label="From" name="from" value={isoDate(from)} />
        <DateField label="To" name="to" value={isoDate(to)} />
      </ReportControls>

      {empty ? (
        <EmptyState title="Nothing posted in this period" />
      ) : (
        <Card>
          {/* Wide by nature: one column per month. Scrolls here rather than
              letting the page scroll sideways. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th scope="col" className="sticky left-0 z-10 bg-white py-2 dark:bg-slate-950">
                    Account
                  </th>
                  {report.months.map((month) => (
                    <th
                      key={month.from.toISOString()}
                      scope="col"
                      className="whitespace-nowrap py-2 pl-6 text-right"
                    >
                      {month.label}
                    </th>
                  ))}
                  <th
                    scope="col"
                    className="whitespace-nowrap border-l border-slate-200 py-2 pl-6 text-right dark:border-slate-700"
                  >
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.sections.map((section) =>
                  section.rows.length === 0 ? null : (
                    <>
                      <tr
                        key={section.key}
                        className="border-t border-slate-100 dark:border-slate-800/60"
                      >
                        <th
                          scope="colgroup"
                          className="sticky left-0 z-10 bg-white pb-1 pt-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-950"
                        >
                          {section.label}
                        </th>
                        <td colSpan={report.months.length + 1} />
                      </tr>
                      {section.rows.map((row) => (
                        <Row
                          key={row.accountId}
                          label={`${row.code} ${row.name}`}
                          series={row}
                          href={drill(row.accountId)}
                          indent
                          currency={company.baseCurrency}
                        />
                      ))}
                      <Row
                        key={`${section.key}-total`}
                        label={`Total ${section.label.toLowerCase()}`}
                        series={section}
                        currency={company.baseCurrency}
                        bold
                      />
                    </>
                  ),
                )}

                <Row
                  label="Gross profit"
                  series={report.grossProfit}
                  currency={company.baseCurrency}
                  bold
                  rule
                />
                <Row
                  label="Operating income"
                  series={report.operatingIncome}
                  currency={company.baseCurrency}
                  bold
                />
                <Row
                  label="Net income"
                  series={report.netIncome}
                  currency={company.baseCurrency}
                  bold
                  rule
                />
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
