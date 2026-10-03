"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/currency";
import { Button, Field, Input } from "@/components/ui";
import type { bookSlots } from "./actions";

/**
 * Picking slots, in the browser (SPEC §17).
 *
 * This used to be server state: every tick was a `<Link>` carrying the whole
 * selection in the query string, so choosing three courts meant three round
 * trips and three full re-renders of the grid. On a phone on mobile data that
 * is several seconds to do something the page already knows the answer to.
 *
 * The selection is now local, and the only thing that still crosses the wire is
 * the booking itself. Nothing about who gets the slot changed: the server
 * prices every pick from the stored rates and claims it with a unique index, so
 * a browser that sends a stale, forged or impossible selection gets the same
 * refusal it always did. What moved is the typing, not the deciding.
 *
 * The URL is still kept in step — through the history API, which updates the
 * address bar without a navigation — so a half-made selection survives a
 * refresh and can still be sent to somebody else.
 */

export type GridCell = {
  key: string;
  /** Minutes from midnight, for ordering the summary. */
  startMinute: number;
  label: string;
  /** The price as a plain string; the server's figure is the one that counts. */
  amount: string | null;
  rateLabel: string | null;
  unavailable: "taken" | "pending" | "past" | "no-price" | null;
};

/** What a cell nobody can book says, and how it is drawn. */
const UNAVAILABLE: Record<
  "taken" | "pending" | "past" | "no-price",
  { label: string; className: string }
> = {
  taken: {
    label: "Booked",
    className:
      "border-slate-300 bg-slate-200 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400",
  },
  pending: {
    label: "Pending Reservation",
    className:
      "border-dashed border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300",
  },
  past: {
    label: "Passed",
    className: "border-dashed border-slate-200 text-slate-400 dark:border-slate-800",
  },
  "no-price": {
    label: "—",
    className: "border-dashed border-slate-200 text-slate-400 dark:border-slate-800",
  },
};

export function BookingGrid({
  action,
  slug,
  date,
  dateLabel,
  currency,
  units,
  slots,
  cells,
  initialPicks,
  unitLabel,
  unitLabelPlural,
  holdMinutes,
}: {
  action: typeof bookSlots;
  slug: string;
  date: string;
  dateLabel: string;
  currency: string;
  units: { id: string; name: string }[];
  slots: { startMinute: number; label: string; endLabel: string }[];
  cells: GridCell[];
  initialPicks: string[];
  unitLabel: string;
  unitLabelPlural: string;
  holdMinutes: number;
}) {
  const [picked, setPicked] = useState<string[]>(initialPicks);

  const byKey = new Map(cells.map((cell) => [cell.key, cell]));
  const nameOf = new Map(units.map((unit) => [unit.id, unit.name]));

  // A slot that is no longer on offer cannot stay ticked — the grid is redrawn
  // by the server on every date change, and a selection kept across one would
  // be a price for a court somebody else now has.
  const chosen = picked
    .map((key) => ({ key, cell: byKey.get(key), unit: nameOf.get(key.split(":")[0]) }))
    .filter(
      (entry): entry is { key: string; cell: GridCell; unit: string } =>
        entry.cell !== undefined && entry.cell.unavailable === null && entry.unit !== undefined,
    )
    .sort((a, b) => a.cell.startMinute - b.cell.startMinute || a.unit.localeCompare(b.unit));

  // Summed in whole cents rather than with floating point, and only to show a
  // figure: the amount actually charged is the one the server computes from its
  // own rates when the booking is written.
  const totalCents = chosen.reduce(
    (sum, entry) => sum + Math.round(Number(entry.cell.amount ?? 0) * 100),
    0,
  );

  useEffect(() => {
    // Keeps the address bar honest without navigating: a refresh, a bookmark or
    // a link sent to a friend all come back to the same selection.
    const params = new URLSearchParams();
    params.set("date", date);
    for (const key of picked) params.append("pick", key);
    window.history.replaceState(null, "", `/book/${slug}?${params.toString()}`);
  }, [picked, date, slug]);

  const toggle = (key: string) =>
    setPicked((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );

  const money = (amount: string | null) => (amount ? formatMoney(amount, currency) : "—");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      {/* ---- The grid ---------------------------------------------------- */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        {units.length === 0 ? (
          <p className="text-sm text-slate-500">
            This venue has not set up its {unitLabelPlural.toLowerCase()} yet.
          </p>
        ) : (
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="w-20 py-2">Time</th>
                {units.map((unit) => (
                  <th key={unit.id} className="py-2 text-center">
                    {unit.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slots.map((slot) => (
                <tr
                  key={slot.startMinute}
                  className="border-b border-slate-100 dark:border-slate-800/60"
                >
                  <td className="py-1.5 align-middle text-xs font-medium text-slate-600 dark:text-slate-300">
                    {slot.label}
                    <span className="block text-[10px] text-slate-400">{slot.endLabel}</span>
                  </td>
                  {units.map((unit) => {
                    const key = `${unit.id}:${slot.startMinute}`;
                    const cell = byKey.get(key)!;
                    const isPicked = picked.includes(key);

                    if (cell.unavailable) {
                      const state = UNAVAILABLE[cell.unavailable];
                      return (
                        <td key={unit.id} className="p-1">
                          <div
                            className={`rounded-md border px-1 py-2 text-center text-xs leading-tight ${state.className}`}
                          >
                            {state.label}
                          </div>
                        </td>
                      );
                    }

                    return (
                      <td key={unit.id} className="p-1">
                        <button
                          type="button"
                          onClick={() => toggle(key)}
                          aria-pressed={isPicked}
                          className={`block w-full rounded-md border py-2 text-center text-xs font-medium transition-colors ${
                            isPicked
                              ? "border-brand-600 bg-brand-600 text-white"
                              : "border-slate-200 text-brand-700 hover:border-brand-600 hover:bg-brand-50 dark:border-slate-700 dark:text-brand-400 dark:hover:bg-slate-800"
                          }`}
                        >
                          {money(cell.amount)}
                          {cell.rateLabel ? (
                            <span className="block text-[10px] font-normal opacity-80">
                              {isPicked ? "Selected · tap to remove" : cell.rateLabel}
                            </span>
                          ) : null}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ---- Your booking ------------------------------------------------ */}
      <div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-1 text-sm font-semibold">Your booking</h2>

          {chosen.length === 0 ? (
            <p className="mt-3 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              Pick one or more free times from the grid. Tap several to book them together — more
              hours on one {unitLabel.toLowerCase()}, or the same hour across a few.
            </p>
          ) : (
            <form action={action} className="mt-3 space-y-3">
              <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-900/60">
                <p className="font-semibold text-slate-900 dark:text-white">{dateLabel}</p>
                <ul className="mt-2 space-y-1">
                  {chosen.map((entry) => (
                    <li key={entry.key} className="flex items-baseline justify-between gap-2">
                      <span className="text-slate-600 dark:text-slate-400">
                        {entry.unit} · {entry.cell.label}
                      </span>
                      <span className="flex items-baseline gap-2 whitespace-nowrap">
                        <span className="tabular-nums">{money(entry.cell.amount)}</span>
                        <button
                          type="button"
                          onClick={() => toggle(entry.key)}
                          aria-label={`Remove ${entry.unit} at ${entry.cell.label}`}
                          className="text-xs text-slate-400 underline"
                        >
                          remove
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 flex items-baseline justify-between border-t border-slate-200 pt-2 dark:border-slate-700">
                  <span className="text-xs uppercase tracking-wide text-slate-500">
                    {chosen.length} slot{chosen.length === 1 ? "" : "s"}
                  </span>
                  <span className="text-lg font-bold text-slate-900 dark:text-white">
                    {formatMoney((totalCents / 100).toFixed(2), currency)}
                  </span>
                </p>
              </div>

              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="date" value={date} />
              {chosen.map((entry) => (
                <input key={entry.key} type="hidden" name="pick" value={entry.key} />
              ))}

              <Field label="Your name">
                <Input name="customerName" required autoComplete="name" />
              </Field>
              <Field label="Email" hint="Your confirmation goes here.">
                <Input name="customerEmail" type="email" required autoComplete="email" />
              </Field>
              <Field label="Mobile" hint="Optional.">
                <Input name="customerPhone" autoComplete="tel" />
              </Field>
              <Field label="Anything we should know?" hint="Optional.">
                <Input name="note" />
              </Field>

              <Button type="submit" className="w-full">
                Hold {chosen.length === 1 ? "this slot" : `these ${chosen.length} slots`}
              </Button>
              <p className="text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                No account needed. We hold {chosen.length === 1 ? "it" : "them"} for {holdMinutes}{" "}
                minutes while you pay — payment details come next. One payment covers everything on
                this day; another day is booked separately.
              </p>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
          Already booked?{" "}
          <Link href={`/book/${slug}/find`} className="underline">
            Find your booking
          </Link>
        </p>
      </div>
    </div>
  );
}
