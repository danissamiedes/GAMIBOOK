"use client";

import {
  useCallback,
  useRef,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";

/**
 * Keyboard handling shared by the document and journal line editors
 * (SPEC §8.1: "make the line editor fast: keyboard-navigable, add-row on Tab
 * from the last field, running total visible").
 *
 * Both editors already appended a row on Tab, but the row appeared *after* the
 * browser had moved focus, so it landed on the delete button and the typist
 * still reached for the mouse — the shortcut existed without doing its job.
 * Here the state update is flushed synchronously, so focus can be placed in
 * the new row's first field before the keystroke finishes.
 *
 * The handler sits on the wrapper and reads the row out of the event target,
 * so a new column needs no wiring and cannot be forgotten.
 */
export function useLineGrid<T>(options: {
  setLines: Dispatch<SetStateAction<T[]>>;
  blank: () => T;
  /** Rows below this many are never removed: a journal entry needs two. */
  minLines: number;
}) {
  const { setLines, blank, minLines } = options;
  const gridRef = useRef<HTMLDivElement>(null);

  const rows = useCallback(
    () => Array.from(gridRef.current?.querySelectorAll("tbody tr") ?? []),
    [],
  );

  const fieldsIn = (row: Element) =>
    Array.from(
      row.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        "input:not([type='hidden']), select, textarea",
      ),
    ).filter((field) => !field.disabled);

  const focusRow = useCallback(
    (index: number, position: "first" | "last" = "first") => {
      const row = rows()[index];
      if (!row) return;
      const fields = fieldsIn(row);
      const field =
        position === "first" ? fields[0] : fields[fields.length - 1];
      field?.focus();
      if (field instanceof HTMLInputElement) field.select();
    },
    [rows],
  );

  const addRow = useCallback(() => {
    // flushSync so the row exists in the DOM before we try to focus it.
    let index = 0;
    flushSync(() => {
      setLines((current) => {
        index = current.length;
        return [...current, blank()];
      });
    });
    focusRow(index);
  }, [blank, focusRow, setLines]);

  const removeRow = useCallback(
    (index: number) => {
      let removed = false;
      flushSync(() => {
        setLines((current) => {
          if (current.length <= minLines) return current;
          removed = true;
          return current.filter((_, i) => i !== index);
        });
      });
      if (removed) focusRow(Math.max(0, index - 1));
    },
    [focusRow, minLines, setLines],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      // Buttons keep their own Enter and Space behaviour.
      if (target.tagName === "BUTTON") return;

      const row = target.closest("tr");
      if (!row) return;
      const all = rows();
      const index = all.indexOf(row);
      if (index < 0) return;
      const isLastRow = index === all.length - 1;

      if (
        (event.metaKey || event.ctrlKey) &&
        (event.key === "Backspace" || event.key === "Delete")
      ) {
        event.preventDefault();
        removeRow(index);
        return;
      }

      if (event.key === "Enter") {
        // Without this, Enter submits the document halfway through typing its
        // lines — the most expensive keystroke on the screen.
        event.preventDefault();
        if (isLastRow) addRow();
        else focusRow(index + 1);
        return;
      }

      if (event.key === "Tab" && !event.shiftKey && isLastRow) {
        const fields = fieldsIn(row);
        if (fields[fields.length - 1] === target) {
          event.preventDefault();
          addRow();
        }
      }
    },
    [addRow, focusRow, removeRow, rows],
  );

  return { gridProps: { ref: gridRef, onKeyDown }, addRow, removeRow };
}

export const LINE_GRID_HINT =
  "Tab from the last field adds a line · Enter moves down · Ctrl/⌘ + Backspace removes a line";
