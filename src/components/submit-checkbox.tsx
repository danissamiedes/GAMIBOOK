"use client";

/**
 * A checkbox that submits its form the moment it is toggled.
 *
 * Ticking a line on a bank statement is the whole interaction on that screen —
 * a hundred of them in a sitting — so it has to be one click on the thing that
 * looks like the answer, not a button that describes it.
 *
 * The value posted is the hidden `cleared` field beside it, not this input:
 * an unchecked checkbox submits nothing at all, so a form relying on its own
 * name could say "tick" but never "untick".
 *
 * `<noscript>` keeps it usable with JavaScript off, where `requestSubmit` never
 * runs — the checkbox alone would silently do nothing.
 *
 * On a touch screen it grows in both axes rather than taking the shared
 * TOUCH_TARGET min-height, which would stretch a square control into a
 * rectangle that no longer reads as a checkbox.
 */
export function SubmitCheckbox({
  checked,
  label,
}: {
  checked: boolean;
  /** What this row is, for a screen reader — the header alone says "on statement". */
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="checkbox"
        aria-label={label}
        defaultChecked={checked}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 dark:border-slate-600 [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6"
      />
      <noscript>
        <button
          type="submit"
          className="rounded border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-700"
        >
          {checked ? "Untick" : "Tick"}
        </button>
      </noscript>
    </span>
  );
}
