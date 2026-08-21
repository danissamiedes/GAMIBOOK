import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { balanceSheet } from "@/lib/reports/balance-sheet";
import { asOfPresets } from "@/lib/reports/periods";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import type { Money } from "@/lib/money";
import { Alert, Card, PageHeader } from "@/components/ui";
import { DateField, ReportControls } from "@/components/report-controls";

export const metadata = { title: "Balance Sheet — Ledger" };

type GroupRow = { accountId: string; code: string; name: string; amount: Money };

/** One labelled block of balance-sheet lines. Declared here, not in render. */
function Group({
  label,
  rows,
  total,
  currency,
  hrefFor,
}: {
  label: string;
  rows: GroupRow[];
  total: Money;
  currency: string;
  hrefFor: (accountId: string) => string;
}) {
  if (rows.length === 0) return null;
  const amount = (value: Money) => formatMoney(value.toFixed(2), currency);
  return (
    <>
      <tr>
        <td className="pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {label}
        </td>
        <td />
      </tr>
      {rows.map((row) => (
        <tr key={row.accountId}>
          <td className="py-1.5 pl-6">
            <Link className="underline decoration-dotted underline-offset-2" href={hrefFor(row.accountId)}>
              {row.code} {row.name}
            </Link>
          </td>
          <td className="py-1.5 text-right tabular-nums">{amount(row.amount)}</td>
        </tr>
      ))}
      <tr className="border-b border-slate-100 dark:border-slate-800/60">
        <td className="py-1.5 font-medium">Total {label.toLowerCase()}</td>
        <td className="py-1.5 text-right font-medium tabular-nums">{amount(total)}</td>
      </tr>
    </>
  );
}

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const scope = await sectionScope("REPORTS");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const asOf = parseAccountingDate(params.asOf ?? "") ?? today();
  const report = await balanceSheet({ companyId: scope.companyId, asOf });

  const drill = (accountId: string) =>
    `/reports/account/${accountId}?to=${formatAccountingDate(asOf)}`;

  const amount = (value: Money) => formatMoney(value.toFixed(2), company.baseCurrency);

  return (
    <>
      <PageHeader
        title="Balance Sheet"
        description={`${company.name} · as at ${formatAccountingDate(asOf)} · ${company.baseCurrency}`}
      />

      <ReportControls
        presets={asOfPresets(company.fiscalYearStartMonth, "/reports/balance-sheet")}
        csvHref={`/reports/balance-sheet/csv?asOf=${formatAccountingDate(asOf)}`}
      >
        <DateField label="As of" name="asOf" value={formatAccountingDate(asOf)} />
      </ReportControls>

      {!report.balanced ? (
        <Alert tone="error">
          <strong>This balance sheet does not balance.</strong> Assets{" "}
          {report.assets.total.toFixed(2)} against liabilities and equity{" "}
          {report.liabilitiesAndEquity.toFixed(2)} — a difference of{" "}
          {report.difference.toFixed(2)}. Something has written to the ledger outside the posting
          service. Do not rely on any report until this is resolved.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-sm font-semibold">Assets</h2>
          <table className="w-full text-sm">
            <tbody>
              <Group label="Current assets" rows={report.assets.current.rows} total={report.assets.current.total} currency={company.baseCurrency} hrefFor={drill} />
              <Group label="Fixed assets" rows={report.assets.fixed.rows} total={report.assets.fixed.total} currency={company.baseCurrency} hrefFor={drill} />
              <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                <td className="pt-2">Total assets</td>
                <td className="pt-2 text-right tabular-nums">{amount(report.assets.total)}</td>
              </tr>
            </tbody>
          </table>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold">Liabilities and equity</h2>
          <table className="w-full text-sm">
            <tbody>
              <Group
                label="Current liabilities"
                rows={report.liabilities.current.rows}
                total={report.liabilities.current.total}
                currency={company.baseCurrency}
                hrefFor={drill}
              />
              <Group
                label="Long-term liabilities"
                rows={report.liabilities.longTerm.rows}
                total={report.liabilities.longTerm.total}
                currency={company.baseCurrency}
                hrefFor={drill}
              />
              <tr className="border-b border-slate-200 font-medium dark:border-slate-800">
                <td className="py-1.5">Total liabilities</td>
                <td className="py-1.5 text-right tabular-nums">{amount(report.liabilities.total)}</td>
              </tr>

              <tr>
                <td className="pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Equity
                </td>
                <td />
              </tr>
              {report.equity.accounts.map((row) => (
                <tr key={row.accountId}>
                  <td className="py-1.5 pl-6">
                    <Link className="underline decoration-dotted underline-offset-2" href={drill(row.accountId)}>
                      {row.code} {row.name}
                    </Link>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{amount(row.amount)}</td>
                </tr>
              ))}
              <tr>
                <td className="py-1.5 pl-6">Opening balance equity</td>
                <td className="py-1.5 text-right tabular-nums">
                  {amount(report.equity.openingBalanceEquity)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 pl-6">
                  Retained earnings
                  <span className="block text-xs text-slate-500">
                    {report.equity.retainedEarningsPosted.isZero()
                      ? "Prior years' profit, computed from the ledger"
                      : `${report.equity.retainedEarningsPosted.toFixed(2)} posted + ${report.equity.priorYearEarnings.toFixed(
                          2,
                        )} prior years`}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{amount(report.equity.retainedEarnings)}</td>
              </tr>
              <tr>
                <td className="py-1.5 pl-6">
                  Net income
                  <span className="block text-xs text-slate-500">
                    since {formatAccountingDate(report.fiscalYearStart)}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{amount(report.equity.netIncome)}</td>
              </tr>
              <tr className="border-b border-slate-200 font-medium dark:border-slate-800">
                <td className="py-1.5">Total equity</td>
                <td className="py-1.5 text-right tabular-nums">{amount(report.equity.total)}</td>
              </tr>

              <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                <td className="pt-2">Total liabilities and equity</td>
                <td className="pt-2 text-right tabular-nums">{amount(report.liabilitiesAndEquity)}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>

      {report.balanced ? (
        <p className="mt-4 text-xs text-slate-500">
          Assets equal liabilities and equity to the cent. Net income is measured from{" "}
          {formatAccountingDate(report.fiscalYearStart)}, the start of the fiscal year containing
          this date; everything earned before then sits in retained earnings.
        </p>
      ) : null}
    </>
  );
}
