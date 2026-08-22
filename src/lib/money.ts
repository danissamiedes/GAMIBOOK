import { Prisma } from "@prisma/client";
import DecimalJs from "decimal.js";
import { normaliseMoneyText } from "./money-text";

/**
 * Money is Decimal, never a float, never JavaScript `number` arithmetic
 * (SPEC §4.2 rule 2, §13). Everything that touches an amount goes through
 * here, including anything parsed out of a spreadsheet cell.
 */

export const Decimal = Prisma.Decimal;
export type Money = Prisma.Decimal;

/** Amounts are stored to the cent. */
export const MONEY_DP = 2;

export function money(value: Prisma.Decimal.Value | null | undefined): Money {
  if (value === null || value === undefined || value === "") return new Prisma.Decimal(0);
  return new Prisma.Decimal(value);
}

/** Round half-up to the cent — the convention accountants expect. */
export function toCents(value: Prisma.Decimal.Value): Money {
  return new Prisma.Decimal(value).toDecimalPlaces(MONEY_DP, DecimalJs.ROUND_HALF_UP);
}

export function sum(values: Prisma.Decimal.Value[]): Money {
  return values.reduce<Money>((total, value) => total.plus(new Prisma.Decimal(value)), money(0));
}

export function isZero(value: Prisma.Decimal.Value): boolean {
  return new Prisma.Decimal(value).isZero();
}

export function equals(a: Prisma.Decimal.Value, b: Prisma.Decimal.Value): boolean {
  return new Prisma.Decimal(a).equals(new Prisma.Decimal(b));
}

/**
 * Parse user or spreadsheet input into a Decimal. Handles thousands
 * separators, currency symbols and accounting parentheses — `(3,000.00)` is
 * −3,000, which is how the work order import expresses a deduction (SPEC §8.3).
 * Returns null when the text is not a number, so callers report a row error
 * rather than silently posting a zero.
 */
export function parseMoney(input: string | number | null | undefined): Money | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    return Number.isFinite(input) ? toCents(input) : null;
  }

  const normalised = normaliseMoneyText(input);
  if (normalised === null) return null;

  return new Prisma.Decimal(normalised);
}
