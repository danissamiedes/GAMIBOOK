import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { accountDetail, sourceDocumentHref, sourceLabel } from "@/lib/reports/general-ledger";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { normalBalance } from "@/lib/ledger/accounts";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { DateField, ReportControls } from "@/components/report-controls";

/**
 * The drill-down target (SPEC §12): click any figure on any report and land
 * here, on the journal lines behind it — then click a line to open the document
 * that created it. This is what makes the numbers trustworthy rather than
 * merely plausible.
 */
export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const scope = await sectionScope("REPORTS");
  const { id } = await params;
  const query = await searchParams;

  const account = await prisma.account.findFirst({ where: { id, ...scope.where } });
  if (!account) notFound();

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const to = parseAccountingDate(query.to ?? "") ?? today();
  const from = parseAccountingDate(query.from ?? "");

  const detail = await accountDetail({
    companyId: scope.companyId,
    accountId: account.id,
    from,
    to,
  });

  const amount = (value: { toFixed: (n: number) => string }) =>
    formatMoney(value.toFixed(2), company.baseCurrency);

  return (
    <>
      <PageHeader
        title={`${account.code} ${account.name}`}
        description={`${account.type.toLowerCase()} · ${normalBalance(
          account.type,
        ).toLowerCase()}-normal · ${from ? `${formatAccountingDate(from)} to ` : "up to "}${formatAccountingDate(
          to,
        )}`}
      />

      <ReportControls
        presets={[
          { label: "Back to Trial Balance", href: "/reports/trial-balance" },
          { label: "Profit & Loss", href: "/reports/profit-loss" },
          { label: "Balance Sheet", href: "/reports/balance-sheet" },
        ]}
      >
        <DateField label="From" name="from" value={from ? formatAccountingDate(from) : ""} />
        <DateField label="To" name="to" value={formatAccountingDate(to)} />
      </ReportControls>

      {detail.rows.length === 0 ? (
        <EmptyState title="No postings to this account in the period" />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Date</th>
                <th className="py-2">Entry</th>
                <th className="py-2">Source</th>
                <th className="py-2">Description</th>
                <th className="py-2">Party</th>
                <th className="py-2 text-right">Debit</th>
                <th className="py-2 text-right">Credit</th>
                <th className="py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {from ? (
                <tr className="border-b border-slate-100 text-slate-500 dark:border-slate-800/60">
                  <td className="py-1.5" colSpan={7}>
                    Opening balance
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{amount(detail.opening)}</td>
                </tr>
              ) : null}
              {detail.rows.map((row) => {
                const href = sourceDocumentHref(row.sourceType, row.sourceId);
                return (
                  <tr key={row.lineId} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-1.5">{formatAccountingDate(row.date)}</td>
                    <td className="py-1.5 font-mono text-xs">
                      <Link className="underline" href={`/journal/${row.entryId}`}>
                        {row.entryNumber}
                      </Link>
                    </td>
                    <td className="py-1.5 text-xs text-slate-500">
                      {href ? (
                        <Link className="underline" href={href}>
                          {sourceLabel(row.sourceType)}
                        </Link>
                      ) : (
                        sourceLabel(row.sourceType)
                      )}
                    </td>
                    <td className="py-1.5">{row.description ?? row.memo ?? "—"}</td>
                    <td className="py-1.5 text-slate-500">{row.partyName ?? "—"}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {row.debit.isZero() ? "" : amount(row.debit)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {row.credit.isZero() ? "" : amount(row.credit)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{amount(row.runningBalance)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                <td className="py-2" colSpan={5}>
                  Closing balance
                </td>
                <td className="py-2 text-right tabular-nums">{amount(detail.totalDebit)}</td>
                <td className="py-2 text-right tabular-nums">{amount(detail.totalCredit)}</td>
                <td className="py-2 text-right tabular-nums">{amount(detail.closing)}</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
    </>
  );
}
