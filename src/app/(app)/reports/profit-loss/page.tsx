import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { profitAndLoss } from "@/lib/reports/profit-loss";
import { periodPresets } from "@/lib/reports/periods";
import { fiscalYearStart, formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money, type Money } from "@/lib/money";
import { Card, DataTable, EmptyState, PageHeader } from "@/components/ui";
import { DateField, ReportControls } from "@/components/report-controls";

export const metadata = { title: pageTitle("Profit & Loss") };

/** One P&L line. Declared here so it is not re-created on every render. */
function Row({
  label,
  amount,
  priorAmount,
  href,
  bold,
  indent,
  currency,
  compare,
  percent,
}: {
  label: string;
  amount: Money;
  priorAmount?: Money | null;
  href?: string;
  bold?: boolean;
  indent?: boolean;
  currency: string;
  compare: boolean;
  percent: string;
}) {
  return (
    <tr className={bold ? "font-semibold" : ""}>
      <td className={`py-1.5 ${indent ? "pl-6" : ""}`}>
        {href ? (
          <Link className="underline decoration-dotted underline-offset-2" href={href}>
            {label}
          </Link>
        ) : (
          label
        )}
      </td>
      <td className="py-1.5 text-right tabular-nums">{formatMoney(amount.toFixed(2), currency)}</td>
      {compare ? (
        <td className="py-1.5 text-right tabular-nums text-slate-500">
          {priorAmount ? formatMoney(priorAmount.toFixed(2), currency) : ""}
        </td>
      ) : null}
      <td className="py-1.5 text-right text-xs text-slate-500">{percent}</td>
    </tr>
  );
}

export default async function ProfitLossPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; compare?: string }>;
}) {
  const scope = await sectionScope("REPORTS");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const to = parseAccountingDate(params.to ?? "") ?? today();
  const from = parseAccountingDate(params.from ?? "") ?? fiscalYearStart(to, company.fiscalYearStartMonth);
  const compare = params.compare === "1";

  // The prior period of the same length, for the optional comparison column.
  const spanMs = to.getTime() - from.getTime();
  const priorTo = new Date(from.getTime() - 86_400_000);
  const priorFrom = new Date(priorTo.getTime() - spanMs);

  const [current, prior] = await Promise.all([
    profitAndLoss({ companyId: scope.companyId, from, to }),
    compare ? profitAndLoss({ companyId: scope.companyId, from: priorFrom, to: priorTo }) : null,
  ]);

  const query = `from=${formatAccountingDate(from)}&to=${formatAccountingDate(to)}`;
  const drill = (accountId: string) =>
    `/reports/account/${accountId}?from=${formatAccountingDate(from)}&to=${formatAccountingDate(to)}`;

  const priorFor = (accountId: string): Money =>
    prior?.sections.flatMap((section) => section.rows).find((row) => row.accountId === accountId)
      ?.amount ?? money(0);

  const percentOfIncome = (amount: Money) =>
    current.income.isZero() ? "" : `${amount.dividedBy(current.income).times(100).toFixed(1)}%`;

  return (
    <>
      <PageHeader
        title="Profit & Loss"
        description={`${company.name} · ${formatAccountingDate(from)} to ${formatAccountingDate(
          to,
        )} · accrual basis · ${company.baseCurrency}`}
      />

      <ReportControls
        presets={periodPresets(company.fiscalYearStartMonth, "/reports/profit-loss")}
        csvHref={`/reports/profit-loss/csv?${query}`}
        pdfHref={`/reports/profit-loss/pdf?${query}`}
      >
        <DateField label="From" name="from" value={formatAccountingDate(from)} />
        <DateField label="To" name="to" value={formatAccountingDate(to)} />
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="compare" value="1" defaultChecked={compare} />
          Compare with prior period
        </label>
      </ReportControls>

      {current.sections.every((section) => section.rows.length === 0) ? (
        <EmptyState title="Nothing posted in this period" />
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Account</th>
                <th className="py-2 text-right">
                  {formatAccountingDate(from)} – {formatAccountingDate(to)}
                </th>
                {compare ? (
                  <th className="py-2 text-right">
                    {formatAccountingDate(priorFrom)} – {formatAccountingDate(priorTo)}
                  </th>
                ) : null}
                <th className="py-2 text-right">% of income</th>
              </tr>
            </thead>
            <tbody>
              {current.sections.map((section) =>
                section.rows.length === 0 ? null : (
                  <>
                    <tr key={section.key} className="border-t border-slate-100 dark:border-slate-800/60">
                      <td className="pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {section.label}
                      </td>
                      <td colSpan={compare ? 3 : 2} />
                    </tr>
                    {section.rows.map((row) => (
                      <Row
                        key={row.accountId}
                        label={`${row.code} ${row.name}`}
                        amount={row.amount}
                        priorAmount={priorFor(row.accountId)}
                        href={drill(row.accountId)}
                        indent
                        currency={company.baseCurrency}
                        compare={compare}
                        percent={percentOfIncome(row.amount)}
                      />
                    ))}
                    <tr className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-1.5 font-medium">Total {section.label.toLowerCase()}</td>
                      <td className="py-1.5 text-right font-medium tabular-nums">
                        {formatMoney(section.total.toFixed(2), company.baseCurrency)}
                      </td>
                      {compare ? (
                        <td className="py-1.5 text-right tabular-nums text-slate-500">
                          {formatMoney(
                            (prior?.sections.find((s) => s.key === section.key)?.total ?? money(0)).toFixed(2),
                            company.baseCurrency,
                          )}
                        </td>
                      ) : null}
                      <td />
                    </tr>
                  </>
                ),
              )}

              <tr className="border-t-2 border-slate-300 dark:border-slate-700">
                <td className="pt-3 font-semibold">Gross profit</td>
                <td className="pt-3 text-right font-semibold tabular-nums">
                  {formatMoney(current.grossProfit.toFixed(2), company.baseCurrency)}
                </td>
                {compare ? (
                  <td className="pt-3 text-right tabular-nums text-slate-500">
                    {formatMoney((prior?.grossProfit ?? money(0)).toFixed(2), company.baseCurrency)}
                  </td>
                ) : null}
                <td className="pt-3 text-right text-xs text-slate-500">
                  {percentOfIncome(current.grossProfit)}
                </td>
              </tr>
              <Row
                label="Net income"
                amount={current.netIncome}
                priorAmount={prior?.netIncome}
                bold
                currency={company.baseCurrency}
                compare={compare}
                percent={percentOfIncome(current.netIncome)}
              />
            </tbody>
          </DataTable>
        </Card>
      )}
    </>
  );
}
