import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { storage, storageKeys } from "@/lib/storage";
import { writeAudit } from "@/lib/audit";
import { PostingError } from "@/lib/errors";
import { WORK_ORDER_IMPORT_COLUMNS } from "./columns";
import { parseWorkbook, type ParsedSheet } from "./parse";
import { validateRows, type ValidationResult } from "./validate";

/**
 * Staging, committing and undoing a work order import (SPEC §8.3).
 *
 * Uploading never creates documents. Rows are parsed, validated and stored for
 * review; the commit is a separate, deliberate act that runs in one
 * transaction. What it creates is always a **DRAFT** — approval is what posts,
 * and bulk-posting from a spreadsheet without review is exactly what this
 * system exists to prevent.
 */

export function hashFile(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type StagedBatch = {
  batchId: string;
  sheet: ParsedSheet;
  validation: ValidationResult;
  duplicateOf: { id: string; uploadedAt: Date; createdCount: number } | null;
};

export async function stageImport(options: {
  companyId: string;
  fileName: string;
  bytes: Buffer;
  sheetName?: string | null;
  dateFormat?: "MDY" | "DMY" | "ISO";
  userId?: string | null;
}): Promise<StagedBatch> {
  const sheet = await parseWorkbook({
    bytes: options.bytes,
    fileName: options.fileName,
    sheetName: options.sheetName,
  });

  if (sheet.missingRequired.length > 0) {
    throw new PostingError(
      `That sheet is missing required columns: ${sheet.missingRequired
        .map((key) => WORK_ORDER_IMPORT_COLUMNS.find((column) => column.key === key)?.header ?? key)
        .join(", ")}.`,
    );
  }
  if (sheet.rows.length === 0) throw new PostingError("That sheet has no data rows.");

  const fileHash = hashFile(options.bytes);

  // Re-importing the same file is warned about loudly, not blocked: a
  // corrected sheet is a legitimate second run (SPEC §8.3).
  const previous = await prisma.importBatch.findFirst({
    where: {
      companyId: options.companyId,
      kind: "WORK_ORDER",
      fileHash,
      status: "COMMITTED",
    },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, uploadedAt: true, createdCount: true },
  });

  const validation = await validateRows({
    companyId: options.companyId,
    rows: sheet.rows,
    dateFormat: options.dateFormat,
  });

  const batch = await prisma.importBatch.create({
    data: {
      companyId: options.companyId,
      kind: "WORK_ORDER",
      status: "PARSED",
      fileName: options.fileName,
      fileHash,
      sheetName: sheet.sheetName,
      rowCount: sheet.rows.length,
      uploadedByUserId: options.userId ?? null,
      rows: {
        create: validation.rows.map((row) => ({
          rowNumber: row.rowNumber,
          rawJson: row.raw as Prisma.InputJsonValue,
          parsedJson: row.line
            ? ({
                consultantId: row.line.consultantId,
                consultantName: row.line.consultantName,
                lineNo: row.line.lineNo,
                description: row.line.description,
                accountId: row.line.accountId,
                accountLabel: row.line.accountLabel,
                quantity: row.line.quantity.toString(),
                rate: row.line.rate.toString(),
                amount: row.line.amount.toString(),
                issueDate: row.line.issueDate.toISOString(),
                groupKey: row.line.groupKey,
              } as Prisma.InputJsonValue)
            : undefined,
          status: row.issues.some((issue) => issue.severity === "error")
            ? "ERROR"
            : row.issues.some((issue) => issue.severity === "warning")
              ? "WARNING"
              : "VALID",
          issues: row.issues as unknown as Prisma.InputJsonValue,
        })),
      },
    },
  });

  // The original file is kept: a batch must be able to show its source.
  const fileKey = storageKeys.importFile(options.companyId, batch.id, options.fileName);
  await storage().put(fileKey, options.bytes);
  await prisma.importBatch.update({ where: { id: batch.id }, data: { fileKey } });

  return { batchId: batch.id, sheet, validation, duplicateOf: previous };
}

/**
 * Create the work orders. Valid rows import and error rows stay behind for
 * correction — partial commit is the default (SPEC §8.3) — but the commit
 * itself is one transaction: if it fails, nothing is created.
 */
export async function commitImport(options: {
  companyId: string;
  batchId: string;
  dateFormat?: "MDY" | "DMY" | "ISO";
  consultantOverrides?: Record<string, string>;
  userId?: string | null;
}) {
  const batch = await prisma.importBatch.findFirst({
    where: { id: options.batchId, companyId: options.companyId },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) throw new PostingError("Import batch not found in this company");
  if (batch.status !== "PARSED") throw new PostingError("This batch has already been dealt with");

  // Re-validate from the stored raw rows rather than trusting what was staged:
  // consultants may have been created since, or a mapping chosen.
  const validation = await validateRows({
    companyId: options.companyId,
    rows: batch.rows.map((row) => ({
      rowNumber: row.rowNumber,
      raw: row.rawJson as Record<string, unknown>,
      values: rawToValues(row.rawJson as Record<string, unknown>),
    })),
    dateFormat: options.dateFormat,
    consultantOverrides: options.consultantOverrides,
  });

  const created = await prisma.$transaction(async (tx) => {
    const madeIds: { workOrderId: string; rowNumbers: number[] }[] = [];

    for (const planned of validation.workOrders) {
      const workOrder = await tx.workOrder.create({
        data: {
          companyId: options.companyId,
          vendorId: planned.consultantId,
          issueDate: planned.issueDate,
          dueDate: planned.dueDate,
          currency: planned.currency,
          fxRate: 1,
          status: "DRAFT",
          total: planned.total,
          balanceDue: planned.total,
          importBatchId: batch.id,
          lines: {
            create: planned.lines.map((line, index) => ({
              lineNumber: index + 1,
              description: line.description,
              quantity: line.quantity,
              rate: line.rate,
              amount: line.amount,
              accountId: line.accountId,
            })),
          },
        },
      });
      madeIds.push({
        workOrderId: workOrder.id,
        rowNumbers: planned.lines.map((line) => line.rowNumber),
      });
    }

    for (const made of madeIds) {
      await tx.importRow.updateMany({
        where: { importBatchId: batch.id, rowNumber: { in: made.rowNumbers } },
        data: { status: "IMPORTED", workOrderId: made.workOrderId },
      });
    }

    const importedRowCount = madeIds.reduce((total, made) => total + made.rowNumbers.length, 0);

    await tx.importBatch.update({
      where: { id: batch.id },
      data: {
        status: "COMMITTED",
        committedAt: new Date(),
        createdCount: madeIds.length,
        skippedCount: batch.rows.length - importedRowCount,
      },
    });

    return madeIds;
  });

  // Remember every manual mapping, so the same spelling is never mapped twice.
  for (const [sheetName, consultantId] of Object.entries(options.consultantOverrides ?? {})) {
    const consultant = await prisma.vendor.findFirst({
      where: { id: consultantId, companyId: options.companyId, kind: "CONSULTANT" },
    });
    if (!consultant) continue;
    if (consultant.importAliases.some((alias) => alias.toLowerCase() === sheetName.toLowerCase())) {
      continue;
    }
    await prisma.vendor.update({
      where: { id: consultant.id },
      data: { importAliases: [...consultant.importAliases, sheetName] },
    });
  }

  await writeAudit({
    companyId: options.companyId,
    userId: options.userId,
    action: "work_order_import.committed",
    entityType: "ImportBatch",
    entityId: batch.id,
    summary: `${created.length} draft work orders from ${batch.fileName}`,
  });

  return { workOrderCount: created.length, validation };
}

/** Reverse the sheet's headers back into column values for re-validation. */
function rawToValues(raw: Record<string, unknown>) {
  const values: Record<string, unknown> = {};
  const normalise = (value: string) => value.trim().toLowerCase().replace(/[\s._-]+/g, " ");
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

/**
 * Undo a whole batch — allowed only while every work order it made is still an
 * untouched draft, which is the point at which nothing has been posted or
 * emailed (SPEC §8.3).
 */
export async function rollbackImport(options: {
  companyId: string;
  batchId: string;
  userId?: string | null;
}) {
  const batch = await prisma.importBatch.findFirst({
    where: { id: options.batchId, companyId: options.companyId },
  });
  if (!batch) throw new PostingError("Import batch not found in this company");
  if (batch.status !== "COMMITTED") throw new PostingError("This batch has nothing to roll back");

  const workOrders = await prisma.workOrder.findMany({
    where: { companyId: options.companyId, importBatchId: batch.id },
    select: { id: true, status: true, workOrderNumber: true, lastEmailedAt: true },
  });

  const touched = workOrders.filter(
    (workOrder) => workOrder.status !== "DRAFT" || workOrder.lastEmailedAt !== null,
  );
  if (touched.length > 0) {
    throw new PostingError(
      `${touched.length} of these work orders have been approved or emailed. Void or handle those individually instead.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.workOrder.deleteMany({
      where: { companyId: options.companyId, importBatchId: batch.id },
    });
    await tx.importRow.updateMany({
      where: { importBatchId: batch.id, status: "IMPORTED" },
      data: { status: "SKIPPED", workOrderId: null },
    });
    await tx.importBatch.update({
      where: { id: batch.id },
      data: { status: "ROLLED_BACK", createdCount: 0 },
    });
  });

  await writeAudit({
    companyId: options.companyId,
    userId: options.userId,
    action: "work_order_import.rolled_back",
    entityType: "ImportBatch",
    entityId: batch.id,
    summary: `${workOrders.length} draft work orders removed`,
  });

  return { removed: workOrders.length };
}

export async function discardBatch(companyId: string, batchId: string) {
  await prisma.importBatch.updateMany({
    where: { id: batchId, companyId, status: "PARSED" },
    data: { status: "DISCARDED" },
  });
}

/** The blank template offered on the import screen (SPEC §8.3). */
export async function buildTemplateWorkbook(options: {
  consultants: { name: string; externalRef: string | null }[];
  accounts: { code: string; name: string }[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Ledger";

  const sheet = workbook.addWorksheet("Work Orders");
  sheet.columns = WORK_ORDER_IMPORT_COLUMNS.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.key === "description" ? 44 : 18,
  }));
  sheet.getRow(1).font = { bold: true };

  sheet.addRow({
    workOrderDate: "8/15/2026",
    consultantName: options.consultants[0]?.name ?? "Consultant Name",
    lineNo: 1,
    description: "Consultation for period 072626-081026",
    account: options.accounts[0]?.name ?? "Consultant Fees",
    quantity: 0.5,
    rate: 100000,
    amount: 50000,
  });
  sheet.addRow({
    workOrderDate: "8/15/2026",
    consultantName: options.consultants[0]?.name ?? "Consultant Name",
    lineNo: 2,
    description: "Cash Advances",
    account: "Advances to Consultants",
    quantity: 1,
    rate: -3000,
    amount: -3000,
  });

  const reference = workbook.addWorksheet("Reference");
  reference.addRow(["How this sheet is read"]);
  reference.getRow(1).font = { bold: true };
  for (const column of WORK_ORDER_IMPORT_COLUMNS) {
    reference.addRow([column.header, column.required ? "required" : "optional", column.note]);
  }
  reference.addRow([]);
  reference.addRow(["Consultants", "Code"]);
  for (const consultant of options.consultants) {
    reference.addRow([consultant.name, consultant.externalRef ?? ""]);
  }
  reference.addRow([]);
  reference.addRow(["Accounts", "Code"]);
  for (const account of options.accounts) reference.addRow([account.name, account.code]);
  reference.getColumn(1).width = 32;
  reference.getColumn(2).width = 14;
  reference.getColumn(3).width = 80;

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** The rejected rows, annotated with why, so the user fixes the file itself. */
export async function buildRejectWorkbook(companyId: string, batchId: string): Promise<Buffer> {
  const batch = await prisma.importBatch.findFirstOrThrow({
    where: { id: batchId, companyId },
    include: { rows: { where: { status: { in: ["ERROR", "SKIPPED"] } }, orderBy: { rowNumber: "asc" } } },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Rejected rows");

  const headers = Object.keys((batch.rows[0]?.rawJson as Record<string, unknown>) ?? {});
  sheet.addRow(["Sheet row", ...headers, "Why it was rejected"]);
  sheet.getRow(1).font = { bold: true };

  for (const row of batch.rows) {
    const raw = row.rawJson as Record<string, unknown>;
    const issues = (row.issues ?? []) as { message: string; severity: string }[];
    sheet.addRow([
      row.rowNumber,
      ...headers.map((header) => raw[header] ?? ""),
      issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message)
        .join("; "),
    ]);
  }

  sheet.columns.forEach((column) => {
    column.width = 22;
  });
  sheet.getColumn(sheet.columnCount).width = 70;

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
