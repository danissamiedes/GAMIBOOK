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

  /**
   * Put the cursor back where it was, one row along.
   *
   * Moving a row with the keyboard and losing your place in it defeats the
   * point: the typist is mid-edit, and the whole value of Alt+Arrow is that
   * they do not have to find the field again.
   */
  const focusCell = useCallback(
    (rowIndex: number, column: number) => {
      const row = rows()[rowIndex];
      if (!row) return;
      const fields = fieldsIn(row);
      const field = fields[Math.min(Math.max(column, 0), fields.length - 1)];
      field?.focus();
      if (field instanceof HTMLInputElement) field.select();
    },
    [rows],
  );

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

  /**
   * Reorder, because the order of lines on a document is information.
   *
   * A work order listing shifts by date, an invoice grouping charges the way
   * the customer thinks about them — and the rows arrive in whatever order a
   * spreadsheet import or a day's typing produced. Rebuilding four rows to move
   * one is the kind of work people stop doing, and then the document reads
   * wrongly forever.
   *
   * Out-of-range targets are ignored rather than clamped: the caller asking to
   * move the top row up has nothing to do, and silently moving something else
   * would be worse than nothing.
   */
  const moveRow = useCallback(
    (from: number, to: number) => {
      // Where the cursor is now, so it can travel with the row.
      const active = document.activeElement;
      const row = rows()[from];
      const column =
        active && row?.contains(active)
          ? fieldsIn(row).indexOf(active as HTMLInputElement | HTMLSelectElement)
          : -1;

      let moved = false;
      flushSync(() => {
        setLines((current) => {
          if (from === to || to < 0 || to >= current.length) return current;
          moved = true;
          const next = [...current];
          const [line] = next.splice(from, 1);
          next.splice(to, 0, line);
          return next;
        });
      });
      if (moved && column >= 0) focusCell(to, column);
    },
    [focusCell, rows, setLines],
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

      // Alt+Arrow moves the row itself. Plain arrows still move the cursor
      // inside a field, which is what anyone typing a number expects.
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        moveRow(index, event.key === "ArrowUp" ? index - 1 : index + 1);
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
    [addRow, focusRow, moveRow, removeRow, rows],
  );

  return { gridProps: { ref: gridRef, onKeyDown }, addRow, removeRow, moveRow };
}

export const LINE_GRID_HINT =
  "Tab from the last field adds a line · Enter moves down · Alt + ↑/↓ moves a line · Ctrl/⌘ + Backspace removes a line";
