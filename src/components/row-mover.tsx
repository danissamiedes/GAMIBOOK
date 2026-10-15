"use client";

/**
 * The up and down controls on a line (SPEC §8.1).
 *
 * The keyboard already moves a row with Alt+Arrow, and that is the fast way —
 * but a shortcut nobody has been told about is not a feature, and a bookkeeper
 * rearranging a work order on a laptop trackpad should not have to know it.
 * These are the discoverable half of the same operation.
 *
 * Deliberately small and quiet: they sit on every row of a document that may
 * have thirty of them, so they have to be reachable without becoming the
 * loudest thing on the screen. They are disabled at the ends rather than
 * hidden, so the column does not jump as rows move.
 */
export function RowMover({
  index,
  count,
  onMove,
  label = "line",
}: {
  index: number;
  count: number;
  /** Called with the row's new position. */
  onMove: (from: number, to: number) => void;
  /** What a row is called here, for the screen-reader label. */
  label?: string;
}) {
  if (count < 2) return null;

  const arrow = (direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    const disabled = target < 0 || target >= count;
    return (
      <button
        type="button"
        // tabIndex -1: Tab through a document should walk the fields, not stop
        // twice a row at controls the keyboard already has a shortcut for.
        tabIndex={-1}
        disabled={disabled}
        aria-label={`Move ${label} ${index + 1} ${direction}`}
        onClick={() => onMove(index, target)}
        className="flex h-4 w-5 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-25 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        <svg viewBox="0 0 10 6" className="h-2 w-2.5" aria-hidden="true">
          <path
            d={direction === "up" ? "M1 5 5 1l4 4" : "M1 1l4 4 4-4"}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    );
  };

  return (
    <span className="inline-flex flex-col items-center gap-0.5 align-middle">
      {arrow("up")}
      {arrow("down")}
    </span>
  );
}
