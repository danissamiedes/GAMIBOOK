"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { companyScope } from "@/lib/session-scope";
import { PostingError } from "@/lib/errors";
import { parseAccountingDate } from "@/lib/dates";
import { DOCUMENT_LINKS, createTask, setTaskStatus, type DocumentLink } from "@/lib/tasks";

/**
 * The task actions, defined once and passed to whichever screen needs them.
 *
 * Every document page offers the same dialog, so the alternative is the same
 * server action written out six times — and six chances for one of them to
 * drift on validation or on where it sends you afterwards.
 */

const PRIORITIES = ["LOW", "NORMAL", "HIGH"] as const;

export async function addTask(formData: FormData) {
  const scope = await companyScope();

  const link: Partial<Record<DocumentLink, string>> = {};
  for (const field of DOCUMENT_LINKS) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) link[field] = value;
  }

  const priority = String(formData.get("priority") ?? "NORMAL");
  // `back` is where the dialog was opened from, so finishing returns you to the
  // document rather than to a task list you did not ask for.
  const back = String(formData.get("back") ?? "/tasks");

  try {
    await createTask(scope, {
      subject: String(formData.get("subject") ?? ""),
      note: String(formData.get("note") ?? ""),
      dueDate: parseAccountingDate(String(formData.get("dueDate") ?? "")),
      priority: (PRIORITIES as readonly string[]).includes(priority)
        ? (priority as (typeof PRIORITIES)[number])
        : "NORMAL",
      assignedUserId: String(formData.get("assignedUserId") ?? "") || null,
      link,
    });
  } catch (error) {
    if (error instanceof PostingError) {
      redirect(`${back}${back.includes("?") ? "&" : "?"}taskError=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  // The document pages list their own tasks, and the Tasks screen lists them
  // all, so both have to be told.
  revalidatePath(back);
  revalidatePath("/tasks");
  redirect(`${back}${back.includes("?") ? "&" : "?"}taskSaved=1`);
}

export async function toggleTask(formData: FormData) {
  const scope = await companyScope();
  const taskId = String(formData.get("taskId") ?? "");
  const next = String(formData.get("next") ?? "COMPLETED") === "OPEN" ? "OPEN" : "COMPLETED";
  const back = String(formData.get("back") ?? "/tasks");

  try {
    await setTaskStatus(scope, taskId, next);
  } catch (error) {
    if (error instanceof PostingError) {
      redirect(`${back}${back.includes("?") ? "&" : "?"}taskError=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  revalidatePath(back);
  revalidatePath("/tasks");
  redirect(back);
}
