import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { commitImport, discardBatch, rollbackImport } from "@/lib/imports/work-orders";
import { validateRows } from "@/lib/imports/validate";
import { WORK_ORDER_IMPORT_COLUMNS, COLUMN_LABEL, type ColumnKey } from "@/lib/imports/columns";
import { PostingError } from "@/lib/errors";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { Alert, Button, Card, EmptyState, PageHeader, Select } from "@/components/ui";

/**
 * The validation report (SPEC §8.3). Every row is shown with what it was
 * understood to mean and anything wrong with it, alongside the grouping the
 * import will produce — "12 rows → 5 work orders" — before a single document
 * is created.
 */
export default async function ImportReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const { batchId } = await params;
  const { error } = await searchParams;

  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, ...scope.where, kind: "WORK_ORDER" },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) notFound();

  const [company, consultants] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "CONSULTANT", isActive: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const validation = await validateRows({
    companyId: scope.companyId,
    rows: batch.rows.map((row) => ({
      rowNumber: row.rowNumber,
      raw: row.rawJson as Record<string, unknown>,
      values: valuesFromRaw(row.rawJson as Record<string, unknown>),
    })),
  });

  // Names the sheet used that matched nothing, so they can be mapped once.
  const unmatchedNames = [
    ...new Set(
      validation.rows
        .filter((row) => row.issues.some((issue) => /No consultant matches/.test(issue.message)))
        .map((row) => {
          const raw = row.raw as Record<string, unknown>;
          const key = Object.keys(raw).find((header) =>
            /consultant|name|payee/i.test(header),
          );
          return key ? String(raw[key] ?? "").trim() : "";
        })
        .filter(Boolean),
    ),
  ];

  const createdWorkOrders =
    batch.status === "COMMITTED"
      ? await prisma.workOrder.findMany({
          where: { companyId: scope.companyId, importBatchId: batch.id },
          include: { vendor: { select: { name: true } }, lines: { select: { id: true } } },
          orderBy: { createdAt: "asc" },
        })
      : [];

  async function commit(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const overrides: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("map-") || !value) continue;
      overrides[key.slice(4).toLowerCase()] = String(value);
    }

    try {
      await commitImport({
        companyId: inner.companyId,
        batchId,
        consultantOverrides: overrides,
        userId: inner.userId,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) {
        redirect(`/work-orders/import/${batchId}?error=${encodeURIComponent(thrown.message)}`);
      }
      throw thrown;
    }
    redirect(`/work-orders/import/${batchId}`);
  }

  async function discard() {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    await discardBatch(inner.companyId, batchId);
    redirect("/work-orders/import");
  }

  async function undo() {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    try {
      await rollbackImport({ companyId: inner.companyId, batchId, userId: inner.userId });
    } catch (thrown) {
      if (thrown instanceof PostingError) {
        redirect(`/work-orders/import/${batchId}?error=${encodeURIComponent(thrown.message)}`);
      }
      throw thrown;
    }
    redirect(`/work-orders/import/${batchId}`);
  }

  const committed = batch.status === "COMMITTED";

  return (
    <>
      <PageHeader
        title={batch.fileName}
        description={`${batch.rowCount} rows · uploaded ${formatAccountingDate(batch.uploadedAt)} · ${batch.status
          .toLowerCase()
          .replace("_", " ")}`}
      />

      {error ? <Alert tone="error">{decodeURIComponent(error)}</Alert> : null}

      {committed ? (
        <Alert tone="success">
          {batch.createdCount} draft work orders created. They post nothing until approved —{" "}
          <Link className="underline" href="/work-orders?status=DRAFT">
            review and approve them
          </Link>
          .
        </Alert>
      ) : (
        <Alert tone={validation.counts.error > 0 ? "warning" : "info"}>
          <strong>
            {validation.counts.valid} of {batch.rowCount} rows are good → {validation.workOrders.length}{" "}
            work order{validation.workOrders.length === 1 ? "" : "s"}.
          </strong>{" "}
          {validation.counts.error > 0
            ? `${validation.counts.error} rows have errors and will be skipped. Fix the sheet and re-upload, or import the good rows now.`
            : "Nothing is created until you press the button."}
        </Alert>
      )}

      {!committed && unmatchedNames.length > 0 ? (
        <Card className="mt-4">
          <h2 className="mb-2 text-sm font-semibold">Names that matched nothing</h2>
          <p className="mb-3 text-xs text-slate-500">
            Map each one once — the spelling is remembered on that consultant, so the next sheet
            matches it automatically.
          </p>
          <form action={commit} className="space-y-3">
            {unmatchedNames.map((name) => (
              <div key={name} className="flex items-center gap-3">
                <span className="w-56 text-sm">{name}</span>
                <Select name={`map-${name}`} defaultValue="" className="max-w-xs">
                  <option value="">Skip these rows</option>
                  {consultants.map((consultant) => (
                    <option key={consultant.id} value={consultant.id}>
                      {consultant.name}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
            <Button type="submit">
              Import {validation.workOrders.length} work order
              {validation.workOrders.length === 1 ? "" : "s"} with these mappings
            </Button>
          </form>
        </Card>
      ) : null}

      {!committed ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {unmatchedNames.length === 0 ? (
            <form action={commit}>
              <Button type="submit" disabled={validation.workOrders.length === 0}>
                Create {validation.workOrders.length} draft work order
                {validation.workOrders.length === 1 ? "" : "s"}
              </Button>
            </form>
          ) : null}
          {validation.counts.error > 0 ? (
            <a href={`/work-orders/import/${batch.id}/rejects`}>
              <Button variant="secondary" type="button">
                Download the rejected rows
              </Button>
            </a>
          ) : null}
          <form action={discard}>
            <Button variant="ghost" type="submit">
              Discard this upload
            </Button>
          </form>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/work-orders?status=DRAFT">
            <Button>Review the drafts</Button>
          </Link>
          <form action={undo}>
            <Button variant="secondary" type="submit">
              Undo this import
            </Button>
          </form>
          <p className="w-full text-xs text-slate-500">
            Undo works while every work order it made is still an untouched draft.
          </p>
        </div>
      )}

      {committed ? (
        <Card className="mt-6">
          <h2 className="mb-3 text-sm font-semibold">What it created</h2>
          {createdWorkOrders.length === 0 ? (
            <EmptyState title="Nothing — this batch was undone" />
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {createdWorkOrders.map((workOrder) => (
                  <tr key={workOrder.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2">
                      <Link className="underline" href={`/work-orders/${workOrder.id}`}>
                        {workOrder.vendor.name}
                      </Link>
                    </td>
                    <td className="py-2 text-slate-500">{workOrder.lines.length} lines</td>
                    <td className="py-2">{formatAccountingDate(workOrder.issueDate)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(workOrder.total.toFixed(2), workOrder.currency)}
                    </td>
                    <td className="py-2 text-xs text-slate-500">{workOrder.status.toLowerCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : (
        <Card className="mt-6">
          <h2 className="mb-3 text-sm font-semibold">Work orders this will create</h2>
          {validation.workOrders.length === 0 ? (
            <EmptyState title="No complete work orders in this sheet" />
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {validation.workOrders.map((planned) => (
                  <tr key={planned.groupKey} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2">{planned.consultantName}</td>
                    <td className="py-2 text-slate-500">
                      {planned.lines.length} line{planned.lines.length === 1 ? "" : "s"}
                      {planned.lines.some((line) => line.amount.isNegative()) ? " · has a deduction" : ""}
                    </td>
                    <td className="py-2">{formatAccountingDate(planned.issueDate)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(planned.total.toFixed(2), planned.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <Card className="mt-6 overflow-x-auto">
        <h2 className="mb-3 text-sm font-semibold">Every row</h2>
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <th className="py-2">Row</th>
              {WORK_ORDER_IMPORT_COLUMNS.map((column) => (
                <th key={column.key} className="py-2">
                  {column.header}
                </th>
              ))}
              <th className="py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {validation.rows.map((row) => {
              const raw = row.raw as Record<string, unknown>;
              const values = valuesFromRaw(raw);
              const hasError = row.issues.some((issue) => issue.severity === "error");
              return (
                <tr
                  key={row.rowNumber}
                  className={`border-b border-slate-100 dark:border-slate-800/60 ${
                    hasError ? "bg-red-50/60 dark:bg-red-950/20" : ""
                  }`}
                >
                  <td className="py-1.5 text-xs text-slate-500">{row.rowNumber}</td>
                  {WORK_ORDER_IMPORT_COLUMNS.map((column) => (
                    <td key={column.key} className="py-1.5">
                      {formatCell(values[column.key])}
                    </td>
                  ))}
                  <td className="py-1.5 text-xs">
                    {row.issues.length === 0 ? (
                      <span className="text-emerald-600 dark:text-emerald-400">ok</span>
                    ) : (
                      row.issues.map((issue, index) => (
                        <div
                          key={index}
                          className={
                            issue.severity === "error"
                              ? "text-red-600 dark:text-red-400"
                              : issue.severity === "warning"
                                ? "text-amber-700 dark:text-amber-300"
                                : "text-slate-500"
                          }
                        >
                          {issue.column !== "row" ? `${COLUMN_LABEL[issue.column]}: ` : ""}
                          {issue.message}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-slate-500">
          Amounts are shown as the sheet wrote them. Reported in {company.baseCurrency} once
          imported.
        </p>
      </Card>
    </>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
  return String(value);
}

/** Header row → column keys, mirroring the parser. */
function valuesFromRaw(raw: Record<string, unknown>): Partial<Record<ColumnKey, unknown>> {
  const normalise = (value: string) => value.trim().toLowerCase().replace(/[\s._-]+/g, " ");
  const values: Partial<Record<ColumnKey, unknown>> = {};
  for (const [header, value] of Object.entries(raw)) {
    const definition = WORK_ORDER_IMPORT_COLUMNS.find(
      (column) =>
        normalise(column.header) === normalise(header) ||
        column.aliases.some((alias) => normalise(alias) === normalise(header)),
    );
    if (definition) values[definition.key] = value;
  }
  return values;
}
