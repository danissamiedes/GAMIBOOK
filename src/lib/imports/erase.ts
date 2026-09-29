import type { ImportBatchStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CompanyScope } from "@/lib/company-scope";
import { writeAudit } from "@/lib/audit";
import { storage, withStorage } from "@/lib/storage";

/**
 * Clearing failed attempts out of "Recent imports" (SPEC §8.3).
 *
 * The list fills up with the same spreadsheet uploaded four times while its
 * columns were being fixed. Those batches staged nothing, created nothing and
 * posted nothing — they are a record of an afternoon's frustration, and there
 * is no reason to keep them.
 *
 * **Only a discarded batch can go.** A committed one is the provenance of the
 * work orders it created: each carries `importBatchId` pointing back at it, and
 * that is the answer to "where did this posting come from". A batch still being
 * reviewed is unfinished work, and already has a Discard button of its own.
 *
 * Nothing here touches a document. Deleting a batch removes the upload and the
 * staged rows nobody accepted; the ledger does not know this happened.
 */

/** Statuses that may be removed: finished, and nothing came of them. */
const DELETABLE: ImportBatchStatus[] = ["DISCARDED"];

export function isDeletable(status: ImportBatchStatus): boolean {
  return DELETABLE.includes(status);
}

export type DeleteResult =
  | { ok: true; fileName: string }
  | { ok: false; reason: string };

export async function deleteImportBatch(
  scope: CompanyScope,
  batchId: string,
): Promise<DeleteResult> {
  // companyId in the filter is what stops a batch id from another company
  // working, whatever the caller sends.
  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, ...scope.where },
    select: {
      id: true,
      fileName: true,
      fileKey: true,
      status: true,
      rowCount: true,
      uploadedAt: true,
    },
  });
  if (!batch) return { ok: false, reason: "That import is no longer here." };

  if (!isDeletable(batch.status)) {
    return {
      ok: false,
      reason:
        batch.status === "COMMITTED"
          ? "This import created work orders, so it stays as the record of where they came from."
          : "Only a discarded import can be removed. Discard this one first.",
    };
  }

  // A discarded batch created nothing by definition — but the ledger is not a
  // place to trust a status field over the documents themselves. One count,
  // and a data state nobody anticipated cannot orphan a work order.
  const created = await prisma.workOrder.count({
    where: { companyId: scope.companyId, importBatchId: batch.id },
  });
  if (created > 0) {
    return {
      ok: false,
      reason: `This import is marked discarded but ${created} work order${
        created === 1 ? "" : "s"
      } still point at it. Nothing has been deleted — please report this.`,
    };
  }

  // Written before anything is removed. The row still exists here to be
  // described accurately, and a deletion with no audit entry is worse than an
  // entry describing a deletion that then failed.
  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: "import_batch.deleted",
    entityType: "ImportBatch",
    entityId: batch.id,
    summary: `${batch.fileName} (${batch.rowCount} rows, discarded)`,
    data: {
      fileName: batch.fileName,
      status: batch.status,
      rowCount: batch.rowCount,
      uploadedAt: batch.uploadedAt.toISOString(),
    },
  });

  // The staged rows go by cascade; the uploaded file is ours to remove. A file
  // that will not delete must not strand the row the user asked to be rid of —
  // an orphaned object in the bucket is the lesser problem.
  if (batch.fileKey) {
    const key = batch.fileKey;
    await withStorage("delete", () => storage().delete(key)).catch(() => {});
  }

  await prisma.importBatch.delete({ where: { id: batch.id } });

  return { ok: true, fileName: batch.fileName };
}
