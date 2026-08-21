import type { Prisma } from "@prisma/client";
import { money, toCents, type Money } from "@/lib/money";

/**
 * Currency conversion (SPEC §5). One convention, everywhere:
 *
 *     base amount = foreign amount × fxRate
 *
 * so fxRate is "how much base currency one unit of the document's currency is
 * worth". A PHP-base company invoicing USD 1,000 at 58.25 books PHP 58,250.
 * When the document is already in base currency the rate is 1 and none of this
 * fires.
 */

export function toBase(foreignAmount: Prisma.Decimal.Value, fxRate: Prisma.Decimal.Value): Money {
  return toCents(money(foreignAmount).times(money(fxRate)));
}

export function isBaseCurrency(documentCurrency: string, baseCurrency: string): boolean {
  return documentCurrency.toUpperCase() === baseCurrency.toUpperCase();
}

/**
 * Convert a document's lines, keeping the converted **document total** as the
 * authoritative figure (SPEC §4.3, "Rounding").
 *
 * Converting each line independently and adding them up will sometimes miss
 * the converted total by a cent or two, and the balance rule would then reject
 * the entry. So: convert the total, convert the lines, and hand back the
 * residual for the caller to post to FX Rounding Difference. Never absorb it
 * into a revenue or expense line.
 */
export function convertDocument<T>(options: {
  lines: T[];
  amountOf: (line: T) => Prisma.Decimal.Value;
  documentTotal: Prisma.Decimal.Value;
  fxRate: Prisma.Decimal.Value;
}): {
  baseTotal: Money;
  baseLines: { line: T; baseAmount: Money }[];
  residual: Money;
} {
  const baseTotal = toBase(options.documentTotal, options.fxRate);

  const baseLines = options.lines.map((line) => ({
    line,
    baseAmount: toBase(options.amountOf(line), options.fxRate),
  }));

  const summed = baseLines.reduce<Money>((total, entry) => total.plus(entry.baseAmount), money(0));

  // Positive residual: the total is larger than the sum of the lines.
  return { baseTotal, baseLines, residual: baseTotal.minus(summed) };
}

/**
 * Relieve a control account pro rata at the **document's** historic rate
 * (SPEC §4.3). The final payment on a document takes whatever base amount is
 * left, so the document's base balance lands exactly on zero rather than a
 * cent away from it.
 */
export function relieveProRata(options: {
  /** The document's converted total, from when it was issued. */
  documentBaseTotal: Prisma.Decimal.Value;
  /** How much base has already been relieved by earlier payments. */
  alreadyRelieved: Prisma.Decimal.Value;
  /** The document's total in its own currency. */
  documentForeignTotal: Prisma.Decimal.Value;
  /** This payment's share, in the document's currency. */
  foreignApplied: Prisma.Decimal.Value;
  /** Does this payment close the document? */
  settlesDocument: boolean;
}): Money {
  const documentBaseTotal = money(options.documentBaseTotal);
  const alreadyRelieved = money(options.alreadyRelieved);

  if (options.settlesDocument) return documentBaseTotal.minus(alreadyRelieved);

  const foreignTotal = money(options.documentForeignTotal);
  if (foreignTotal.isZero()) return money(0);

  return toCents(documentBaseTotal.times(money(options.foreignApplied)).dividedBy(foreignTotal));
}
