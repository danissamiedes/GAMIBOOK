import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { BankAmountLayout } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { failTo } from "@/lib/fail";
import { storage } from "@/lib/storage";
import { ImportParseError, readWorkbook } from "@/lib/imports/parse";
import {
  commitStatement,
  stageStatement,
  suggestMapping,
  type ColumnMapping,
  type DateFormat,
} from "@/lib/bank/import";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import {
  Alert,
  Button,
  Card,
  DataTable,
  Field,
  PageHeader,
  Select,
} from "@/components/ui";

export const metadata = { title: "Map statement columns — Ledger" };

const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: "ISO", label: "2026-06-30 (ISO)" },
  { value: "DMY", label: "30/06/2026 (day first)" },
  { value: "MDY", label: "06/30/2026 (month first)" },
];

/**
 * Choosing what the statement's columns mean (SPEC §8.4).
 *
 * The mapping is applied and previewed before anything is written, because a
 * wrong date format or a debit column read as a credit turns every payment
 * into a receipt — visible instantly in a preview, invisible in a committed
 * import. Saving the mapping on the bank account makes the next one one click.
 */
export default async function BankImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const scope = await sectionScope("BANKING");
  const { batchId } = await params;
  const query = await searchParams;

  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, companyId: scope.companyId, kind: "BANK" },
  });
  if (!batch || !batch.fileKey) notFound();

  // sheetName carries the bank account this upload was for.
  const bankAccount = await prisma.bankAccount.findFirst({
    where: { id: batch.sheetName ?? "", companyId: scope.companyId },
    include: { account: { select: { code: true, name: true } } },
  });
  if (!bankAccount) notFound();

  if (batch.status !== "PARSED") {
    redirect(`/banking/match?account=${bankAccount.id}`);
  }

  const bytes = await storage().get(batch.fileKey);
  let headers: string[] = [];
  let readError: string | null = null;
  try {
    const sheet = await readWorkbook({ bytes, fileName: batch.fileName });
    headers = sheet.headers.filter(Boolean);
  } catch (error) {
    readError =
      error instanceof ImportParseError
        ? error.message
        : "That file could not be read.";
  }

  // The saved mapping wins, then anything the user has picked in the URL, then
  // a guess from the headers.
  const suggested = suggestMapping(headers);
  // "Actually saved" matters: amountLayout carries a column default, so a
  // brand new account already holds SIGNED and would silently beat a suggested
  // DEBIT_CREDIT — leaving the reader staring at a statement the app claims it
  // cannot read. dateColumn is the honest signal that a mapping was stored.
  const hasSavedMapping = Boolean(bankAccount.dateColumn);
  const pick = (key: string, saved?: string | null, fallback?: string | null) =>
    query[key] ?? (hasSavedMapping ? saved : null) ?? fallback ?? "";

  const mapping: ColumnMapping = {
    dateColumn: pick(
      "dateColumn",
      bankAccount.dateColumn,
      suggested.dateColumn,
    ),
    descriptionColumn: pick(
      "descriptionColumn",
      bankAccount.descriptionColumn,
      suggested.descriptionColumn,
    ),
    amountLayout: (query.amountLayout ??
      (hasSavedMapping ? bankAccount.amountLayout : null) ??
      suggested.amountLayout ??
      "SIGNED") as BankAmountLayout,
    amountColumn: pick(
      "amountColumn",
      bankAccount.amountColumn,
      suggested.amountColumn,
    ),
    debitColumn: pick(
      "debitColumn",
      bankAccount.debitColumn,
      suggested.debitColumn,
    ),
    creditColumn: pick(
      "creditColumn",
      bankAccount.creditColumn,
      suggested.creditColumn,
    ),
    referenceColumn: pick(
      "referenceColumn",
      bankAccount.referenceColumn,
      suggested.referenceColumn,
    ),
    dateFormat: (query.dateFormat ??
      (hasSavedMapping ? bankAccount.dateFormat : null) ??
      "ISO") as DateFormat,
  };

  const ready = Boolean(
    mapping.dateColumn &&
    mapping.descriptionColumn &&
    (mapping.amountLayout === "SIGNED"
      ? mapping.amountColumn
      : mapping.debitColumn || mapping.creditColumn),
  );

  let staged = null;
  let stageError: string | null = null;
  if (ready && !readError) {
    try {
      staged = await stageStatement({
        bankAccountId: bankAccount.id,
        bytes,
        fileName: batch.fileName,
        mapping,
      });
    } catch (error) {
      stageError =
        error instanceof ImportParseError
          ? error.message
          : "That file could not be read.";
    }
  }

  async function commit(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const back = `/banking/import/${batchId}`;

    const current = await prisma.importBatch.findFirstOrThrow({
      where: { id: batchId, companyId: inner.companyId },
    });
    if (current.status !== "PARSED")
      failTo("/banking", "That statement has already been imported");

    const account = await prisma.bankAccount.findFirstOrThrow({
      where: { id: current.sheetName ?? "", companyId: inner.companyId },
    });

    const applied: ColumnMapping = {
      dateColumn: String(formData.get("dateColumn") || ""),
      descriptionColumn: String(formData.get("descriptionColumn") || ""),
      amountLayout: String(
        formData.get("amountLayout") || "SIGNED",
      ) as BankAmountLayout,
      amountColumn: String(formData.get("amountColumn") || "") || null,
      debitColumn: String(formData.get("debitColumn") || "") || null,
      creditColumn: String(formData.get("creditColumn") || "") || null,
      referenceColumn: String(formData.get("referenceColumn") || "") || null,
      dateFormat: String(formData.get("dateFormat") || "ISO") as DateFormat,
    };

    const fileBytes = await storage().get(current.fileKey!);
    let result;
    try {
      const parsed = await stageStatement({
        bankAccountId: account.id,
        bytes: fileBytes,
        fileName: current.fileName,
        mapping: applied,
      });
      if (parsed.valid.length === 0) {
        failTo(
          back,
          "Nothing new to import — every readable line is already here",
        );
      }
      result = await commitStatement({
        companyId: inner.companyId,
        bankAccountId: account.id,
        // Reuse the batch the upload created, rather than leaving two rows in
        // the statement history for one import.
        batchId,
        fileName: current.fileName,
        rows: parsed.valid,
        userId: inner.userId,
      });
    } catch (error) {
      if (error instanceof ImportParseError) failTo(back, error.message);
      throw error;
    }

    // Remember the mapping, so the next statement for this account is one click.
    await prisma.bankAccount.update({
      where: { id: account.id },
      data: applied,
    });
    // commitStatement already marked the batch committed, with its counts.
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "bankStatement.imported",
      entityType: "ImportBatch",
      entityId: batchId,
      summary: `${result.created} line(s) into ${account.name}`,
    });
    redirect(`/banking/match?account=${account.id}&imported=${result.created}`);
  }

  async function discard() {
    "use server";
    const inner = await sectionScope("BANKING");
    const current = await prisma.importBatch.findFirstOrThrow({
      where: { id: batchId, companyId: inner.companyId },
    });
    if (current.fileKey) await storage().delete(current.fileKey);
    await prisma.importBatch.update({
      where: { id: batchId },
      data: { status: "DISCARDED" },
    });
    redirect("/banking?saved=1");
  }

  const columnField = (
    name: keyof ColumnMapping,
    label: string,
    hint?: string,
  ) => (
    <Field label={label} hint={hint}>
      <Select name={name} defaultValue={String(mapping[name] ?? "")}>
        <option value="">—</option>
        {headers.map((header) => (
          <option key={header} value={header}>
            {header}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <>
      <PageHeader
        title="Map the statement's columns"
        description={`${batch.fileName} → ${bankAccount.name} (${bankAccount.account.code} ${bankAccount.account.name})`}
      />

      {query.error ? <Alert tone="error">{query.error}</Alert> : null}
      {readError ? <Alert tone="error">{readError}</Alert> : null}
      {stageError ? <Alert tone="error">{stageError}</Alert> : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_2fr]">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Columns</h2>
          {/* A GET form: changing a column reloads the preview, so the mapping
              is judged against real rows rather than guessed at. */}
          <form className="space-y-3">
            {columnField("dateColumn", "Date")}
            <Field
              label="Date format"
              hint="Banks disagree, and a wrong guess moves the month."
            >
              <Select
                name="dateFormat"
                defaultValue={mapping.dateFormat ?? "ISO"}
              >
                {DATE_FORMATS.map((format) => (
                  <option key={format.value} value={format.value}>
                    {format.label}
                  </option>
                ))}
              </Select>
            </Field>
            {columnField("descriptionColumn", "Description")}
            <Field label="Amounts are in">
              <Select name="amountLayout" defaultValue={mapping.amountLayout}>
                <option value="SIGNED">
                  One column, negative for money out
                </option>
                <option value="DEBIT_CREDIT">
                  Separate debit and credit columns
                </option>
              </Select>
            </Field>
            {mapping.amountLayout === "SIGNED" ? (
              columnField("amountColumn", "Amount")
            ) : (
              <>
                {columnField("debitColumn", "Debit (money out)")}
                {columnField("creditColumn", "Credit (money in)")}
              </>
            )}
            {columnField("referenceColumn", "Reference", "Optional.")}
            <Button variant="secondary" type="submit">
              Update preview
            </Button>
          </form>
        </Card>

        <div className="min-w-0 space-y-4">
          {!ready ? (
            <Alert tone="info">
              Choose at least a date, a description and an amount column to see
              a preview.
            </Alert>
          ) : staged ? (
            <>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm">
                    <strong>{staged.valid.length}</strong> new ·{" "}
                    <strong>{staged.duplicates.length}</strong> already imported
                    · <strong>{staged.rejected.length}</strong> unreadable
                    {staged.earliest && staged.latest ? (
                      <span className="ml-2 text-slate-500">
                        {formatAccountingDate(staged.earliest)} to{" "}
                        {formatAccountingDate(staged.latest)}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <form action={discard}>
                      <Button variant="ghost" type="submit">
                        Discard
                      </Button>
                    </form>
                    <form action={commit}>
                      {/* The mapping travels with the commit, so what is
                          imported is exactly what was previewed. */}
                      <input
                        type="hidden"
                        name="dateColumn"
                        value={mapping.dateColumn}
                      />
                      <input
                        type="hidden"
                        name="dateFormat"
                        value={mapping.dateFormat ?? "ISO"}
                      />
                      <input
                        type="hidden"
                        name="descriptionColumn"
                        value={mapping.descriptionColumn}
                      />
                      <input
                        type="hidden"
                        name="amountLayout"
                        value={mapping.amountLayout}
                      />
                      <input
                        type="hidden"
                        name="amountColumn"
                        value={mapping.amountColumn ?? ""}
                      />
                      <input
                        type="hidden"
                        name="debitColumn"
                        value={mapping.debitColumn ?? ""}
                      />
                      <input
                        type="hidden"
                        name="creditColumn"
                        value={mapping.creditColumn ?? ""}
                      />
                      <input
                        type="hidden"
                        name="referenceColumn"
                        value={mapping.referenceColumn ?? ""}
                      />
                      <Button
                        type="submit"
                        disabled={staged.valid.length === 0}
                      >
                        Import {staged.valid.length} line
                        {staged.valid.length === 1 ? "" : "s"}
                      </Button>
                    </form>
                  </div>
                </div>

                {staged.duplicates.length > 0 ? (
                  <Alert tone="warning">
                    {staged.duplicates.length} line
                    {staged.duplicates.length === 1 ? " is" : "s are"} already
                    in this account and will not be imported again. That is
                    expected when statements overlap.
                  </Alert>
                ) : null}
              </Card>

              <Card>
                <h2 className="mb-3 text-sm font-semibold">Preview</h2>
                <DataTable>
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                      <th className="py-2">Row</th>
                      <th className="py-2">Date</th>
                      <th className="py-2">Description</th>
                      <th className="py-2">Reference</th>
                      <th className="py-2 text-right">Amount</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staged.rows.slice(0, 40).map((row) => {
                      const duplicate = staged.duplicates.includes(row);
                      return (
                        <tr
                          key={row.rowNumber}
                          className="border-b border-slate-100 dark:border-slate-800/60"
                        >
                          <td className="py-1.5 text-xs text-slate-400">
                            {row.rowNumber}
                          </td>
                          <td className="py-1.5 tabular-nums">
                            {row.date ? formatAccountingDate(row.date) : "—"}
                          </td>
                          <td className="py-1.5">{row.description || "—"}</td>
                          <td className="py-1.5 text-xs text-slate-500">
                            {row.reference ?? ""}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {row.amount
                              ? formatMoney(
                                  row.amount.toFixed(2),
                                  bankAccount.currency,
                                )
                              : "—"}
                          </td>
                          <td className="py-1.5 text-xs">
                            {row.error ? (
                              <span className="text-red-700 dark:text-red-300">
                                {row.error}
                              </span>
                            ) : duplicate ? (
                              <span className="text-amber-700 dark:text-amber-300">
                                already imported
                              </span>
                            ) : (
                              <span className="text-emerald-700 dark:text-emerald-300">
                                new
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </DataTable>
                {staged.rows.length > 40 ? (
                  <p className="mt-2 text-xs text-slate-500">
                    Showing the first 40 of {staged.rows.length} rows.
                  </p>
                ) : null}
              </Card>
            </>
          ) : null}

          <p className="text-xs text-slate-500">
            <Link className="underline" href="/banking">
              Back to banking
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}
