"use client";

import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * The grip you drag a line by (SPEC §8.1).
 *
 * The handle is separate from the row on purpose. Rows here are full of text
 * fields, and a row that moved when somebody tried to select a word in it would
 * be unusable — so the drag starts here and nowhere else.
 *
 * `touch-none` is load-bearing: without it a drag on a touchscreen scrolls the
 * page instead of moving the row.
 *
 * Dragging is not the only way. Alt+↑/↓ moves the row under the cursor, which
 * is both the faster way for anyone already typing and the one that works
 * without a pointer at all; the hint under the grid says so.
 */
export function RowGrip({
  index,
  count,
  dragging,
  handleProps,
  label = "line",
}: {
  index: number;
  count: number;
  /** True while this row is the one being dragged. */
  dragging: boolean;
  handleProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
  };
  label?: string;
}) {
  if (count < 2) return null;

  return (
    <span
      {...handleProps}
      role="button"
      // Not a Tab stop: tabbing through a document should walk the fields, and
      // the keyboard has Alt+Arrow for this.
      tabIndex={-1}
      aria-label={`Drag to reorder ${label} ${index + 1}, or use Alt with the arrow keys`}
      title="Drag to reorder"
      className={`inline-flex h-7 w-5 touch-none select-none items-center justify-center rounded align-middle transition-colors ${
        dragging
          ? "cursor-grabbing bg-brand-100 text-brand-700 dark:bg-slate-700 dark:text-brand-300"
          : "cursor-grab text-slate-300 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
      }`}
    >
      <svg viewBox="0 0 10 16" className="h-4 w-2.5" aria-hidden="true">
        <g fill="currentColor">
          <circle cx="2.5" cy="3" r="1.3" />
          <circle cx="7.5" cy="3" r="1.3" />
          <circle cx="2.5" cy="8" r="1.3" />
          <circle cx="7.5" cy="8" r="1.3" />
          <circle cx="2.5" cy="13" r="1.3" />
          <circle cx="7.5" cy="13" r="1.3" />
        </g>
      </svg>
    </span>
  );
}
