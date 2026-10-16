import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { stageExpenseImport } from "@/lib/imports/expenses";
import { deleteImportBatch } from "@/lib/imports/erase";
import { EXPENSE_IMPORT_COLUMNS } from "@/lib/imports/expense-columns";
import { ImportParseError, maxImportBytes, maxImportLabel } from "@/lib/imports/parse";
import { PostingError } from "@/lib/errors";
import { formatAccountingDate } from "@/lib/dates";
import { Alert, Button, Card, DataTable, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Import expenses") };

/**
 * SPEC §8.3. Upload → parse → review → commit, for a month of expenses kept in
 * somebody's own spreadsheet. This page is the first two steps; nothing is
 * written but a staged batch.
 */
export default async function ImportExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; removed?: string }>;
}) {
  const scope = await sectionScope("VENDORS");
  const params = await searchParams;

  const [batches, company] = await Promise.all([
    prisma.importBatch.findMany({
      where: { ...scope.where, kind: "EXPENSE" },
      orderBy: { uploadedAt: "desc" },
      take: 10,
    }),
    prisma.company.findUniqueOrThrow({
      where: { id: scope.companyId },
      select: { name: true },
    }),
  ]);

  async function upload(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      redirect("/expenses/import?error=Choose%20a%20file");
    }
    const upload = file as File;
    if (upload.size > maxImportBytes()) {
      redirect(
        `/expenses/import?error=${encodeURIComponent(`That file is over ${maxImportLabel()}`)}`,
      );
    }

    let batchId: string;
    try {
      const staged = await stageExpenseImport({
        companyId: inner.companyId,
        fileName: upload.name,
        bytes: Buffer.from(await upload.arrayBuffer()),
        sheetName: String(formData.get("sheetName") || "") || null,
        dateFormat: String(formData.get("dateFormat") || "MDY") as "MDY" | "DMY" | "ISO",
        userId: inner.userId,
      });
      batchId = staged.batchId;
    } catch (error) {
      if (error instanceof ImportParseError || error instanceof PostingError) {
        redirect(`/expenses/import?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
    redirect(`/expenses/import/${batchId}`);
  }

  async function removeBatch(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const result = await deleteImportBatch(inner, String(formData.get("batchId") || ""));
    redirect(
      result.ok
        ? `/expenses/import?removed=${encodeURIComponent(result.fileName)}`
        : `/expenses/import?error=${encodeURIComponent(result.reason)}`,
    );
  }

  return (
    <>
      <PageHeader
        title="Import expenses"
        description="Upload your spreadsheet. Nothing is recorded until you review what it found."
      />
      {params.error ? <Alert tone="error">{decodeURIComponent(params.error)}</Alert> : null}
      {params.removed ? (
        <Alert tone="success">
          Removed {decodeURIComponent(params.removed)} from the list. No expenses were affected.
        </Alert>
      ) : null}

      {/* Which company this lands in, said out loud: importing a client's
          sheet into the wrong book is the mistake worth one line of text. */}
      <Alert tone="info">
        These expenses will be recorded in <strong>{company.name}</strong>.
      </Alert>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">Upload</h2>
          <form action={upload} className="space-y-4">
            <Field label="File" hint={`.xlsx or .csv, up to ${maxImportLabel()} and 5,000 rows.`}>
              <Input type="file" name="file" accept=".xlsx,.csv" required />
            </Field>
            <Field label="Sheet" hint="The tab to read. Leave blank for the first one.">
              <Input name="sheetName" placeholder="(first sheet)" />
            </Field>
            <Field
              label="Date format"
              hint="How to read a text date like 7/5/2025. Dates stored as real dates are read directly."
            >
              <Select name="dateFormat" defaultValue="MDY">
                <option value="MDY">Month/Day/Year — 7/5/2025 is 5 July</option>
                <option value="DMY">Day/Month/Year — 7/5/2025 is 7 May</option>
                <option value="ISO">Year-Month-Day</option>
              </Select>
            </Field>
            <Button type="submit">Upload and check</Button>
          </form>

          <p className="mt-4 text-xs text-slate-500">
            The next screen is where you say which account each of the sheet&rsquo;s categories
            means, and which account the money came out of. Committing records a paid expense per
            row and posts it.
          </p>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">The columns it reads</h2>
          <DataTable>
            <tbody>
              {EXPENSE_IMPORT_COLUMNS.map((column) => (
                <tr key={column.key} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-1.5 pr-2 font-medium whitespace-nowrap">{column.header}</td>
                  <td className="py-1.5 pr-2 text-xs text-slate-500">
                    {column.required ? "required" : "optional"}
                  </td>
                  <td className="py-1.5 text-xs text-slate-500">{column.note}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          <p className="mt-3 text-xs text-slate-500">
            Any other column — a MONTH label, a running total — is ignored. Headers are matched
            whatever their capitalisation or spacing.
          </p>
        </Card>
      </div>

      {batches.length > 0 ? (
        <Card className="mt-6">
          <h2 className="mb-3 text-sm font-semibold">Recent imports</h2>
          <DataTable>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2">File</th>
                <th className="pb-2">Uploaded</th>
                <th className="pb-2">Status</th>
                <th className="pb-2 text-right">Rows</th>
                <th className="pb-2 text-right">Recorded</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2 pr-2">
                    <Link href={`/expenses/import/${batch.id}`} className="underline">
                      {batch.fileName}
                    </Link>
                    {batch.sheetName ? (
                      <span className="block text-xs text-slate-500">{batch.sheetName}</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 text-sm">{formatAccountingDate(batch.uploadedAt)}</td>
                  <td className="py-2 pr-2 text-sm">{batch.status.toLowerCase()}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{batch.rowCount}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{batch.createdCount}</td>
                  <td className="py-2 text-right">
                    {batch.status === "DISCARDED" ? (
                      <form action={removeBatch}>
                        <input type="hidden" name="batchId" value={batch.id} />
                        <Button type="submit" variant="ghost">
                          Remove
                        </Button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>
      ) : null}
    </>
  );
}
