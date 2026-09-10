"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { companyScope } from "@/lib/session-scope";
import { PostingError } from "@/lib/errors";
import { createNote, deleteNote, editNote, type IncomingFile, type PartyRef } from "@/lib/parties/notes";

/**
 * The note actions, written once for all three party screens.
 *
 * The alternative is the same three actions repeated on customers, vendors and
 * consultants, and three chances for one of them to drift on validation or on
 * where it sends you afterwards.
 */

function back(formData: FormData) {
  const value = String(formData.get("back") ?? "");
  // Only ever a path on this app: an absolute URL here would be an open
  // redirect wearing a form field.
  return value.startsWith("/") && !value.startsWith("//") ? value : "/customers";
}

function fail(to: string, message: string): never {
  redirect(`${to}${to.includes("?") ? "&" : "?"}noteError=${encodeURIComponent(message)}`);
}

function partyOf(formData: FormData): PartyRef {
  const customerId = String(formData.get("customerId") ?? "");
  const vendorId = String(formData.get("vendorId") ?? "");
  if (customerId) return { customerId };
  if (vendorId) return { vendorId };
  throw new PostingError("A note has to be about somebody");
}

async function filesOf(formData: FormData): Promise<IncomingFile[]> {
  const uploads = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
  const files: IncomingFile[] = [];
  for (const upload of uploads) {
    // An empty file input still submits an entry with size 0.
    if (!upload.name || upload.size === 0) continue;
    files.push({
      filename: upload.name,
      bytes: Buffer.from(await upload.arrayBuffer()),
      mimeType: upload.type || null,
    });
  }
  return files;
}

export async function addNote(formData: FormData) {
  const scope = await companyScope();
  const to = back(formData);

  try {
    await createNote(scope, partyOf(formData), {
      body: String(formData.get("body") ?? ""),
      files: await filesOf(formData),
    });
  } catch (error) {
    if (error instanceof PostingError) fail(to, error.message);
    throw error;
  }

  revalidatePath(to);
  redirect(`${to}${to.includes("?") ? "&" : "?"}noteSaved=1`);
}

export async function saveNote(formData: FormData) {
  const scope = await companyScope();
  const to = back(formData);

  try {
    await editNote(scope, String(formData.get("noteId") ?? ""), String(formData.get("body") ?? ""));
  } catch (error) {
    if (error instanceof PostingError) fail(to, error.message);
    throw error;
  }

  revalidatePath(to);
  redirect(`${to}${to.includes("?") ? "&" : "?"}noteSaved=1`);
}

export async function removeNote(formData: FormData) {
  const scope = await companyScope();
  const to = back(formData);

  try {
    await deleteNote(scope, String(formData.get("noteId") ?? ""));
  } catch (error) {
    if (error instanceof PostingError) fail(to, error.message);
    throw error;
  }

  revalidatePath(to);
  redirect(to);
}
