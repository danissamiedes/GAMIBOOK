import type { CompanyTheme } from "@prisma/client";

/**
 * The accent a company's screens wear (SPEC §3).
 *
 * One login can hold several sets of books, and reading the switcher is a
 * slower way to know which is open than seeing it. The colours themselves live
 * in `globals.css`, keyed on `data-company-theme`, because that is where the
 * app's palette already lives and because CSS is the only place a media query
 * can adjust them for dark mode. This module holds what the *code* needs: the
 * order, the names a person reads, and a swatch for the picker.
 */

export const COMPANY_THEMES: {
  value: CompanyTheme;
  label: string;
  /** The accent at its button strength, for a swatch. Mirrors --color-brand-600. */
  swatch: string;
}[] = [
  { value: "BLUE", label: "Blue", swatch: "#2563eb" },
  { value: "GREEN", label: "Green", swatch: "#15803d" },
  { value: "PINK", label: "Pink", swatch: "#be185d" },
  { value: "VIOLET", label: "Violet", swatch: "#7c3aed" },
  { value: "TEAL", label: "Teal", swatch: "#0f766e" },
  { value: "AMBER", label: "Amber", swatch: "#b45309" },
];

export function isCompanyTheme(value: string): value is CompanyTheme {
  return COMPANY_THEMES.some((theme) => theme.value === value);
}

/**
 * The attribute the shell carries.
 *
 * Blue is the app's own palette at `:root`, so it needs no override — and
 * saying so with `undefined` keeps the default company rendering exactly the
 * CSS it always did, rather than a copy of it that could drift.
 */
export function themeAttribute(theme: CompanyTheme): string | undefined {
  return theme === "BLUE" ? undefined : theme.toLowerCase();
}

/**
 * The accent for a company being created: the first one nothing else is using.
 *
 * Distinct by default is the whole point — a second company that looks like the
 * first teaches nobody anything. Falls back to cycling once every accent is
 * taken, which needs seven companies.
 */
export function nextAvailableTheme(taken: CompanyTheme[]): CompanyTheme {
  const free = COMPANY_THEMES.find((theme) => !taken.includes(theme.value));
  return free ? free.value : COMPANY_THEMES[taken.length % COMPANY_THEMES.length].value;
}
