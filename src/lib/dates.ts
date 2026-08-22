/**
 * Accounting dates are plain dates: no time, no zone (SPEC §13). They are
 * stored at UTC midnight, so a viewer in Manila and a viewer in New York see
 * the same date on the same row.
 *
 * Two renderings, and the difference matters:
 *
 *   isoDate()               yyyy-mm-dd — the machine format. What an
 *                           `<input type="date">` requires as its value
 *                           whatever the browser chooses to display, what a
 *                           URL query carries, what `parseAccountingDate`
 *                           reads back, and what an archived CSV should hold
 *                           so it still sorts and parses in ten years.
 *
 *   formatAccountingDate()  mm/dd/yyyy — what a person reads.
 *
 * Using the display one where the machine one belongs is the failure to watch
 * for: a date input silently renders empty and a query param silently falls
 * back to its default, neither of which looks like an error.
 */

export function parseAccountingDate(input: string | null | undefined): Date | null {
  if (!input) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** yyyy-mm-dd. For inputs, URLs, keys, filenames and archives. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** mm/dd/yyyy. For anything a person reads. */
export function formatAccountingDate(date: Date): string {
  const iso = isoDate(date);
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

export function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** First day of the fiscal year containing `date` (SPEC §12.2). */
export function fiscalYearStart(date: Date, fiscalYearStartMonth: number): Date {
  const year = date.getUTCFullYear();
  const startMonthIndex = fiscalYearStartMonth - 1;
  const candidate = new Date(Date.UTC(year, startMonthIndex, 1));
  return candidate <= date ? candidate : new Date(Date.UTC(year - 1, startMonthIndex, 1));
}
