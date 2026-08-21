import Link from "next/link";
import type { VendorKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { companyScope } from "@/lib/session-scope";
import { apAging, apBucketValues } from "@/lib/payables/aging";
import { agingBucketLabels } from "@/lib/invoices/aging";
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

export const metadata = { title: "A/P Aging — Ledger" };

/**
 * A/P aging (SPEC §12.6). Which kinds a viewer may see is decided by their
 * sections, not by a dropdown: a VENDORS-only user gets the regular-vendor
 * rows and cannot widen the filter (SPEC §2.1).
 */
export default async function ApAgingPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; kind?: string }>;
}) {
  const scope = await companyScope();
  scope.requireRole("OWNER", "BOOKKEEPER");

  const seesConsultants = scope.hasSection("CONSULTANTS");
  const seesVendors = scope.hasSection("VENDORS");
  if (!seesConsultants && !seesVendors) {
    const { redirect } = await import("next/navigation");
    redirect("/no-access?section=VENDORS");
  }

  const params = await searchParams;
  const asOf = parseAccountingDate(params.asOf ?? "") ?? today();

  // A viewer who holds only one side is pinned to it, whatever the URL says.
  const requested = params.kind === "CONSULTANT" || params.kind === "REGULAR" ? params.kind : null;
  const kind: VendorKind | null = !seesConsultants
    ? "REGULAR"
    : !seesVendors
      ? "CONSULTANT"
      : (requested as VendorKind | null);

  const [company, report] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    apAging({ companyId: scope.companyId, asOf, kind }),
  ]);

  const labels = agingBucketLabels();
  const canSwitch = seesConsultants && seesVendors;

  return (
    <>
      <PageHeader
        title="A/P Aging"
        description={`${company.name} · as at ${formatAccountingDate(asOf)} · ${
          kind === "CONSULTANT" ? "consultants" : kind === "REGULAR" ? "regular vendors" : "all payables"
        } · ${company.baseCurrency}`}
      />

      <Card className="mb-4 print:hidden">
        <form className="flex flex-wrap items-end gap-3">
          <Field label="As of">
            <Input type="date" name="asOf" defaultValue={formatAccountingDate(asOf)} />
          </Field>
          {canSwitch ? <input type="hidden" name="kind" value={kind ?? ""} /> : null}
          <Button type="submit">Update</Button>
        </form>
        {canSwitch ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              { value: "", label: "All payables" },
              { value: "CONSULTANT", label: "Consultants" },
              { value: "REGULAR", label: "Regular vendors" },
            ].map((option) => (
              <Link
                key={option.label}
                href={`/reports/ap-aging?asOf=${formatAccountingDate(asOf)}${
                  option.value ? `&kind=${option.value}` : ""
                }`}
              >
                <Button variant={(kind ?? "") === option.value ? "primary" : "secondary"}>
                  {option.label}
                </Button>
              </Link>
            ))}
          </div>
        ) : null}
      </Card>

      {report.tiesToLedger === false ? (
        <Alert tone="error">
          This aging totals {report.totals.total.toFixed(2)} but the A/P control account holds{" "}
          {report.controlBalance.toFixed(2)}. Investigate before relying on either figure.
        </Alert>
      ) : null}
      {report.tiesToLedger === null ? (
        <Alert tone="info">
          Showing one kind of payable, so this total is a subset of the A/P control account
          ({report.controlBalance.toFixed(2)} {company.baseCurrency} in total).
        </Alert>
      ) : null}

      {report.rows.length === 0 ? (
        <EmptyState title="Nothing outstanding" />
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Vendor</th>
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
                <tr key={row.vendorId} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2">
                    {row.vendorName}
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">
                      {row.kind === "CONSULTANT" ? "consultant" : "vendor"}
                    </span>
                    <div className="text-xs text-slate-500">
                      {row.documents.map((document, index) => (
                        <span key={document.id}>
                          {index > 0 ? " · " : ""}
                          {document.type === "workOrder" ? (
                            <Link className="underline" href={`/work-orders/${document.id}`}>
                              {document.label}
                            </Link>
                          ) : (
                            document.label
                          )}
                          {document.daysOverdue > 0 ? ` (${document.daysOverdue}d)` : ""}
                        </span>
                      ))}
                    </div>
                  </td>
                  {apBucketValues(row).map((value, index) => (
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
                {apBucketValues(report.totals).map((value, index) => (
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
