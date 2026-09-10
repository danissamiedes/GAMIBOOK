import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { storage, storageKeys, withStorage } from "@/lib/storage";
import type { CompanyScope } from "@/lib/company-scope";

/**
 * Notes on a customer, vendor or consultant (SPEC §15).
 *
 * What a person wrote down about a party, with whatever files belong with it —
 * a signed contract, a copy of an ID, the email where they agreed the rate.
 * Nothing here touches the ledger.
 *
 * Consultants and vendors are both `Vendor` rows, so one `vendorId` covers
 * both; who may read a note follows from which page it is on, and those pages
 * are already section-scoped. The service never widens that: every read and
 * write is given a scope and filters by `companyId` through it.
 *
 * **Files are the note's, not the party's.** Deleting a note deletes its
 * attachments, in storage as well as in the database — a bucket slowly filling
 * with files no row points at is the failure mode this avoids.
 */

/** What a note can be attached to. Exactly one, enforced in the database too. */
export type PartyRef = { customerId: string } | { vendorId: string };

/** 10 MB a file, 5 files a note. Generous for a contract, mean enough to notice a mistake. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_NOTE = 5;

export type IncomingFile = {
  filename: string;
  bytes: Buffer;
  mimeType?: string | null;
};

/** Why this cannot be saved, or null. Shared by the form and the service. */
export function whyNotANote(input: { body: string; files?: IncomingFile[] }): string | null {
  const body = input.body.trim();
  if (!body) return "Write something in the note";
  if (body.length > 10_000) return "That note is too long";

  const files = input.files ?? [];
  if (files.length > MAX_FILES_PER_NOTE) {
    return `A note takes up to ${MAX_FILES_PER_NOTE} files. Add the rest as another note.`;
  }
  const tooBig = files.find((file) => file.bytes.length > MAX_FILE_BYTES);
  if (tooBig) {
    return `${tooBig.filename} is ${(tooBig.bytes.length / 1_048_576).toFixed(1)} MB, over the 10 MB limit.`;
  }
  return null;
}

/** The party, proven to be in this company. */
async function assertParty(scope: CompanyScope, party: PartyRef) {
  if ("customerId" in party) {
    const customer = await prisma.customer.findFirst({
      where: { id: party.customerId, companyId: scope.companyId },
      select: { id: true },
    });
    if (!customer) throw new PostingError("Customer not found in this company");
    return { customerId: customer.id };
  }
  const vendor = await prisma.vendor.findFirst({
    where: { id: party.vendorId, companyId: scope.companyId },
    select: { id: true },
  });
  if (!vendor) throw new PostingError("Not found in this company");
  return { vendorId: vendor.id };
}

export async function listNotes(scope: CompanyScope, party: PartyRef) {
  return prisma.partyNote.findMany({
    where: { companyId: scope.companyId, ...party },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      files: { orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function createNote(
  scope: CompanyScope,
  party: PartyRef,
  input: { body: string; files?: IncomingFile[] },
) {
  const refusal = whyNotANote(input);
  if (refusal) throw new PostingError(refusal);

  const link = await assertParty(scope, party);
  const files = input.files ?? [];

  // The row first, so the files have an id to be filed under. If an upload
  // then fails the whole thing is rolled back and the note never existed —
  // better than a note claiming attachments that are not there.
  const note = await prisma.partyNote.create({
    data: {
      companyId: scope.companyId,
      ...link,
      body: input.body.trim(),
      createdByUserId: scope.userId,
    },
  });

  try {
    for (const file of files) {
      const fileKey = storageKeys.partyNote(scope.companyId, note.id, file.filename);
      await withStorage("upload", () =>
        storage().put(fileKey, file.bytes, file.mimeType ?? undefined),
      );
      await prisma.partyNoteFile.create({
        data: {
          partyNoteId: note.id,
          fileKey,
          filename: file.filename,
          mimeType: file.mimeType ?? null,
          sizeBytes: file.bytes.length,
        },
      });
    }
  } catch (error) {
    await prisma.partyNote.delete({ where: { id: note.id } }).catch(() => {});
    throw error;
  }

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: "party_note.created",
    entityType: "PartyNote",
    entityId: note.id,
    summary: note.body.slice(0, 120),
    data: { ...link, files: files.map((file) => file.filename) },
  });

  return note;
}

/** The note, if this person is allowed to change it. */
async function editable(scope: CompanyScope, noteId: string) {
  const note = await prisma.partyNote.findFirst({
    where: { id: noteId, companyId: scope.companyId },
    include: { files: true },
  });
  if (!note) throw new PostingError("Note not found in this company");

  // Whoever wrote it, or an owner. A note is not an accounting entry, but it is
  // still somebody's words, and rewriting a colleague's is not a small thing.
  if (note.createdByUserId !== scope.userId && !scope.hasRole("OWNER")) {
    throw new PostingError("Only the person who wrote a note, or an owner, can change it");
  }
  return note;
}

export async function editNote(scope: CompanyScope, noteId: string, body: string) {
  const note = await editable(scope, noteId);

  const refusal = whyNotANote({ body });
  if (refusal) throw new PostingError(refusal);
  if (body.trim() === note.body) return note;

  const updated = await prisma.partyNote.update({
    where: { id: note.id },
    // createdAt and createdByUserId never move: the note still says when it was
    // written and by whom, and editedAt is what says it changed since.
    data: { body: body.trim(), editedAt: new Date() },
  });

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: "party_note.edited",
    entityType: "PartyNote",
    entityId: note.id,
    summary: updated.body.slice(0, 120),
    // The trail is append-only, so this is the only thing that will still know
    // what the note used to say.
    data: { was: note.body },
  });

  return updated;
}

export async function deleteNote(scope: CompanyScope, noteId: string) {
  const note = await editable(scope, noteId);

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: "party_note.deleted",
    entityType: "PartyNote",
    entityId: note.id,
    summary: note.body.slice(0, 120),
    data: { body: note.body, files: note.files.map((file) => file.filename) },
  });

  // The rows go by cascade; the bytes are ours to remove. Written before the
  // delete so a storage failure does not leave the row gone and the file behind.
  for (const file of note.files) {
    await withStorage("delete", () => storage().delete(file.fileKey)).catch(() => {
      // A file that will not delete must not strand the note it belongs to.
    });
  }

  await prisma.partyNote.delete({ where: { id: note.id } });
}

/** One attachment's bytes, scoped — used by the download route. */
export async function noteFile(scope: CompanyScope, fileId: string) {
  const file = await prisma.partyNoteFile.findFirst({
    where: { id: fileId, note: { companyId: scope.companyId } },
    include: { note: { select: { customerId: true, vendorId: true } } },
  });
  if (!file) return null;

  const bytes = await withStorage("download", () => storage().get(file.fileKey));
  return { file, bytes };
}

/** How many notes each of these parties has, for the list screens. */
export async function noteCounts(
  scope: CompanyScope,
  field: "customerId" | "vendorId",
  ids: string[],
) {
  if (ids.length === 0) return new Map<string, number>();

  const grouped = await prisma.partyNote.groupBy({
    by: [field],
    where: { companyId: scope.companyId, [field]: { in: ids } },
    _count: { _all: true },
  });

  return new Map(
    grouped
      .map((row) => [(row as Record<string, unknown>)[field] as string, row._count._all] as const)
      .filter(([id]) => Boolean(id)),
  );
}

export type NoteWithFiles = Prisma.PromiseReturnType<typeof listNotes>[number];
