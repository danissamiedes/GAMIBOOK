import type { BookingRate } from "@prisma/client";
import { money, type Money } from "@/lib/money";

/**
 * Slots and what they cost (SPEC §17).
 *
 * Times here are **minutes from midnight in the venue's own zone**, not
 * instants. A court opens at 7am local whatever the clocks did overnight, and
 * storing an offset would mean every daylight-saving change silently moved the
 * opening hour. The date and the minute together are the booking; converting
 * to UTC happens only where a real instant is needed, such as a hold expiry.
 */

export type Slot = {
  startMinute: number;
  endMinute: number;
  /** "7:00 AM", for a person. */
  label: string;
  endLabel: string;
};

/** Every slot a day offers, from the opening hour to the last one that fits. */
export function slotsForDay(options: {
  opensAtMinute: number;
  closesAtMinute: number;
  slotMinutes: number;
}): Slot[] {
  const { opensAtMinute, closesAtMinute, slotMinutes } = options;
  if (slotMinutes <= 0) return [];

  const slots: Slot[] = [];
  // A slot that would run past closing is not offered: a court that shuts at
  // 11pm cannot sell the hour from 10:30.
  for (let start = opensAtMinute; start + slotMinutes <= closesAtMinute; start += slotMinutes) {
    const end = start + slotMinutes;
    slots.push({
      startMinute: start,
      endMinute: end,
      label: formatMinute(start),
      endLabel: formatMinute(end),
    });
  }
  return slots;
}

/** 450 → "7:30 AM". Midnight reads as 12:00 AM, noon as 12:00 PM. */
export function formatMinute(minute: number): string {
  const normalised = ((minute % 1440) + 1440) % 1440;
  const hour24 = Math.floor(normalised / 60);
  const minutes = normalised % 60;
  const suffix = hour24 < 12 ? "AM" : "PM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/** "7:00 AM" or "07:00" back to minutes. Returns null on anything else. */
export function parseMinute(value: string): number | null {
  const trimmed = value.trim();
  const twelve = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(trimmed);
  if (twelve) {
    const hour = Number(twelve[1]) % 12;
    const minutes = Number(twelve[2]);
    if (hour > 11 || minutes > 59) return null;
    return (hour + (twelve[3].toUpperCase() === "PM" ? 12 : 0)) * 60 + minutes;
  }
  const twentyFour = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minutes = Number(twentyFour[2]);
    if (hour > 24 || minutes > 59) return null;
    return hour * 60 + minutes;
  }
  return null;
}

export type PricedSlot = Slot & {
  amount: Money;
  /** "Peak", "Off-Peak" — what the booker sees beside the price. */
  rateLabel: string | null;
};

/**
 * What one slot costs on one day for one unit.
 *
 * A rate applies when the day matches, the slot starts inside its window, and
 * it is either for this unit or for all of them. Where several apply the
 * highest `priority` wins, then the most specific — a rule naming this unit
 * beats a general one — so a single court can be priced differently without
 * rewriting the rules that cover the rest.
 *
 * No matching rate means no price rather than zero. A court with no rate set
 * is misconfigured, and quietly selling it for nothing is the worst possible
 * reading of that.
 */
export function priceFor(options: {
  rates: BookingRate[];
  unitId: string;
  dayOfWeek: number;
  startMinute: number;
}): { amount: Money; label: string } | null {
  const applicable = options.rates.filter((rate) => {
    if (rate.unitId && rate.unitId !== options.unitId) return false;
    if (rate.daysOfWeek.length > 0 && !rate.daysOfWeek.includes(options.dayOfWeek)) return false;
    return options.startMinute >= rate.startMinute && options.startMinute < rate.endMinute;
  });
  if (applicable.length === 0) return null;

  applicable.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    // A rule naming this unit is more specific than one covering all of them.
    const specificity = (rate: BookingRate) =>
      (rate.unitId ? 2 : 0) + (rate.daysOfWeek.length > 0 ? 1 : 0);
    return specificity(b) - specificity(a);
  });

  const winner = applicable[0];
  return { amount: money(winner.amount), label: winner.label };
}

/** Minutes from midnight → the ISO time a `<input type="time">` wants. */
export function toTimeInput(minute: number): string {
  const normalised = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalised / 60)).padStart(2, "0")}:${String(
    normalised % 60,
  ).padStart(2, "0")}`;
}
