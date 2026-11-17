import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { validateConsultantBillRows } from "@/lib/imports/consultant-bills";
import {
  consultantBillColumnFor,
  type ConsultantBillColumnKey,
} from "@/lib/imports/consultant-bill-columns";
import { discardBatch } from "@/lib/imports/work-orders";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate } from "@/lib/dates";
import { Alert, Button, Card, DataTable, PageHeader } from "@/components/ui";
import { CommitPanel } from "./commit-panel";

export const metadata = { title: pageTitle("Check import") };

/** How many rows the table shows before it stops being worth scrolling. */
const PREVIEW_ROWS = 60;

/**
 * What the sheet was understood to say, before anything is recorded
 * (SPEC §8.3).
 *
 * Re-validated on every view rather than read back from the staged rows: an
 * account may have been added, a consultant created, a mapping saved since
 * the upload, and the screen that decides whether to post five hundred bills
 * should show what is true now.
 *
 * The expense preview, less the "paid from" question — a bill is owed, not
 * paid — and plus the one this screen has instead: which of these names are
 * not consultants yet.
 */
export default async function ConsultantBillImportPreviewPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const { batchId } = await params;

  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, ...scope.where, kind: "CONSULTANT_BILL" },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) notFound();

  const [company, accounts] = await Promise.all([
    prisma.company.findUniqueOrThrow({
      where: { id: scope.companyId },
      select: { name: true, baseCurrency: true },
    }),
    prisma.account.findMany({
      where: { companyId: scope.companyId, isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, type: true, systemKey: true },
    }),
  ]);

  const validation = await validateConsultantBillRows({
    companyId: scope.companyId,
    rows: batch.rows.map((row) => ({
      rowNumber: row.rowNumber,
      raw: row.rawJson as Record<string, unknown>,
      values: rawToValues(row.rawJson as Record<string, unknown>),
    })),
  });

  // What the work is coded to. Assets are included because a consultant's
  // bill buys equipment as often as it buys hours.
  const codeable = accounts.filter(
    (account) => account.type === "EXPENSE" || account.type === "ASSET",
  );

  const duplicate = await prisma.importBatch.findFirst({
    where: {
      ...scope.where,
      kind: "CONSULTANT_BILL",
      fileHash: batch.fileHash,
      status: "COMMITTED",
      id: { not: batch.id },
    },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, uploadedAt: true, createdCount: true },
  });

  async function discard() {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    await discardBatch(inner.companyId, batchId);
    redirect("/consultant-bills/import");
  }

  const committed = batch.status === "COMMITTED";

  return (
    <>
      <PageHeader
        title={batch.fileName}
        description={`${batch.sheetName ?? "first sheet"} · ${batch.rowCount} rows · into ${company.name}`}
      />

      {duplicate ? (
        <Alert tone="warning">
          This exact file was already imported on {formatAccountingDate(duplicate.uploadedAt)} and
          recorded {duplicate.createdCount} bills. Importing it again records them twice.
        </Alert>
      ) : null}

      {committed ? (
        <Alert tone="success">
          Imported — {batch.createdCount} bills recorded
          {batch.skippedCount > 0 ? `, ${batch.skippedCount} rows left behind` : ""}.
        </Alert>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Ready</p>
          <p className="text-2xl font-bold tabular-nums">{validation.mappableCount}</p>
          {validation.mappableCount > validation.validCount ? (
            <p className="mt-0.5 text-xs text-slate-500">once the questions below are answered</p>
          ) : null}
        </Card>
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">With problems</p>
          <p className="text-2xl font-bold tabular-nums">{validation.errorCount}</p>
        </Card>
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">New consultants</p>
          <p className="text-2xl font-bold tabular-nums">{validation.newConsultants.length}</p>
        </Card>
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total payable</p>
          <p className="text-2xl font-bold tabular-nums">
            {formatMoney(validation.total.toFixed(2), company.baseCurrency)}
          </p>
        </Card>
      </div>

      {!committed ? (
        <Card className="mb-6">
          <CommitPanel
            batchId={batch.id}
            categories={validation.categories.map((entry) => ({
              category: entry.category,
              rowCount: entry.rowCount,
              accountId: entry.accountId,
            }))}
            accounts={codeable.map((account) => ({
              id: account.id,
              code: account.code,
              name: account.name,
            }))}
            newConsultants={validation.newConsultants}
            importableCount={validation.mappableCount}
            errorCount={validation.errorCount}
            currency={company.baseCurrency}
            total={validation.total.toFixed(2)}
          />
        </Card>
      ) : null}

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">
            The rows{validation.rows.length > PREVIEW_ROWS ? ` — first ${PREVIEW_ROWS}` : ""}
          </h2>
          <div className="flex gap-3 text-sm">
            {validation.errorCount > 0 ? (
              <Link href={`/consultant-bills/import/${batch.id}/rejects`} className="underline">
                Download the {validation.errorCount} problem rows
              </Link>
            ) : null}
            {!committed ? (
              <form action={discard}>
                <Button type="submit" variant="ghost">
                  Discard this batch
                </Button>
              </form>
            ) : null}
          </div>
        </div>

        <DataTable>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="pb-2">Row</th>
              <th className="pb-2">Billed</th>
              <th className="pb-2">Due</th>
              <th className="pb-2">Consultant</th>
              <th className="pb-2">Description</th>
              <th className="pb-2 text-right">Amount</th>
              <th className="pb-2">Category → account</th>
            </tr>
          </thead>
          <tbody>
            {validation.rows.slice(0, PREVIEW_ROWS).map((row) => {
              const errors = row.issues.filter((issue) => issue.severity === "error");
              // A category nobody has mapped and a name nobody has agreed to
              // create are questions, not faults: the row only reads as
              // broken when answering them will not save it.
              const broken = errors.some(
                (issue) =>
                  issue.code !== "unmappedAccount" && issue.code !== "unknownConsultant",
              );
              const warnings = row.issues.filter((issue) => issue.severity === "warning");
              return (
                <tr
                  key={row.rowNumber}
                  className={`border-b border-slate-100 align-top dark:border-slate-800/60 ${
                    broken ? "bg-red-50/60 dark:bg-red-950/20" : ""
                  }`}
                >
                  <td className="py-2 pr-2 text-xs tabular-nums text-slate-500">{row.rowNumber}</td>
                  <td className="py-2 pr-2 whitespace-nowrap text-sm">
                    {row.planned
                      ? formatAccountingDate(row.planned.date)
                      : String(row.values.date ?? "")}
                  </td>
                  <td className="py-2 pr-2 whitespace-nowrap text-sm">
                    {row.planned ? formatAccountingDate(row.planned.dueDate) : String(row.values.dueDate ?? "")}
                    {row.planned?.dueDateFromTerms ? (
                      <span className="block text-xs text-slate-500">from terms</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 text-sm">
                    {String(row.values.consultant ?? "")}
                    {row.planned?.consultantIsNew ? (
                      <span className="block text-xs text-slate-500">new consultant</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 text-sm">{String(row.values.description ?? "")}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-sm">
                    {row.planned
                      ? formatMoney(row.planned.amount.toFixed(2), company.baseCurrency)
                      : String(row.values.amount ?? "")}
                  </td>
                  <td className="py-2 text-sm">
                    {String(row.values.account ?? "")}
                    {row.planned?.accountLabel ? (
                      <span className="block text-xs text-slate-500">
                        → {row.planned.accountLabel}
                      </span>
                    ) : null}
                    {errors.map((issue, index) => (
                      <span
                        key={`error-${index}`}
                        className={`mt-0.5 block text-xs ${
                          issue.code === "unmappedAccount" || issue.code === "unknownConsultant"
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-red-700 dark:text-red-400"
                        }`}
                      >
                        {issue.message}
                      </span>
                    ))}
                    {warnings.map((issue, index) => (
                      <span
                        key={`warning-${index}`}
                        className="mt-0.5 block text-xs text-amber-700 dark:text-amber-400"
                      >
                        {issue.message}
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </Card>
    </>
  );
}

/** The sheet's headers back into column values. */
function rawToValues(raw: Record<string, unknown>) {
  const values: Partial<Record<ConsultantBillColumnKey, unknown>> = {};
  for (const [header, value] of Object.entries(raw)) {
    const column = consultantBillColumnFor(header);
    if (column && values[column.key] === undefined) values[column.key] = value;
  }
  return values;
}
