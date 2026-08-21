import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { arAging, agingBucketLabels, bucketValues } from "@/lib/invoices/aging";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
} from "@/components/ui";

export const metadata = { title: "A/R Aging — Ledger" };

export default async function ArAgingPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const params = await searchParams;

  const asOf = parseAccountingDate(params.asOf ?? "") ?? today();
  const [company, report] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    arAging({ companyId: scope.companyId, asOf }),
  ]);

  const labels = agingBucketLabels();

  return (
    <>
      <PageHeader
        title="A/R Aging"
        description={`${company.name} · as at ${formatAccountingDate(asOf)} · ${company.baseCurrency}`}
      />

      <Card className="mb-4 print:hidden">
        <form className="flex flex-wrap items-end gap-3">
          <Field label="As of">
            <Input type="date" name="asOf" defaultValue={formatAccountingDate(asOf)} />
          </Field>
          <Button type="submit">Update</Button>
          <a href={`/reports/ar-aging/csv?asOf=${formatAccountingDate(asOf)}`}>
            <Button variant="secondary" type="button">
              Export CSV
            </Button>
          </a>
        </form>
      </Card>

      {!report.tiesToLedger ? (
        <Alert tone="error">
          This aging totals {report.totals.total.toFixed(2)} but the A/R control account holds{" "}
          {report.controlBalance.toFixed(2)}. The two must agree — investigate before relying on
          either figure. A credit on account from an over-payment will show as a difference here.
        </Alert>
      ) : null}

      {report.rows.length === 0 ? (
        <EmptyState title="Nothing outstanding">
          {/* True whether every invoice is settled or none was ever raised —
              claiming the first when the books are empty would be a lie. */}
          No invoice has a balance as at this date. If you expected one, check the date above.
        </EmptyState>
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Customer</th>
                {labels.map((label) => (
                  <th key={label} className="py-2 text-right">
                    {label}
                  </th>
                ))}
                <th className="py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.customerId} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2">
                    {row.customerName}
                    <div className="text-xs text-slate-500">
                      {row.invoices.map((invoice, index) => (
                        <span key={invoice.id}>
                          {index > 0 ? " · " : ""}
                          <Link className="underline" href={`/invoices/${invoice.id}`}>
                            {invoice.invoiceNumber}
                          </Link>
                          {invoice.daysOverdue > 0 ? ` (${invoice.daysOverdue}d)` : ""}
                        </span>
                      ))}
                    </div>
                  </td>
                  {bucketValues(row).map((value, index) => (
                    <td key={index} className="py-2 text-right tabular-nums">
                      {value.isZero() ? "" : value.toFixed(2)}
                    </td>
                  ))}
                  <td className="py-2 text-right font-medium tabular-nums">
                    {formatMoney(row.total.toFixed(2), company.baseCurrency)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                <td className="py-2">Total</td>
                {bucketValues(report.totals).map((value, index) => (
                  <td key={index} className="py-2 text-right tabular-nums">
                    {value.toFixed(2)}
                  </td>
                ))}
                <td className="py-2 text-right tabular-nums">
                  {formatMoney(report.totals.total.toFixed(2), company.baseCurrency)}
                </td>
              </tr>
            </tfoot>
          </DataTable>
        </Card>
      )}
    </>
  );
}
