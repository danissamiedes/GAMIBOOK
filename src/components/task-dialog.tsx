"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";

export type Assignable = { id: string; name: string | null; email: string };

/**
 * "Add task" — a button and the pop-out it opens.
 *
 * A native `<dialog>` rather than a hand-built overlay: the browser already
 * gives focus trapping, Escape to close, inert background and the top layer,
 * and every one of those is a thing a bespoke modal gets subtly wrong.
 *
 * The form's action is a server action passed in from the page, so this stays a
 * shell with no knowledge of what saving means. Submitting closes it
 * optimistically — the action redirects, and leaving the dialog up over the
 * reloaded page would look like nothing had happened.
 *
 * With JavaScript off the button cannot open anything, so the `<noscript>`
 * points at the Tasks screen, where the same form exists on its own page.
 */
export function TaskDialog({
  action,
  users,
  back,
  link,
  defaultAssigneeId,
  today,
  label = "Add task",
  title,
  autoOpen = false,
  hideTrigger = false,
}: {
  action: (formData: FormData) => void | Promise<void>;
  users: Assignable[];
  /** Where to return after saving — the page this was opened from. */
  back: string;
  /** The document this task is about: one { field: id } pair, or nothing. */
  link?: Record<string, string>;
  defaultAssigneeId?: string | null;
  /** yyyy-mm-dd, so the date input opens on the right month. */
  today: string;
  label?: string;
  /** What the pop-out calls itself, e.g. "Task on WO1013". */
  title?: string;
  /**
   * Open on arrival. A list screen renders one dialog for the whole table and
   * each row is a link that names its document, rather than a dialog per row —
   * two hundred hidden forms to make one of them reachable is not a trade worth
   * making.
   */
  autoOpen?: boolean;
  /** For that list-screen dialog, which has no button of its own. */
  hideTrigger?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!autoOpen || !element) return;
    // The server renders `open` so the form is still there with JavaScript off,
    // and showModal() throws InvalidStateError on a dialog that is already
    // open. Close it first: what we want is the modal, not the inline copy.
    if (element.open) element.close();
    element.showModal();
  }, [autoOpen]);

  return (
    <>
      {hideTrigger ? null : (
        <>
          <button
            type="button"
            onClick={() => dialog.current?.showModal()}
            className="inline-flex h-9 items-center rounded-md border border-brand-600 px-3 text-sm font-medium text-brand-700 hover:bg-brand-50 dark:border-brand-400 dark:text-brand-300 dark:hover:bg-slate-800"
          >
            {label}
          </button>
          <noscript>
            <Link className="ml-2 text-sm underline" href="/tasks">
              Tasks
            </Link>
          </noscript>
        </>
      )}

      <dialog
        ref={dialog}
        open={autoOpen ? true : undefined}
        className="w-[min(32rem,92vw)] rounded-lg border border-slate-200 bg-white p-0 text-slate-900 backdrop:bg-slate-900/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      >
        <form
          action={action}
          onSubmit={() => dialog.current?.close()}
          className="space-y-4 p-5"
        >
          <div>
            <h2 className="text-base font-semibold">{title ?? "New task"}</h2>
            <p className="mt-1 text-xs text-slate-500">
              Created {today}. Nothing here posts to the ledger.
            </p>
          </div>

          <input type="hidden" name="back" value={back} />
          {Object.entries(link ?? {}).map(([field, id]) => (
            <input key={field} type="hidden" name={field} value={id} />
          ))}

          <label className="block text-sm">
            <span className="mb-1 block font-medium">Subject</span>
            <input
              name="subject"
              required
              maxLength={200}
              autoFocus
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium">Note</span>
            <textarea
              name="note"
              rows={4}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
            />
          </label>

          <div className="flex flex-wrap gap-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Due</span>
              <input
                type="date"
                name="dueDate"
                className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
              />
            </label>

            <label className="block text-sm">
              <span className="mb-1 block font-medium">Priority</span>
              <select
                name="priority"
                defaultValue="NORMAL"
                className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
              >
                <option value="LOW">Low</option>
                <option value="NORMAL">Normal</option>
                <option value="HIGH">High</option>
              </select>
            </label>

            <label className="block flex-1 text-sm">
              <span className="mb-1 block font-medium">Assigned to</span>
              <select
                name="assignedUserId"
                defaultValue={defaultAssigneeId ?? ""}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
              >
                <option value="">Nobody in particular</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name ?? user.email}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="inline-flex h-9 items-center rounded-md px-3 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="inline-flex h-9 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
            >
              Save task
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
