"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { useLinkStatus } from "next/link";
import { useFormStatus } from "react-dom";

/**
 * The button, with a pending state (SPEC §3).
 *
 * Server actions leave the page fully interactive while they run, so a click
 * that takes four seconds looked exactly like a click that did nothing. People
 * pressed again. On a form that posts to the ledger, pressing again is not a
 * cosmetic problem.
 *
 * Two hooks, because a button here does one of two things and both can be slow:
 *
 *   `useFormStatus` is true while the enclosing form's action runs — saving a
 *   document, sending a batch of work orders.
 *
 *   `useLinkStatus` is true while a `<Link>` this button sits inside is
 *   navigating. Outside a Link it is a plain context read with an idle default,
 *   so it costs nothing on the buttons that are not links. It stays false for a
 *   route already prefetched, which is correct: that navigation is instant and
 *   a spinner would flicker for no reason.
 *
 * While busy the button shows a spinner, says so to a screen reader, and turns
 * the pointer into the system's wait cursor — including over the rest of the
 * page, which is the part that makes a slow save feel like something happening
 * rather than something broken.
 */

function Spinner() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-3.5 shrink-0 animate-spin"
      fill="none"
    >
      {/* The faint ring is the track; the bright arc is what reads as motion. */}
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M8 1.5A6.5 6.5 0 0 1 14.5 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Button({
  variant = "primary",
  className = "",
  children,
  onClick,
  disabled,
  ...props
}: ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  const form = useFormStatus();
  const link = useLinkStatus();

  // Which button was pressed. A form can hold several submits — "Save" beside
  // "Save and approve" — and `useFormStatus` is true on all of them at once.
  // Without this every button in the form spins and none of them says which
  // action is actually running.
  //
  // Cleared during render rather than in an effect. This is React's documented
  // way to adjust state when something it derives from changes: an effect would
  // paint one frame with a stale spinner first, and would have to be exempted
  // from the lint rule that exists to prevent exactly that.
  const [pressed, setPressed] = useState(false);
  const [wasPending, setWasPending] = useState(form.pending);
  if (wasPending !== form.pending) {
    setWasPending(form.pending);
    if (!form.pending) setPressed(false);
  }

  const busy = (form.pending && pressed) || link.pending;

  // Disabled for the whole form, not just the pressed button: once an action is
  // running, a second one started from the same form is a duplicate posting.
  // Safe to apply here because `pending` only turns true after submission has
  // begun, so this never blocks the first click.
  const blocked = disabled || form.pending || link.pending;

  useBusyCursor(busy);

  const styles = {
    primary:
      "bg-brand-600 text-white hover:bg-brand-700 dark:bg-brand-600 dark:text-white dark:hover:bg-brand-500",
    secondary:
      "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800",
    danger: "bg-red-600 text-white hover:bg-red-700",
    ghost:
      "text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-brand-400",
  }[variant];

  return (
    <button
      {...props}
      onClick={(event) => {
        setPressed(true);
        onClick?.(event);
      }}
      disabled={blocked}
      aria-busy={busy || undefined}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:pointer-events-none ${
        // A spinning button is working, not unavailable. Dimming it to the
        // usual disabled 50% says the opposite of what is happening.
        busy ? "cursor-wait opacity-100" : "disabled:opacity-50"
      } ${TOUCH_TARGET} ${styles} ${className}`}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

const TOUCH_TARGET = "[@media(pointer:coarse)]:min-h-11";

/**
 * Put the whole page under the wait cursor while something is running.
 *
 * Counted rather than set and cleared, because two things can be in flight at
 * once — a navigation starting while a save finishes — and the one that ends
 * first must not take the cursor back while the other is still going.
 */
let busyCount = 0;

function setBusyAttribute(busy: boolean) {
  busyCount = Math.max(0, busyCount + (busy ? 1 : -1));
  const root = document.documentElement;
  if (busyCount > 0) root.setAttribute("data-busy", "");
  else root.removeAttribute("data-busy");
}

function useBusyCursor(busy: boolean) {
  useEffect(() => {
    if (!busy) return;
    setBusyAttribute(true);
    // The cleanup runs when the action finishes *and* if the button unmounts
    // mid-flight — which is the common case, since a successful action usually
    // redirects and takes this button with it. Without it the cursor would
    // stay spinning on the page that replaced it.
    return () => setBusyAttribute(false);
  }, [busy]);
}
