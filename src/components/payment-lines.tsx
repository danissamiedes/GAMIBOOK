"use client";

import { useState } from "react";
import { Input } from "@/components/ui";
import { centsToMoneyText, moneyTextToCents } from "@/lib/money-text";
import { formatMoney } from "@/lib/currency";

export type PayableLine = {
  /** Form field name — the server parses `apply-<type>-<id>` out of these. */
  name: string;
  label: string;
  dueLabel: string;
  owing: string;
  currency: string;
  defaultAmount: string;
};

/**
 * The document lines of a bill payment, with a running total.
 *
 * The total matters because the payment *is* the sum of these: the server does
 * not take an amount typed separately, it adds up what you applied. Someone
 * paying four bills at once should not have to add them in their head to know
 * what will leave the bank.
 *
 * Amounts are summed in whole cents through the same text rules the server
 * uses (money-text.ts), so what is shown here is what gets recorded.
 */
export function PaymentLines({ lines, currency }: { lines: PayableLine[]; currency: string }) {
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.name, line.defaultAmount])),
  );

  // Only what the server would accept: it skips anything unparseable or not
  // above zero, so counting those here would promise money that never moves.
  const applied = lines
    .map((line) => moneyTextToCents(amounts[line.name] ?? ""))
    .filter((cents): cents is number => cents !== null && cents > 0);

  const total = applied.reduce((running, cents) => running + cents, 0);
  const unreadable = lines.filter(
    (line) => (amounts[line.name] ?? "").trim() !== "" && moneyTextToCents(amounts[line.name] ?? "") === null,
  );

  return (
    <div className="space-y-2">
      {lines.map((line) => (
        // A grid rather than flex with a width class on the input: Input bakes
        // in w-full, and a w-28 passed alongside it is two width utilities
        // fighting over source order — which is how the amount box ended up
        // taking the whole row and squeezing the label to one word per line.
        <div
          key={line.name}
          className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2"
        >
          <label className="min-w-0 text-sm" htmlFor={line.name}>
            {line.label}
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              {line.dueLabel} · owing {line.owing} {line.currency}
            </span>
          </label>
          <Input
            id={line.name}
            className="text-right tabular-nums"
            inputMode="decimal"
            name={line.name}
            value={amounts[line.name] ?? ""}
            onChange={(event) =>
              setAmounts((current) => ({ ...current, [line.name]: event.target.value }))
            }
            aria-label={`Amount to apply to ${line.label}`}
          />
        </div>
      ))}

      <div className="flex items-baseline justify-between border-t border-slate-200 pt-2 dark:border-slate-700">
        <span className="text-sm font-semibold">Total to pay</span>
        <span
          className="text-right text-base font-semibold tabular-nums"
          data-testid="payment-total"
        >
          {formatMoney(centsToMoneyText(total), currency)}
        </span>
      </div>

      {total === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Nothing to pay yet — enter an amount against at least one document.
        </p>
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {applied.length} of {lines.length} document{lines.length === 1 ? "" : "s"} being paid.
        </p>
      )}

      {unreadable.length > 0 ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          Not a number on {unreadable.map((line) => line.label).join(", ")} — that amount is not
          counted in the total and will not be paid.
        </p>
      ) : null}
    </div>
  );
}
