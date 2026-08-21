import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { balancesByAccount } from "@/lib/reports/balances";
import { fiscalYearStart, formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { TYPE_ORDER } from "@/lib/ledger/accounts";
import { Card, DataTable, PageHeader } from "@/components/ui";
import { DateField, ReportControls } from "@/components/report-controls";
import { periodPresets } from "@/lib/reports/periods";

export const metadata = { title: "General Ledger — Ledger" };

/** The index into account detail: pick an account, see every line (SPEC §12.4). */
export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const scope = await sectionScope("REPORTS");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const to = parseAccountingDate(params.to ?? "") ?? today();
  const from = parseAccountingDate(params.from ?? "") ?? fiscalYearStart(to, company.fiscalYearStartMonth);

  const rows = await balancesByAccount({ companyId: scope.companyId, from, to });
  const active = rows.filter((row) => !row.debit.isZero() || !row.credit.isZero());

  return (
    <>
      <PageHeader
        title="General Ledger"
        description={`${company.name} · ${formatAccountingDate(from)} to ${formatAccountingDate(to)}`}
      />
      <ReportControls presets={periodPresets(company.fiscalYearStartMonth, "/reports/general-ledger")}>
        <DateField label="From" name="from" value={formatAccountingDate(from)} />
        <DateField label="To" name="to" value={formatAccountingDate(to)} />
      </ReportControls>

      <Card>
        {TYPE_ORDER.map((type) => {
          const typeRows = active.filter((row) => row.type === type);
          if (typeRows.length === 0) return null;
          return (
            <section key={type} className="mb-5 last:mb-0">
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {type.toLowerCase()}
              </h2>
              <DataTable>
                <tbody>
                  {typeRows.map((row) => (
                    <tr key={row.accountId} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="w-16 py-1.5 font-mono text-xs text-slate-500">{row.code}</td>
                      <td className="py-1.5">
                        <Link
                          className="underline decoration-dotted underline-offset-2"
                          href={`/reports/account/${row.accountId}?from=${formatAccountingDate(
                            from,
                          )}&to=${formatAccountingDate(to)}`}
                        >
                          {row.name}
                        </Link>
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-500">
                        {formatMoney(row.debit.toFixed(2), company.baseCurrency)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-500">
                        {formatMoney(row.credit.toFixed(2), company.baseCurrency)}
                      </td>
                      <td className="py-1.5 text-right font-medium tabular-nums">
                        {formatMoney(row.amount.toFixed(2), company.baseCurrency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </section>
          );
        })}
      </Card>
    </>
  );
}
