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
}: ComponentProps<"button"> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  const styles = {
    primary: "bg-slate-900 text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white",
    secondary:
      "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800",
    danger: "bg-red-600 text-white hover:bg-red-700",
    ghost: "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${TOUCH_TARGET} ${styles} ${className}`}
    />
  );
}

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={`h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 ${TOUCH_TARGET} ${className}`}
    />
  );
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={`h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 ${TOUCH_TARGET} ${className}`}
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
      <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-slate-500 dark:text-slate-400">{hint}</span> : null}
    </label>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      // min-w-0 because a card is a container, never a source of width. As a
      // grid or flex item it otherwise defaults to min-width:auto and refuses
      // to shrink below its widest child — so a scrollable table inside it
      // pushed the whole page sideways on a phone instead of scrolling.
      className={`min-w-0 rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">{title}</h1>
      {description ? (
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{description}</p>
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
    error: "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200",
    success:
      "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200",
    warning:
      "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
  }[tone];
  return <div className={`rounded-md border px-3 py-2 text-sm ${styles}`}>{children}</div>;
}

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
    >
      {children}
    </Link>
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
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {children ? (
        <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">{children}</div>
      ) : null}
      {action ? (
        <Link href={action.href} className="mt-4 inline-block">
          <Button variant="secondary">{action.label}</Button>
        </Link>
      ) : null}
    </div>
  );
}
