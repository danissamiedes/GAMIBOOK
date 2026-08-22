import { prisma } from "@/lib/db";
import { ConfigurationError, PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { DriveError, listFolderImages, parseFolderId } from "./client";

/**
 * Scanning a watched Drive folder into the receipt inbox.
 *
 * Nothing is copied: the queue row holds the file's id and its Drive link, and
 * the image stays where it was put. So a receipt here is a pointer, and the
 * folder remains the single copy of the picture.
 */

export async function setWatchedFolder(input: {
  companyId: string;
  userId: string;
  folderInput: string;
  folderName?: string | null;
}) {
  const folderId = parseFolderId(input.folderInput);
  if (!folderId) {
    throw new PostingError(
      "That does not look like a Drive folder. Paste the folder's URL from the address bar, or its ID.",
    );
  }

  // Prove it is reachable before saving, so a typo fails here rather than
  // silently producing an empty queue for a week.
  await listFolderImages(folderId, { max: 1 });

  const watch = await prisma.driveWatch.upsert({
    where: { companyId: input.companyId },
    create: {
      companyId: input.companyId,
      folderId,
      folderName: input.folderName?.slice(0, 200) ?? null,
      createdByUserId: input.userId,
    },
    update: {
      folderId,
      folderName: input.folderName?.slice(0, 200) ?? null,
      lastError: null,
    },
  });

  await writeAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: "drive.folder_watched",
    entityType: "DriveWatch",
    entityId: watch.id,
    summary: folderId,
  });

  return watch;
}

export async function stopWatching(companyId: string, userId: string) {
  await prisma.driveWatch.deleteMany({ where: { companyId } });
  await writeAudit({
    companyId,
    userId,
    action: "drive.folder_unwatched",
    entityType: "DriveWatch",
  });
}

/**
 * Bring one company's queue up to date with its folder.
 *
 * Idempotent, because the cron endpoint runs every job on every knock: the
 * `(companyId, sourceFileId)` unique index is what makes re-scanning the whole
 * folder cheap and safe rather than a source of duplicates.
 */
export async function syncCompanyFolder(companyId: string): Promise<{ queued: number; seen: number }> {
  const watch = await prisma.driveWatch.findUnique({ where: { companyId } });
  if (!watch) return { queued: 0, seen: 0 };

  let files;
  try {
    files = await listFolderImages(watch.folderId);
  } catch (thrown) {
    const message =
      thrown instanceof DriveError || thrown instanceof ConfigurationError
        ? thrown.message
        : "Could not reach Google Drive";
    await prisma.driveWatch.update({
      where: { companyId },
      data: { lastError: message.slice(0, 300), lastSyncAt: new Date() },
    });
    throw thrown;
  }

  const known = new Set(
    (
      await prisma.receiptUpload.findMany({
        where: { companyId, source: "GOOGLE_DRIVE", sourceFileId: { in: files.map((f) => f.id) } },
        select: { sourceFileId: true },
      })
    ).map((row) => row.sourceFileId),
  );

  const fresh = files.filter((file) => !known.has(file.id));
  if (fresh.length > 0) {
    await prisma.receiptUpload.createMany({
      data: fresh.map((file) => ({
        companyId,
        // Nothing is copied in, so there is no storage key.
        fileKey: null,
        filename: file.name.slice(0, 200),
        mimeType: file.mimeType,
        byteSize: file.size ?? 0,
        source: "GOOGLE_DRIVE" as const,
        sourceFileId: file.id,
        sourceUrl: file.webViewLink,
      })),
      // Belt and braces against two scans overlapping.
      skipDuplicates: true,
    });
  }

  await prisma.driveWatch.update({
    where: { companyId },
    data: {
      lastSyncAt: new Date(),
      lastError: null,
      queuedTotal: { increment: fresh.length },
    },
  });

  return { queued: fresh.length, seen: files.length };
}

/**
 * Every watched folder, for the scheduler. One company's failure must not stop
 * the next company's scan, so failures are collected rather than thrown.
 */
export async function syncAllDriveFolders() {
  const watches = await prisma.driveWatch.findMany({ select: { companyId: true } });
  const results: { companyId: string; queued?: number; seen?: number; error?: string }[] = [];

  for (const watch of watches) {
    try {
      const outcome = await syncCompanyFolder(watch.companyId);
      results.push({ companyId: watch.companyId, ...outcome });
    } catch (thrown) {
      results.push({
        companyId: watch.companyId,
        error: thrown instanceof Error ? thrown.message.slice(0, 200) : "Unknown error",
      });
    }
  }

  return { folders: watches.length, results };
}
