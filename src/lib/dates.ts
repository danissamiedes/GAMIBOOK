/**
 * Accounting dates are plain dates: no time, no zone (SPEC §13). They are
 * parsed and rendered as ISO yyyy-mm-dd and stored at UTC midnight, so a
 * viewer in Manila and a viewer in New York see the same date on the same row.
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

export function formatAccountingDate(date: Date): string {
  return date.toISOString().slice(0, 10);
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
