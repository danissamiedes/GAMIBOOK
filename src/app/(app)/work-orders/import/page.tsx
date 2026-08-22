import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { stageImport } from "@/lib/imports/work-orders";
import { WORK_ORDER_IMPORT_COLUMNS } from "@/lib/imports/columns";
import { maxImportBytes, maxImportLabel, ImportParseError } from "@/lib/imports/parse";
import { PostingError } from "@/lib/errors";
import { formatAccountingDate } from "@/lib/dates";
import { Alert, Button, Card, DataTable, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Import work orders") };

/**
 * SPEC §8.3. Upload → parse → validation report → confirm → create. This page
 * is the first two steps; nothing is written but a staged batch.
 */
export default async function ImportWorkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  const batches = await prisma.importBatch.findMany({
    where: { ...scope.where, kind: "WORK_ORDER" },
    orderBy: { uploadedAt: "desc" },
    take: 10,
  });

  async function upload(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      redirect("/work-orders/import?error=Choose%20a%20file");
    }
    const upload = file as File;
    if (upload.size > maxImportBytes()) {
      redirect(
        `/work-orders/import?error=${encodeURIComponent(`That file is over ${maxImportLabel()}`)}`,
      );
    }

    let batchId: string;
    try {
      const staged = await stageImport({
        companyId: inner.companyId,
        fileName: upload.name,
        bytes: Buffer.from(await upload.arrayBuffer()),
        sheetName: String(formData.get("sheetName") || "") || null,
        dateFormat: (String(formData.get("dateFormat") || "MDY") as "MDY" | "DMY" | "ISO"),
        userId: inner.userId,
      });
      batchId = staged.batchId;
    } catch (error) {
      if (error instanceof ImportParseError || error instanceof PostingError) {
        redirect(`/work-orders/import?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
    redirect(`/work-orders/import/${batchId}`);
  }

  return (
    <>
      <PageHeader
        title="Import work orders"
        description="Upload your spreadsheet. Nothing is created until you review what it found."
      />
      {params.error ? <Alert tone="error">{decodeURIComponent(params.error)}</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Upload</h2>
          <form action={upload} className="space-y-4">
            <Field label="File" hint={`.xlsx or .csv, up to ${maxImportLabel()} and 5,000 rows.`}>
              <Input type="file" name="file" accept=".xlsx,.csv" required />
            </Field>
            <Field label="Sheet" hint="Leave blank for the first sheet in the workbook.">
              <Input name="sheetName" placeholder="(first sheet)" />
            </Field>
            <Field
              label="Date format"
              hint="How to read a text date like 8/9/2026. Dates stored as real dates are read directly."
            >
              <Select name="dateFormat" defaultValue="MDY">
                <option value="MDY">Month/Day/Year — 8/15/2026 is 15 August</option>
                <option value="DMY">Day/Month/Year — 8/9/2026 is 8 September</option>
                <option value="ISO">Year-Month-Day</option>
              </Select>
            </Field>
            <Button type="submit">Upload and check</Button>
          </form>

          <p className="mt-4 text-xs text-slate-500">
            Imported work orders are created as drafts. Approving them is a separate step, and that
            is what posts to the ledger.
          </p>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">The columns it reads</h2>
          <DataTable>
            <tbody>
              {WORK_ORDER_IMPORT_COLUMNS.map((column) => (
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
          {/* A file download from a route handler, not a page: Link would
              prefetch and soft-navigate a binary response. */}
          <a href="/work-orders/import/template" className="mt-4 inline-block" download>
            <Button variant="secondary" type="button">
              Download template
            </Button>
          </a>
        </Card>
      </div>

      {batches.length > 0 ? (
        <>
          <h2 className="mt-8 mb-3 text-sm font-semibold">Recent imports</h2>
          <Card>
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">File</th>
                  <th className="py-2">Uploaded</th>
                  <th className="py-2">Rows</th>
                  <th className="py-2">Work orders</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2">
                      <Link className="underline" href={`/work-orders/import/${batch.id}`}>
                        {batch.fileName}
                      </Link>
                    </td>
                    <td className="py-2">{formatAccountingDate(batch.uploadedAt)}</td>
                    <td className="py-2">{batch.rowCount}</td>
                    <td className="py-2">{batch.createdCount || "—"}</td>
                    <td className="py-2 text-xs text-slate-500">{batch.status.toLowerCase().replace("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </Card>
        </>
      ) : null}
    </>
  );
}
