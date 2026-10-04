import type { BookableUnit, BookingRate, BookingSettings } from "@prisma/client";
import { dayGrid } from "./book";

/**
 * One day of a venue's grid, in the shape the booking page draws (SPEC §17).
 *
 * Shared by the page and by the route the browser fetches when somebody moves
 * along the date strip, so the two can never disagree about what a day looks
 * like. Changing days used to be a full navigation — a whole page re-rendered
 * on the server for a table that is the only thing on it that changed — which
 * is a second of nothing happening on the control bookers touch most.
 *
 * Everything here is already public: it is what the page shows a stranger with
 * no account. Prices come from the stored rates, never from the request.
 */

export type DayCell = {
  /** `2026-10-05:unit123:540` — the day is part of the key. */
  key: string;
  startMinute: number;
  label: string;
  endLabel: string;
  /** A plain string; the figure that counts is written at booking time. */
  amount: string | null;
  rateLabel: string | null;
  unavailable: "taken" | "pending" | "past" | "no-price" | null;
};

export type DayPayload = {
  date: string;
  units: { id: string; name: string }[];
  slots: { startMinute: number; label: string; endLabel: string }[];
  cells: DayCell[];
};

export async function dayPayload(options: {
  settings: BookingSettings;
  units: BookableUnit[];
  rates: BookingRate[];
  date: string;
  timeZone: string;
  now?: Date;
}): Promise<DayPayload> {
  const grid = await dayGrid({
    settings: options.settings,
    units: options.units,
    rates: options.rates,
    date: options.date,
    timeZone: options.timeZone,
    now: options.now,
  });

  return {
    date: options.date,
    units: grid.units.map((unit) => ({ id: unit.id, name: unit.name })),
    slots: grid.slots.map((slot) => ({
      startMinute: slot.startMinute,
      label: slot.label,
      endLabel: slot.endLabel,
    })),
    // Decimal does not cross to the browser, and nor does anything the grid
    // does not draw.
    cells: [...grid.cells.entries()].map(([key, cell]) => ({
      key: `${options.date}:${key}`,
      startMinute: cell.startMinute,
      label: cell.label,
      endLabel: cell.endLabel,
      amount: cell.amount ? cell.amount.toFixed(2) : null,
      rateLabel: cell.rateLabel,
      unavailable: cell.unavailable,
    })),
  };
}
