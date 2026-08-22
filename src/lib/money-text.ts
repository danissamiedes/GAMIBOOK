/**
 * The text rules for a typed money amount, with no dependency on Decimal or
 * the Prisma client — so the browser can apply exactly the same rules the
 * server will, without pulling the database client into the bundle.
 *
 * `parseMoney` in money.ts is the server-side entry point and defers to this
 * for the string case. Anything that shows a running total to someone typing
 * must agree with what will actually be recorded, and the only way to be sure
 * of that is for both to be the same code.
 */

/**
 * Normalise typed text to a plain decimal string, or null when it is not a
 * number. Tolerates thousands separators, currency symbols, and accounting
 * parentheses — `(3,000.00)` is −3,000, which is how the work order import
 * expresses a deduction (SPEC §8.3).
 */
export function normaliseMoneyText(input: string): string | null {
  let text = input.trim();
  if (text === "") return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1).trim();
  }

  // Strip currency codes/symbols and thousands separators.
  text = text.replace(/[A-Za-z$₱€£¥\s]/g, "").replace(/,/g, "");
  if (text === "" || !/^\d*\.?\d*$/.test(text) || text === ".") return null;

  return negative ? `-${text}` : text;
}

/**
 * The same text as a whole number of cents. Totals are accumulated in cents
 * rather than as floats: 0.1 + 0.2 is not 0.3, and a running total that
 * disagrees with the figure being posted is worse than no running total.
 */
export function moneyTextToCents(input: string): number | null {
  const normalised = normaliseMoneyText(input);
  if (normalised === null) return null;

  const negative = normalised.startsWith("-");
  const digits = negative ? normalised.slice(1) : normalised;
  const [whole = "", fraction = ""] = digits.split(".");

  // More than two decimal places is not a cent amount. The server rounds via
  // Decimal; here it would be a silent lie, so treat it as unparseable and let
  // the total say nothing rather than something wrong.
  if (fraction.length > 2) return null;

  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** Cents back to the "1234.56" form the rest of the app formats. */
export function centsToMoneyText(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const text = `${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}
