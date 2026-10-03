"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/currency";
import { Button, Field, Input } from "@/components/ui";
import type { bookSlots } from "./actions";
import type { ResolvedPick } from "@/lib/bookings/book";

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
 * refresh and can still be sent to somebody else. It is also what carries the
 * selection from one day to the next: moving along the date strip is a real
 * navigation, because only the server knows what is free on a day it has not
 * drawn yet, and the picks ride along in the query string.
 */

export type GridCell = {
  key: string;
  /** Minutes from midnight, for ordering the summary. */
  startMinute: number;
  label: string;
  endLabel: string;
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

/** How many days the strip shows at once; the rest are a jump away. */
const STRIP_DAYS = 14;

export function BookingGrid({
  action,
  slug,
  date,
  dates,
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
  /** Every day on offer, in order, with its tab labels. */
  dates: { date: string; top: string; day: string; month: string }[];
  currency: string;
  units: { id: string; name: string }[];
  slots: { startMinute: number; label: string; endLabel: string }[];
  cells: GridCell[];
  initialPicks: ResolvedPick[];
  unitLabel: string;
  unitLabelPlural: string;
  holdMinutes: number;
}) {
  const router = useRouter();
  // The whole selection, across every day — not just the one on screen. Each
  // entry carries what it needs to be listed, because the grid for another day
  // is not loaded and asking the server again would be a round trip per tap.
  const [picked, setPicked] = useState<ResolvedPick[]>(initialPicks);

  const byKey = new Map(cells.map((cell) => [cell.key, cell]));
  const pickedKeys = new Set(picked.map((pick) => pick.key));

  // Grouped by day, in order, which is how the booker reads it back.
  const days = [...new Set(picked.map((pick) => pick.date))].sort();

  // Summed in whole cents rather than with floating point, and only to show a
  // figure: the amount actually charged is the one the server computes from its
  // own rates when the booking is written.
  const totalCents = picked.reduce(
    (sum, pick) => sum + Math.round(Number(pick.amount) * 100),
    0,
  );

  const hrefFor = (day: string) => {
    const params = new URLSearchParams();
    params.set("date", day);
    for (const pick of picked) params.append("pick", pick.key);
    return `/book/${slug}?${params.toString()}`;
  };

  useEffect(() => {
    // Keeps the address bar honest without navigating: a refresh, a bookmark or
    // a link sent to a friend all come back to the same selection.
    const params = new URLSearchParams();
    params.set("date", date);
    for (const pick of picked) params.append("pick", pick.key);
    // Whatever the page is complaining about stays in the URL: rewriting it out
    // would make the message vanish on a refresh, and it is the one thing on
    // screen explaining why a booking did not go through.
    const problem = new URLSearchParams(window.location.search).get("error");
    if (problem) params.set("error", problem);
    window.history.replaceState(null, "", `/book/${slug}?${params.toString()}`);
  }, [picked, date, slug]);

  const toggle = (cell: GridCell, unitId: string, unitName: string) =>
    setPicked((current) =>
      current.some((pick) => pick.key === cell.key)
        ? current.filter((pick) => pick.key !== cell.key)
        : [
            ...current,
            {
              key: cell.key,
              date,
              unitId,
              unitName,
              startMinute: cell.startMinute,
              label: cell.label,
              endLabel: cell.endLabel,
              amount: cell.amount ?? "0",
              rateLabel: cell.rateLabel,
            },
          ],
    );

  const money = (amount: string | null) => (amount ? formatMoney(amount, currency) : "—");

  // A window onto the horizon rather than every day of it: ninety tabs is a
  // scroll nobody finishes, and the date field below reaches any of them.
  const index = Math.max(0, dates.findIndex((option) => option.date === date));
  const start = Math.min(Math.max(0, index - 3), Math.max(0, dates.length - STRIP_DAYS));
  const strip = dates.slice(start, start + STRIP_DAYS);
  const earlier = dates[Math.max(0, index - 7)];
  const later = dates[Math.min(dates.length - 1, index + 7)];
  const dayLabel = (day: string) => {
    const match = dates.find((option) => option.date === day);
    return match ? `${match.day} ${match.month}` : day;
  };

  return (
    <>
      {/* ---- Dates ------------------------------------------------------- */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Link
          href={hrefFor(earlier.date)}
          aria-label="A week earlier"
          className="rounded-lg border border-slate-200 px-2 py-4 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300"
        >
          ‹
        </Link>

        <div className="flex flex-1 gap-2 overflow-x-auto pb-1">
          {strip.map((option) => {
            const active = option.date === date;
            const dayPicks = picked.filter((pick) => pick.date === option.date).length;
            return (
              <Link
                key={option.date}
                href={hrefFor(option.date)}
                data-date={option.date}
                aria-current={active ? "date" : undefined}
                className={`relative flex min-w-[4.5rem] shrink-0 flex-col items-center rounded-lg border px-3 py-2 text-center transition-colors ${
                  active
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                }`}
              >
                <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
                  {option.top}
                </span>
                <span className="text-lg font-bold leading-tight">{option.day}</span>
                <span className="text-[10px] opacity-80">{option.month}</span>
                {/* A day you have already picked on says so, because the strip
                    is a window and the rest of the selection is off-screen. */}
                {dayPicks > 0 ? (
                  <span
                    className={`absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full text-[10px] font-bold ${
                      active ? "bg-white text-brand-700" : "bg-brand-600 text-white"
                    }`}
                  >
                    {dayPicks}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>

        <Link
          href={hrefFor(later.date)}
          aria-label="A week later"
          className="rounded-lg border border-slate-200 px-2 py-4 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300"
        >
          ›
        </Link>

        {/* Any day inside the horizon, without scrolling to it. */}
        <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="whitespace-nowrap">Jump to</span>
          <input
            type="date"
            value={date}
            min={dates[0]?.date}
            max={dates[dates.length - 1]?.date}
            onChange={(event) => {
              const wanted = event.target.value;
              if (dates.some((option) => option.date === wanted)) router.push(hrefFor(wanted));
            }}
            className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          />
        </label>
      </div>

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
                    const key = `${date}:${unit.id}:${slot.startMinute}`;
                    const cell = byKey.get(key)!;
                    const isPicked = pickedKeys.has(key);

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
                          onClick={() => toggle(cell, unit.id, unit.name)}
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

          {picked.length === 0 ? (
            <p className="mt-3 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              Pick one or more free times from the grid. Tap several to book them together — more
              hours on one {unitLabel.toLowerCase()}, the same hour across a few, or times on
              different days. It is all one booking and one payment.
            </p>
          ) : (
            <form action={action} className="mt-3 space-y-3">
              <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-900/60">
                {/* One block per day. A booking covering Monday and Wednesday
                    has to read as two days, not as a list of times that have
                    quietly lost which day they belong to. */}
                {days.map((day) => (
                  <div key={day} className="mb-3 last:mb-0">
                    <p className="font-semibold text-slate-900 dark:text-white">{dayLabel(day)}</p>
                    <ul className="mt-1 space-y-1">
                      {picked
                        .filter((pick) => pick.date === day)
                        .sort(
                          (a, b) =>
                            a.startMinute - b.startMinute || a.unitName.localeCompare(b.unitName),
                        )
                        .map((pick) => (
                          <li key={pick.key} className="flex items-baseline justify-between gap-2">
                            <span className="text-slate-600 dark:text-slate-400">
                              {pick.unitName} · {pick.label}
                            </span>
                            <span className="flex items-baseline gap-2 whitespace-nowrap">
                              <span className="tabular-nums">{money(pick.amount)}</span>
                              <button
                                type="button"
                                onClick={() =>
                                  setPicked((current) =>
                                    current.filter((entry) => entry.key !== pick.key),
                                  )
                                }
                                aria-label={`Remove ${pick.unitName} at ${pick.label} on ${dayLabel(day)}`}
                                className="text-xs text-slate-400 underline"
                              >
                                remove
                              </button>
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
                <p className="mt-3 flex items-baseline justify-between border-t border-slate-200 pt-2 dark:border-slate-700">
                  <span className="text-xs uppercase tracking-wide text-slate-500">
                    {picked.length} slot{picked.length === 1 ? "" : "s"}
                    {days.length > 1 ? ` · ${days.length} days` : ""}
                  </span>
                  <span className="text-lg font-bold text-slate-900 dark:text-white">
                    {formatMoney((totalCents / 100).toFixed(2), currency)}
                  </span>
                </p>
              </div>

              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="date" value={date} />
              {picked.map((pick) => (
                <input key={pick.key} type="hidden" name="pick" value={pick.key} />
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
                Hold {picked.length === 1 ? "this slot" : `these ${picked.length} slots`}
              </Button>
              <p className="text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                No account needed. We hold {picked.length === 1 ? "it" : "them"} for {holdMinutes}{" "}
                minutes while you pay — payment details come next. One payment covers everything
                listed above, however many days it spans.
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
    </>
  );
}
