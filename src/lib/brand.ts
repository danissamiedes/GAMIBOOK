/**
 * What the product calls itself, in one place.
 *
 * It appeared as a literal in forty-five page titles and four headings, which
 * meant renaming it was a find-and-replace across the app and would drift the
 * moment one was missed. `pageTitle` builds the browser-tab title so the
 * separator and the order stay consistent too.
 *
 * This is the *product* name, not the company's — the company name lives on the
 * Company record and is what appears on an invoice a customer receives.
 */
export const APP_NAME = "GAMIBOOK";

/** "Invoices — GAMIBOOK", the way every tab title is built. */
export function pageTitle(page: string): string {
  return `${page} — ${APP_NAME}`;
}
