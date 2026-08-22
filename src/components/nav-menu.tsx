"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

export type NavItem = { href: string; label: string };
/** A group with no items is a plain link — Dashboard is the only one. */
export type NavGroup = { label: string; href?: string; items: NavItem[] };

/**
 * The header navigation, grouped.
 *
 * Thirty links across three wrapped rows is not navigation, it is a list. The
 * grouping is the customer's own, and follows how the work is actually
 * organised rather than how the routes are.
 *
 * Groups arrive already filtered by section: the layout decides what this
 * membership may see, and a group with nothing left in it is not rendered.
 * Hiding a link has never been the guard — every page re-checks (SPEC §2.1).
 */
export function NavMenu({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  // The open group is remembered with the path it was opened on, so navigating
  // closes it by derivation rather than by an effect that fires after the new
  // page has already painted with the menu still over it.
  const [opened, setOpened] = useState<{ label: string; at: string } | null>(null);
  const open = opened && opened.at === pathname ? opened.label : null;
  const setOpen = (label: string | null) =>
    setOpened(label ? { label, at: pathname } : null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    // setOpened rather than the setOpen wrapper: a state setter is stable, so
    // the listeners do not need re-attaching on every render.
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!navRef.current?.contains(event.target as Node)) setOpened(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpened(null);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /**
   * Longest match wins, so /invoices/recurring lights up Recurring rather than
   * Invoices — both are prefixes of the path and only one of them is the page.
   */
  const currentHref = allHrefs(groups)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <nav ref={navRef} className="flex flex-1 flex-wrap items-center gap-1">
      {groups.map((group) =>
        group.items.length === 0 && group.href ? (
          <NavAnchor key={group.label} href={group.href} current={currentHref === group.href}>
            {group.label}
          </NavAnchor>
        ) : (
          <NavDropdown
            key={group.label}
            group={group}
            currentHref={currentHref}
            open={open === group.label}
            onToggle={() => setOpen(open === group.label ? null : group.label)}
            onClose={() => setOpen(null)}
          />
        ),
      )}
    </nav>
  );
}

function allHrefs(groups: NavGroup[]): string[] {
  return groups.flatMap((group) => [
    ...(group.href ? [group.href] : []),
    ...group.items.map((item) => item.href),
  ]);
}

function NavDropdown({
  group,
  currentHref,
  open,
  onToggle,
  onClose,
}: {
  group: NavGroup;
  currentHref: string | undefined;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const holdsCurrent = group.items.some((item) => item.href === currentHref);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={panelId}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            onClose();
            buttonRef.current?.focus();
          }
        }}
        className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
          holdsCurrent
            ? "font-medium text-slate-900 dark:text-white"
            : "text-slate-600 dark:text-slate-300"
        } hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-white`}
      >
        {group.label}
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open ? (
        <ul
          id={panelId}
          className="absolute left-0 top-full z-30 mt-1 max-w-[calc(100vw-2rem)] min-w-44 rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {group.items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={item.href === currentHref ? "page" : undefined}
                className={`block whitespace-nowrap px-3 py-2 text-sm transition-colors ${
                  item.href === currentHref
                    ? "bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-white"
                    : "text-slate-600 dark:text-slate-300"
                } hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-white`}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function NavAnchor({
  href,
  current,
  children,
}: {
  href: string;
  current: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
        current
          ? "font-medium text-slate-900 dark:text-white"
          : "text-slate-600 dark:text-slate-300"
      } hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-white`}
    >
      {children}
    </Link>
  );
}
