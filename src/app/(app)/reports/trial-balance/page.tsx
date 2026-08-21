import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { trialBalance } from "@/lib/ledger/reports";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader } from "@/components/ui";

export const metadata = { title: "Trial Balance — Ledger" };

/**
 * Trial Balance (SPEC §12.3). Built early because it is the first debugging
 * tool. Drill-down arrives in Phase 5 and applies to this report too; the rows
 * already carry the account id it needs.
 */
export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; asOf?: string; zero?: string }>;
}) {
  const scope = await sectionScope("REPORTS");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const asOf = parseAccountingDate(params.asOf ?? "") ?? today();
  const from = parseAccountingDate(params.from ?? "");
  const includeZeroRows = params.zero === "1";

  const report = await trialBalance({
    companyId: scope.companyId,
    asOf,
    from,
    includeZeroRows,
  });

  const csvHref = `/reports/trial-balance/csv?asOf=${formatAccountingDate(asOf)}${
    from ? `&from=${formatAccountingDate(from)}` : ""
  }${includeZeroRows ? "&zero=1" : ""}`;

  return (
    <>
      <PageHeader
        title="Trial Balance"
        description={`${company.name} · ${
          from ? `${formatAccountingDate(from)} to ` : "up to "
        }${formatAccountingDate(asOf)} · ${company.baseCurrency}`}
      />

      <Card className="mb-4 print:hidden">
        <form className="flex flex-wrap items-end gap-3">
          <Field label="From (optional)">
            <Input type="date" name="from" defaultValue={params.from ?? ""} />
          </Field>
          <Field label="As of">
            <Input type="date" name="asOf" defaultValue={formatAccountingDate(asOf)} />
          </Field>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input type="checkbox" name="zero" value="1" defaultChecked={includeZeroRows} />
            Show zero-balance accounts
          </label>
          <Button type="submit">Update</Button>
          <a href={csvHref}>
            <Button variant="secondary" type="button">
              Export CSV
            </Button>
          </a>
          <a href={csvHref.replace("/csv?", "/pdf?")} target="_blank" rel="noreferrer">
            <Button variant="secondary" type="button">
              Export PDF
            </Button>
          </a>
        </form>
      </Card>

      {!report.balanced ? (
        <Alert tone="error">
          This trial balance does not balance — debits {report.totalDebit.toFixed(2)} against
          credits {report.totalCredit.toFixed(2)}. Something has written to the ledger outside the
          posting service. Do not rely on any report until this is resolved.
        </Alert>
      ) : null}

      {report.rows.length === 0 ? (
        <EmptyState title="Nothing posted in this period" />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Code</th>
                <th className="py-2">Account</th>
                <th className="py-2 text-right">Debit</th>
                <th className="py-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.accountId} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-1.5 font-mono text-xs text-slate-500">{row.code}</td>
                  <td className="py-1.5">
                    <a
                      className="underline decoration-dotted underline-offset-2"
                      href={`/reports/account/${row.accountId}?${
                        from ? `from=${formatAccountingDate(from)}&` : ""
                      }to=${formatAccountingDate(asOf)}`}
                    >
                      {row.name}
                    </a>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {row.debit.isZero() ? "" : formatMoney(row.debit.toFixed(2), company.baseCurrency)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {row.credit.isZero()
                      ? ""
                      : formatMoney(row.credit.toFixed(2), company.baseCurrency)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                <td className="py-2" colSpan={2}>
                  Total
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatMoney(report.totalDebit.toFixed(2), company.baseCurrency)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatMoney(report.totalCredit.toFixed(2), company.baseCurrency)}
                </td>
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
    </>
  );
}
