import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { storage, storageKeys } from "@/lib/storage";
import { WORK_ORDER_IMPORT_COLUMNS } from "./columns";
import { parseWorkbook, type ParsedSheet } from "./parse";
import { validateRows, type ValidationResult } from "./validate";
import { hashFile } from "./work-orders";

/**
 * Importing a sheet of purchase orders (SPEC §8.3, §8.1a).
 *
 * The same sheet as a work order import — date, party, line number,
 * description, account, quantity, rate — read by the same parser and checked
 * by the same validator, with two differences that matter: the party column
 * is matched against **vendors**, and what comes out the other end is a
 * draft purchase order, which posts nothing.
 *
 * Nothing is created by uploading. Rows are staged, reviewed, and only then
 * committed; rows with errors stay behind for correction.
 */

export type StagedPurchaseOrderBatch = {
  batchId: string;
  sheet: ParsedSheet;
  validation: ValidationResult;
  duplicateOf: { id: string; uploadedAt: Date; createdCount: number } | null;
};

export async function stagePurchaseOrderImport(options: {
  companyId: string;
  fileName: string;
  bytes: Buffer;
  sheetName?: string | null;
  dateFormat?: "MDY" | "DMY" | "ISO";
  userId?: string | null;
}): Promise<StagedPurchaseOrderBatch> {
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
      kind: "PURCHASE_ORDER",
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
    partyKind: "REGULAR",
  });

  const batch = await prisma.importBatch.create({
    data: {
      companyId: options.companyId,
      kind: "PURCHASE_ORDER",
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
                vendorId: row.line.consultantId,
                vendorName: row.line.consultantName,
                lineNo: row.line.lineNo,
                description: row.line.description,
                accountId: row.line.accountId,
                accountLabel: row.line.accountLabel,
                quantity: row.line.quantity.toString(),
                rate: row.line.rate.toString(),
                amount: row.line.amount.toString(),
                orderDate: row.line.issueDate.toISOString(),
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
 * Create the purchase orders — as drafts, because an imported order has not
 * been looked at by whoever will send it. Valid rows import and error rows
 * stay behind for correction, but the commit itself is one transaction.
 */
export async function commitPurchaseOrderImport(options: {
  companyId: string;
  batchId: string;
  dateFormat?: "MDY" | "DMY" | "ISO";
  /** Sheet name → vendor id, for the names the sheet spells differently. */
  vendorOverrides?: Record<string, string>;
  userId?: string | null;
}) {
  const batch = await prisma.importBatch.findFirst({
    where: { id: options.batchId, companyId: options.companyId, kind: "PURCHASE_ORDER" },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) throw new PostingError("Import batch not found in this company");
  if (batch.status !== "PARSED") throw new PostingError("This batch has already been dealt with");

  // Re-validated from the stored raw rows rather than trusted as staged: a
  // vendor may have been created, or a mapping chosen, since the upload.
  const validation = await validateRows({
    companyId: options.companyId,
    rows: batch.rows.map((row) => ({
      rowNumber: row.rowNumber,
      raw: row.rawJson as Record<string, unknown>,
      values: rawToValues(row.rawJson as Record<string, unknown>),
    })),
    dateFormat: options.dateFormat,
    consultantOverrides: options.vendorOverrides,
    partyKind: "REGULAR",
  });

  const created = await prisma.$transaction(async (tx) => {
    const made: { purchaseOrderId: string; rowNumbers: number[] }[] = [];

    for (const planned of validation.workOrders) {
      const order = await tx.purchaseOrder.create({
        data: {
          companyId: options.companyId,
          vendorId: planned.consultantId,
          orderDate: planned.issueDate,
          // The sheet's "due date" is when the goods are wanted.
          expectedDate: planned.dueDate,
          currency: planned.currency,
          fxRate: 1,
          status: "DRAFT",
          total: planned.total,
          importBatchId: batch.id,
          createdByUserId: options.userId ?? null,
          lines: {
            create: planned.lines.map((line, index) => ({
              lineNumber: index + 1,
              description: line.description,
              quantity: line.quantity,
              rate: line.rate,
              amount: line.amount,
              expenseAccountId: line.accountId,
            })),
          },
        },
      });
      made.push({
        purchaseOrderId: order.id,
        rowNumbers: planned.lines.map((line) => line.rowNumber),
      });
    }

    for (const row of made) {
      await tx.importRow.updateMany({
        where: { importBatchId: batch.id, rowNumber: { in: row.rowNumbers } },
        data: { status: "IMPORTED", purchaseOrderId: row.purchaseOrderId },
      });
    }

    const importedRowCount = made.reduce((total, row) => total + row.rowNumbers.length, 0);

    await tx.importBatch.update({
      where: { id: batch.id },
      data: {
        status: "COMMITTED",
        committedAt: new Date(),
        createdCount: made.length,
        skippedCount: batch.rows.length - importedRowCount,
      },
    });

    return made;
  });

  // Remember every manual mapping, so the same spelling is never mapped twice.
  for (const [sheetName, vendorId] of Object.entries(options.vendorOverrides ?? {})) {
    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, companyId: options.companyId, kind: "REGULAR" },
    });
    if (!vendor) continue;
    if (vendor.importAliases.some((alias) => alias.toLowerCase() === sheetName.toLowerCase())) {
      continue;
    }
    await prisma.vendor.update({
      where: { id: vendor.id },
      data: { importAliases: [...vendor.importAliases, sheetName] },
    });
  }

  await writeAudit({
    companyId: options.companyId,
    userId: options.userId,
    action: "purchase_order_import.committed",
    entityType: "ImportBatch",
    entityId: batch.id,
    summary: `${created.length} draft purchase orders from ${batch.fileName}`,
  });

  return { purchaseOrderCount: created.length, validation };
}

/**
 * Undo a committed import, while the orders it made are untouched.
 *
 * Simpler than the work order version, because there is nothing posted to
 * unpick: an order that has not become a bill can be deleted outright. One
 * that has is left alone and reported, since its bill is in the ledger.
 */
export async function rollbackPurchaseOrderImport(options: {
  companyId: string;
  batchId: string;
  userId?: string | null;
}) {
  const batch = await prisma.importBatch.findFirst({
    where: { id: options.batchId, companyId: options.companyId, kind: "PURCHASE_ORDER" },
    include: { rows: true },
  });
  if (!batch) throw new PostingError("Import batch not found in this company");
  if (batch.status !== "COMMITTED") throw new PostingError("This batch was never committed");

  const ids = [
    ...new Set(batch.rows.map((row) => row.purchaseOrderId).filter((id): id is string => !!id)),
  ];
  const orders = await prisma.purchaseOrder.findMany({
    where: { id: { in: ids }, companyId: options.companyId },
    include: { expense: { select: { id: true } } },
  });

  const removable = orders.filter((order) => !order.expense && order.status !== "RECEIVED");
  const kept = orders.filter((order) => order.expense || order.status === "RECEIVED");

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.deleteMany({
      where: { id: { in: removable.map((order) => order.id) } },
    });
    await tx.importRow.updateMany({
      where: {
        importBatchId: batch.id,
        purchaseOrderId: { in: removable.map((order) => order.id) },
      },
      data: { status: "VALID", purchaseOrderId: null },
    });
    await tx.importBatch.update({
      where: { id: batch.id },
      data: { status: "PARSED", committedAt: null, createdCount: kept.length },
    });
  });

  await writeAudit({
    companyId: options.companyId,
    userId: options.userId,
    action: "purchase_order_import.rolled_back",
    entityType: "ImportBatch",
    entityId: batch.id,
    summary: `${removable.length} removed, ${kept.length} kept (already billed)`,
  });

  return { removed: removable.length, kept: kept.length };
}
