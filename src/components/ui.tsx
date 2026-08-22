import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * A deliberately small set of primitives in the shadcn/ui idiom (Tailwind
 * utility classes, no runtime dependency). Financial screens need dense,
 * legible, keyboard-friendly controls more than they need a component library.
 *
 * Density is right for a mouse and wrong for a thumb, so every control grows to
 * 44px on a touch device — the size accessibility guidance settles on — while
 * staying at 36px for the bookkeeper doing data entry all day (SPEC §3: the web
 * UI must be usable on a phone browser). One media query rather than a
 * phone-specific variant of each control.
 */
const TOUCH_TARGET = "[@media(pointer:coarse)]:min-h-11";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
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
      className={`inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:pointer-events-none disabled:opacity-50 ${TOUCH_TARGET} ${styles} ${className}`}
    />
  );
}

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={`h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-brand-950 ${TOUCH_TARGET} ${className}`}
    />
  );
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={`h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-brand-950 ${TOUCH_TARGET} ${className}`}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="block text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function Card({
  children,
  tone = "default",
  className = "",
}: {
  children: ReactNode;
  /**
   * "muted" is for the panel beside the content rather than the content
   * itself — the form you type a new record into, sitting next to the list of
   * records. A light grey ground separates the two jobs without a heading or a
   * rule, so the eye lands on the register first and the form reads as a tool
   * off to the side.
   */
  tone?: "default" | "muted";
  className?: string;
}) {
  const ground =
    tone === "muted"
      ? "border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-800/40"
      : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900";
  return (
    <div
      // min-w-0 because a card is a container, never a source of width. As a
      // grid or flex item it otherwise defaults to min-width:auto and refuses
      // to shrink below its widest child — so a scrollable table inside it
      // pushed the whole page sideways on a phone instead of scrolling.
      className={`min-w-0 rounded-lg border p-5 ${ground} ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">
        {title}
      </h1>
      {description ? (
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function Alert({
  tone = "info",
  children,
}: {
  tone?: "info" | "error" | "success" | "warning";
  children: ReactNode;
}) {
  const styles = {
    info: "border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-100",
    error:
      "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200",
    success:
      "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200",
    warning:
      "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
  }[tone];
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${styles}`}>
      {children}
    </div>
  );
}


/**
 * A table that scrolls inside itself instead of stretching the page.
 *
 * A financial table has as many columns as the document has facts, and on a
 * phone that is always wider than the screen. Left bare, the whole page scrolls
 * sideways and takes the nav and the headings with it — the failure SPEC §3
 * rules out with "the web UI MUST be usable on a phone browser". Every list and
 * report table goes through here so no screen can quietly opt out.
 */
export function DataTable({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-sm ${className}`}>{children}</table>
    </div>
  );
}

/**
 * An empty screen should say what to do next, not just report the absence.
 * `action` is the way out of the empty state — the button the reader would
 * otherwise have to go looking for.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
        {title}
      </p>
      {children ? (
        <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {children}
        </div>
      ) : null}
      {action ? (
        <Link href={action.href} className="mt-4 inline-block">
          <Button variant="secondary">{action.label}</Button>
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Page controls for a list. Always states the total, even on a single page:
 * "200 invoices" and "1–200 of 3,400 invoices" look identical without it, and
 * only one of them means you are seeing everything.
 */
export function Pagination({
  summary,
  previousHref,
  nextHref,
}: {
  summary: {
    label: string;
    hasPrevious: boolean;
    hasNext: boolean;
    pages: number;
    total: number;
  };
  previousHref: string;
  nextHref: string;
}) {
  if (summary.total === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600 dark:text-slate-400">
      <span>{summary.label}</span>
      {summary.pages > 1 ? (
        <span className="flex items-center gap-2">
          {summary.hasPrevious ? (
            <Link href={previousHref}>
              <Button variant="secondary">Previous</Button>
            </Link>
          ) : null}
          {summary.hasNext ? (
            <Link href={nextHref}>
              <Button variant="secondary">Next</Button>
            </Link>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
