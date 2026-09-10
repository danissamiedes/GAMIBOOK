import { Fragment } from "react";
import Link from "next/link";
import { formatStampInZone } from "@/lib/time/zone";
import { listNotes, MAX_FILES_PER_NOTE, type PartyRef } from "@/lib/parties/notes";
import { addNote, removeNote, saveNote } from "@/app/(app)/party-notes/actions";
import { Alert, Button, Card, DataTable } from "@/components/ui";
import type { CompanyScope } from "@/lib/company-scope";

/** Bytes as something a person reads. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** The first line, or the first hundred characters — whichever comes first. */
function preview(body: string): string {
  const line = body.split("\n")[0].trim();
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/**
 * Notes on a customer, vendor or consultant (SPEC §15).
 *
 * A table, because a note has facts worth lining up — when, who, and what it
 * says — and a stack of paragraphs makes those impossible to scan. The full
 * text, the attachments and the edit and delete buttons live in a row that
 * opens underneath the one you clicked.
 *
 * Opening is a link to `?note=<id>` rather than a client component: the server
 * already re-renders on every action here, one open row is the whole state, and
 * this way it works with JavaScript off and survives a refresh.
 */
export async function PartyNotes({
  scope,
  party,
  back,
  timeZone,
  openNoteId,
  saved,
  error,
}: {
  scope: CompanyScope;
  party: PartyRef;
  /** This page, for the actions to return to. */
  back: string;
  /** The company's operating zone: note stamps are rendered in it. */
  timeZone: string;
  /** The row expanded right now, from `?note=`. */
  openNoteId?: string;
  saved?: boolean;
  error?: string;
}) {
  const notes = await listNotes(scope, party);
  const hidden =
    "customerId" in party
      ? { name: "customerId", value: party.customerId }
      : { name: "vendorId", value: party.vendorId };

  const rowHref = (noteId: string) =>
    `${back}${openNoteId === noteId ? "" : `?note=${noteId}`}`;

  return (
    <Card>
      <p className="mb-3 text-xs text-slate-500">
        What was said or agreed, and the paperwork that goes with it. Nothing here posts.
      </p>

      {error ? <Alert tone="error">{decodeURIComponent(error)}</Alert> : null}
      {saved ? <Alert tone="success">Note saved.</Alert> : null}

      {notes.length === 0 ? (
        <p className="mb-5 text-sm text-slate-500">Nothing written down yet.</p>
      ) : (
        <div className="mb-5">
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Date created</th>
                <th className="py-2">Created by</th>
                <th className="py-2">Note preview</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((note) => {
                const open = openNoteId === note.id;
                const mine = note.createdByUserId === scope.userId || scope.hasRole("OWNER");
                return (
                  // Keyed here, not on the rows: the fragment is what the list
                  // holds, and React only sees the key on its direct child.
                  <Fragment key={note.id}>
                    <tr className="border-b border-slate-100 align-top dark:border-slate-800/60">
                      <td className="whitespace-nowrap py-2 text-sm">
                        {formatStampInZone(note.createdAt, timeZone)}
                        {note.editedAt ? (
                          <span className="block text-xs text-slate-500">edited</span>
                        ) : null}
                      </td>
                      <td className="py-2 text-sm">
                        {note.createdBy?.name ?? note.createdBy?.email ?? "—"}
                      </td>
                      <td className="py-2 text-sm">
                        <Link
                          href={rowHref(note.id)}
                          className="underline decoration-dotted underline-offset-2"
                        >
                          {preview(note.body)}
                        </Link>
                        {note.files.length > 0 ? (
                          <span className="ml-2 text-xs text-slate-500">
                            {note.files.length} file{note.files.length === 1 ? "" : "s"}
                          </span>
                        ) : null}
                      </td>
                    </tr>

                    {open ? (
                      <tr className="border-b border-slate-100 dark:border-slate-800/60">
                        <td colSpan={3} className="bg-slate-50 px-3 py-3 dark:bg-slate-900/40">
                          <p className="whitespace-pre-wrap text-sm">{note.body}</p>

                          {note.files.length > 0 ? (
                            <ul className="mt-3 space-y-1">
                              {note.files.map((file) => (
                                <li key={file.id} className="text-sm">
                                  <a
                                    className="underline decoration-dotted underline-offset-2"
                                    href={`/party-notes/${file.id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {file.filename}
                                  </a>
                                  <span className="ml-2 text-xs text-slate-500">
                                    {size(file.sizeBytes)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          ) : null}

                          {mine ? (
                            <div className="mt-3 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
                              <form action={saveNote} className="space-y-2">
                                <input type="hidden" name="noteId" value={note.id} />
                                <input type="hidden" name="back" value={back} />
                                <textarea
                                  name="body"
                                  rows={4}
                                  defaultValue={note.body}
                                  required
                                  aria-label="Edit note"
                                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
                                />
                                <Button type="submit" variant="secondary">
                                  Save changes
                                </Button>
                              </form>
                              <form action={removeNote}>
                                <input type="hidden" name="noteId" value={note.id} />
                                <input type="hidden" name="back" value={back} />
                                <Button type="submit" variant="danger">
                                  Delete this note
                                  {note.files.length > 0
                                    ? ` and its ${note.files.length} file(s)`
                                    : ""}
                                </Button>
                              </form>
                            </div>
                          ) : null}

                          <p className="mt-3">
                            <Link href={back} className="text-xs text-slate-500 underline">
                              Close
                            </Link>
                          </p>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </DataTable>
        </div>
      )}

      <form action={addNote} className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-700">
        <input type="hidden" name={hidden.name} value={hidden.value} />
        <input type="hidden" name="back" value={back} />
        <label className="block text-sm">
          <span className="mb-1 block font-medium">New note</span>
          <textarea
            name="body"
            rows={3}
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Attach files</span>
          <input
            type="file"
            name="files"
            multiple
            className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
          />
          <span className="mt-1 block text-xs text-slate-500">
            Up to {MAX_FILES_PER_NOTE} files, 10 MB each. Optional.
          </span>
        </label>
        <Button type="submit">Save note</Button>
      </form>
    </Card>
  );
}
