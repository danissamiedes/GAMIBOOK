import { formatAccountingDate } from "@/lib/dates";
import { listNotes, MAX_FILES_PER_NOTE, type PartyRef } from "@/lib/parties/notes";
import { addNote, removeNote, saveNote } from "@/app/(app)/party-notes/actions";
import { Alert, Button, Card } from "@/components/ui";
import type { CompanyScope } from "@/lib/company-scope";

/** Bytes as something a person reads. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Notes on a customer, vendor or consultant (SPEC §15).
 *
 * One server component so the three party pages get the same thing by
 * rendering one tag. Each note keeps the date it was written and who wrote it;
 * editing changes the text and says "edited", and never rewrites either.
 *
 * The edit form is a `<details>` rather than a dialog: several notes may be
 * open at once, they are ordinary text, and nothing here needs a modal's focus
 * trap. It also means the whole panel works with JavaScript off.
 */
export async function PartyNotes({
  scope,
  party,
  back,
  saved,
  error,
}: {
  scope: CompanyScope;
  party: PartyRef;
  /** This page, for the actions to return to. */
  back: string;
  saved?: boolean;
  error?: string;
}) {
  const notes = await listNotes(scope, party);
  const hidden =
    "customerId" in party
      ? { name: "customerId", value: party.customerId }
      : { name: "vendorId", value: party.vendorId };

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold">Notes</h2>
      <p className="mb-3 text-xs text-slate-500">
        What was said or agreed, and the paperwork that goes with it. Nothing here posts.
      </p>

      {error ? <Alert tone="error">{decodeURIComponent(error)}</Alert> : null}
      {saved ? <Alert tone="success">Note saved.</Alert> : null}

      <form action={addNote} className="mb-5 space-y-2">
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

      {notes.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing written down yet.</p>
      ) : (
        <ul className="space-y-4">
          {notes.map((note) => {
            const mine = note.createdByUserId === scope.userId || scope.hasRole("OWNER");
            return (
              <li
                key={note.id}
                className="border-t border-slate-100 pt-3 first:border-0 first:pt-0 dark:border-slate-800/60"
              >
                <p className="text-xs text-slate-500">
                  {formatAccountingDate(note.createdAt)}
                  {" · "}
                  {note.createdBy?.name ?? note.createdBy?.email ?? "somebody since removed"}
                  {note.editedAt ? " · edited" : ""}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{note.body}</p>

                {note.files.length > 0 ? (
                  <ul className="mt-2 space-y-1">
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
                        <span className="ml-2 text-xs text-slate-500">{size(file.sizeBytes)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {mine ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                      Edit or delete
                    </summary>
                    <form action={saveNote} className="mt-2 space-y-2">
                      <input type="hidden" name="noteId" value={note.id} />
                      <input type="hidden" name="back" value={back} />
                      <textarea
                        name="body"
                        rows={3}
                        defaultValue={note.body}
                        required
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
                      />
                      <Button type="submit" variant="secondary">
                        Save changes
                      </Button>
                    </form>
                    <form action={removeNote} className="mt-2">
                      <input type="hidden" name="noteId" value={note.id} />
                      <input type="hidden" name="back" value={back} />
                      <Button type="submit" variant="danger">
                        Delete this note
                        {note.files.length > 0 ? ` and its ${note.files.length} file(s)` : ""}
                      </Button>
                    </form>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
