import { randomBytes } from "node:crypto";
import type { BookableUnit, BookingRate, BookingSettings, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isoDate, parseAccountingDate } from "@/lib/dates";
import { money, type Money } from "@/lib/money";
import { priceFor, slotsForDay, type Slot } from "./slots";

/**
 * Taking a booking (SPEC §17).
 *
 * The public end of this is open to strangers — no account, no session — so
 * everything here assumes the caller is hostile until proven otherwise: the
 * company comes from the slug, never from the form; the price is computed from
 * the stored rates, never read from the request; and the slot is claimed by a
 * database constraint rather than by checking first and writing after.
 */

/** A slot on the public grid, with everything the page needs to draw it. */
export type OfferedSlot = Slot & {
  unitId: string;
  amount: Money | null;
  rateLabel: string | null;
  /**
   * Why it cannot be booked, or null when it can.
   *
   * "taken" is a booking somebody has paid for and a person has checked;
   * "pending" is one that is held or waiting on a payment being verified.
   * Both are off the market, but calling the second one booked overstates
   * what the venue actually has — the hold can still lapse or be turned down.
   */
  unavailable: "taken" | "pending" | "past" | "no-price" | null;
};

export type DayGrid = {
  date: string;
  units: { id: string; name: string; note: string | null }[];
  slots: Slot[];
  /** Keyed `${unitId}:${startMinute}`. */
  cells: Map<string, OfferedSlot>;
};

/** Everything the public page needs for one venue. */
export async function publicVenue(slug: string) {
  const settings = await prisma.bookingSettings.findUnique({
    where: { slug },
    include: {
      company: {
        select: { id: true, name: true, baseCurrency: true, operatingTimeZone: true, theme: true },
      },
    },
  });
  if (!settings || !settings.isPublished) return null;

  const [units, rates] = await Promise.all([
    prisma.bookableUnit.findMany({
      where: { companyId: settings.companyId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.bookingRate.findMany({ where: { companyId: settings.companyId } }),
  ]);

  return { settings, units, rates, company: settings.company };
}

/** Today in the venue's own zone, as yyyy-mm-dd. */
export function venueToday(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Minutes past midnight right now, in the venue's zone. */
export function venueMinuteNow(timeZone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const [hour, minute] = parts.split(":").map(Number);
  return hour * 60 + minute;
}

/**
 * The grid for one day: every unit against every slot, priced, with the ones
 * already taken marked.
 *
 * One query for the day's bookings rather than one per cell — a fourteen-court
 * venue with sixteen slots is 224 cells, and 224 round trips to answer the
 * same question is how a page takes six seconds to draw.
 */
export async function dayGrid(options: {
  settings: BookingSettings;
  units: BookableUnit[];
  rates: BookingRate[];
  date: string;
  timeZone: string;
  now?: Date;
}): Promise<DayGrid> {
  const { settings, units, rates, date, timeZone } = options;
  const now = options.now ?? new Date();

  const slots = slotsForDay({
    opensAtMinute: settings.opensAtMinute,
    closesAtMinute: settings.closesAtMinute,
    slotMinutes: settings.slotMinutes,
  });

  const parsed = parseAccountingDate(date);
  const dayOfWeek = parsed ? parsed.getUTCDay() : new Date(date).getUTCDay();

  const taken = await prisma.booking.findMany({
    where: {
      companyId: settings.companyId,
      date: parsed ?? new Date(date),
      status: { not: "CANCELLED" },
    },
    select: { unitId: true, startMinute: true, status: true, group: { select: { heldUntil: true } } },
  });

  const takenKeys = new Map<string, "taken" | "pending">(
    taken
      // An expired hold is not a booking. Leaving it on the grid would keep a
      // court off the market because somebody opened a form and wandered off.
      .filter(
        (row) =>
          row.status !== "HELD" || !row.group.heldUntil || row.group.heldUntil > now,
      )
      .map(
        (row) =>
          [
            `${row.unitId}:${row.startMinute}`,
            row.status === "CONFIRMED" ? ("taken" as const) : ("pending" as const),
          ] as const,
      ),
  );

  const today = venueToday(timeZone, now);
  const minuteNow = venueMinuteNow(timeZone, now);

  const cells = new Map<string, OfferedSlot>();
  for (const unit of units) {
    for (const slot of slots) {
      const price = priceFor({
        rates,
        unitId: unit.id,
        dayOfWeek,
        startMinute: slot.startMinute,
      });
      const key = `${unit.id}:${slot.startMinute}`;
      const past = date < today || (date === today && slot.startMinute <= minuteNow);

      cells.set(key, {
        ...slot,
        unitId: unit.id,
        amount: price?.amount ?? null,
        rateLabel: price?.label ?? null,
        unavailable:
          takenKeys.get(key) ??
          (past ? "past" : price ? null : "no-price"),
      });
    }
  }

  return {
    date,
    units: units.map((unit) => ({ id: unit.id, name: unit.name, note: unit.note })),
    slots,
    cells,
  };
}

/** The dates the public page offers, starting today in the venue's zone. */
export function offeredDates(settings: BookingSettings, timeZone: string, now = new Date()) {
  const start = parseAccountingDate(venueToday(timeZone, now))!;
  return Array.from({ length: Math.max(1, settings.horizonDays) }, (_, index) => {
    const day = new Date(start.getTime() + index * 86_400_000);
    return isoDate(day);
  });
}

/**
 * A reference a person can read down a phone.
 *
 * Crockford's alphabet without I, L, O or U: no pair that sounds alike when
 * spoken and nothing that can be misread as a digit, which matters because
 * this is the one string a booker has to repeat to a human.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function bookingReference(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let index = 0; index < 6; index++) out += ALPHABET[bytes[index] % ALPHABET.length];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

/**
 * A ceiling on one booking, so a public form cannot take a whole week of a
 * venue's capacity in one request. High enough that nobody legitimate meets it.
 */
export const MAX_SLOTS_PER_BOOKING = 20;

export type BookProblem =
  | "closed"
  | "unknown-unit"
  | "bad-slot"
  | "past"
  | "no-price"
  | "taken"
  | "name"
  | "email"
  | "empty"
  | "too-many";

export const BOOK_MESSAGES: Record<BookProblem, string> = {
  closed: "This venue is not taking bookings at the moment.",
  "unknown-unit": "That is not something this venue takes bookings for.",
  "bad-slot": "That is not one of the available times.",
  past: "That time has already passed.",
  "no-price": "There is no price set for that time. Please contact the venue.",
  taken: "Somebody booked that slot a moment before you. Please pick another.",
  name: "Please give a name for the booking.",
  email: "Please give an email address — the confirmation goes there.",
  empty: "Pick at least one time before booking.",
  "too-many": `That is more than ${MAX_SLOTS_PER_BOOKING} slots in one booking. Please make a second booking.`,
};


export type BookResult =
  | { ok: true; group: BookingGroupWithSlots }
  | { ok: false; problem: BookProblem };

export type BookingGroupWithSlots = Prisma.BookingGroupGetPayload<{
  include: { bookings: { include: { unit: true } } };
}>;

/**
 * One slot the booker ticked, as it arrives from the form.
 *
 * The date belongs to the slot, not to the booking: somebody who wants Court 1
 * at 9am on Monday and the same court on Wednesday is making one arrangement
 * and expects to pay for it once. `date` may be left off, in which case the
 * booking's own date is used — which is what a single-day booking sends.
 */
export type SlotPick = { unitId: string; startMinute: number; date?: string };

/** A pick with its day resolved, which is how everything below treats it. */
type DatedPick = { unitId: string; startMinute: number; date: string };

/** `2026-10-05:unit123:540` — one slot, as the URL and the form carry it. */
export function pickKey(pick: DatedPick): string {
  return `${pick.date}:${pick.unitId}:${pick.startMinute}`;
}

/** The other direction. Returns null for anything that is not a pick. */
export function parsePickKey(key: string): DatedPick | null {
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  const [date, unitId, minute] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !unitId) return null;
  const startMinute = Number(minute);
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 1440) return null;
  return { date, unitId, startMinute };
}

/**
 * Book one or more slots, on one day or several, as a single thing to be paid
 * for (SPEC §17).
 *
 * It was one day only to begin with, on the reasoning that a part-paid booking
 * spanning a week is hard to reason about at the desk. In practice a booker who
 * wants Monday and Wednesday was being asked to pay twice for one decision, and
 * the venue to check two payments for one customer. The group is now whatever
 * they picked; `date` on the group is the first day of it, which is what the
 * admin list sorts by.
 *
 * Every day is priced on its own weekday, so a Saturday slot inside a booking
 * that starts on Friday is charged at the Saturday rate.
 */
export async function createBookingGroup(options: {
  slug: string;
  picks: SlotPick[];
  /** The day a pick without one belongs to. */
  date: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  note?: string | null;
  userId?: string | null;
  now?: Date;
}): Promise<BookResult> {
  const now = options.now ?? new Date();

  // The company comes from the slug. Nothing the form says decides whose
  // books this lands in.
  const venue = await publicVenue(options.slug);
  if (!venue) return { ok: false, problem: "closed" };
  const { settings, units, rates, company } = venue;

  const name = options.customerName.trim();
  const email = options.customerEmail.trim().toLowerCase();
  if (!name) return { ok: false, problem: "name" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, problem: "email" };

  // The same slot ticked twice is one slot, not a double charge.
  const picks = dedupe(options.picks.map((pick) => ({ ...pick, date: pick.date || options.date })));
  if (picks.length === 0) return { ok: false, problem: "empty" };
  if (picks.length > MAX_SLOTS_PER_BOOKING) return { ok: false, problem: "too-many" };

  const horizon = offeredDates(settings, company.operatingTimeZone, now);

  const slots = slotsForDay({
    opensAtMinute: settings.opensAtMinute,
    closesAtMinute: settings.closesAtMinute,
    slotMinutes: settings.slotMinutes,
  });
  const today = venueToday(company.operatingTimeZone, now);
  const minuteNow = venueMinuteNow(company.operatingTimeZone, now);

  // Every pick is checked before any of them is written. A group that booked
  // three of four slots and failed on the fourth would be a partial booking
  // nobody asked for.
  const priced: {
    unitId: string;
    date: Date;
    startMinute: number;
    endMinute: number;
    amount: Money;
    rateLabel: string;
  }[] = [];

  for (const pick of picks) {
    const unit = units.find((candidate) => candidate.id === pick.unitId);
    if (!unit) return { ok: false, problem: "unknown-unit" };

    const day = parseAccountingDate(pick.date);
    if (!day) return { ok: false, problem: "bad-slot" };
    // Each day is checked against the horizon on its own. A booking is not
    // allowed to reach past it by riding along with a day that is inside it.
    if (!horizon.includes(pick.date)) return { ok: false, problem: "past" };

    const slot = slots.find((candidate) => candidate.startMinute === pick.startMinute);
    if (!slot) return { ok: false, problem: "bad-slot" };

    if (pick.date === today && slot.startMinute <= minuteNow) {
      return { ok: false, problem: "past" };
    }

    // Priced from the stored rates, never from the request. A posted amount is
    // a number a stranger chose. The weekday is this slot's own, so a Saturday
    // inside a booking made on Friday is charged at the Saturday rate.
    const price = priceFor({
      rates,
      unitId: unit.id,
      dayOfWeek: day.getUTCDay(),
      startMinute: slot.startMinute,
    });
    if (!price) return { ok: false, problem: "no-price" };

    priced.push({
      unitId: unit.id,
      date: day,
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
      amount: price.amount,
      rateLabel: price.label,
    });
  }

  // Expired holds on any of these slots are cleared first, so the unique index
  // does not refuse a slot nobody is actually holding.
  await releaseExpiredHolds(picks, now);

  // The group's own date is the first day it covers: the admin list sorts and
  // filters by it, and "when does this start" is the question that answers.
  const firstDate = priced
    .map((slot) => slot.date)
    .reduce((earliest, day) => (day < earliest ? day : earliest));

  const total = priced.reduce<Money>((sum, slot) => sum.plus(slot.amount), money(0));

  try {
    const group = await prisma.bookingGroup.create({
      data: {
        companyId: settings.companyId,
        reference: bookingReference(),
        date: firstDate,
        status: "HELD",
        amount: total.toFixed(2),
        currency: company.baseCurrency,
        customerName: name,
        customerEmail: email,
        customerPhone: options.customerPhone?.trim() || null,
        note: options.note?.trim() || null,
        userId: options.userId ?? null,
        heldUntil: new Date(now.getTime() + settings.holdMinutes * 60_000),
        bookings: {
          create: priced.map((slot) => ({
            companyId: settings.companyId,
            unitId: slot.unitId,
            date: slot.date,
            startMinute: slot.startMinute,
            endMinute: slot.endMinute,
            status: "HELD" as const,
            amount: slot.amount.toFixed(2),
            rateLabel: slot.rateLabel,
          })),
        },
      },
      include: { bookings: { include: { unit: true } } },
    });
    return { ok: true, group };
  } catch (error) {
    // The partial unique index is what actually decides who got each slot.
    // Checking first and writing after leaves a window two clicks fit into —
    // and because the group and its slots are one statement, losing any one
    // slot rolls the whole group back rather than half-booking somebody.
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return { ok: false, problem: "taken" };
    }
    throw error;
  }
}

/** The same unit, day and minute ticked twice is one slot, not a double charge. */
function dedupe(picks: DatedPick[]): DatedPick[] {
  const seen = new Set<string>();
  return picks.filter((pick) => {
    const key = pickKey(pick);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function releaseExpiredHolds(picks: DatedPick[], now: Date): Promise<void> {
  const stale = await prisma.booking.findMany({
    where: {
      status: "HELD",
      OR: picks.flatMap((pick) => {
        const day = parseAccountingDate(pick.date);
        return day
          ? [{ unitId: pick.unitId, date: day, startMinute: pick.startMinute }]
          : [];
      }),
      group: { heldUntil: { lte: now } },
    },
    select: { groupId: true },
  });
  if (stale.length === 0) return;

  const groupIds = [...new Set(stale.map((row) => row.groupId))];
  // The whole group goes, not the one slot: a booking half-expired is not a
  // state anyone can act on, and the booker was never going to pay for part.
  await prisma.$transaction([
    prisma.bookingGroup.updateMany({
      where: { id: { in: groupIds } },
      data: { status: "CANCELLED", cancelledAt: now, cancelReason: "Hold expired" },
    }),
    prisma.booking.updateMany({
      where: { groupId: { in: groupIds } },
      data: { status: "CANCELLED" },
    }),
  ]);
}

/**
 * What a selection spanning several days actually is, resolved for display.
 *
 * The grid the booker is looking at covers one day; the selection may not. The
 * picks for the other days still have to be priced and named in the summary,
 * and a slot somebody else took while this one was being made has to drop out
 * of it — quietly, before the form is sent, rather than failing at the end.
 *
 * Rates and units are already in memory, so pricing costs nothing; a single
 * query covers availability across every day picked.
 */
export type ResolvedPick = {
  key: string;
  date: string;
  unitId: string;
  unitName: string;
  startMinute: number;
  label: string;
  endLabel: string;
  /** Plain string; the figure that counts is the one written at booking time. */
  amount: string;
  rateLabel: string | null;
};

export async function resolvePicks(options: {
  settings: BookingSettings;
  units: BookableUnit[];
  rates: BookingRate[];
  timeZone: string;
  keys: string[];
  now?: Date;
}): Promise<ResolvedPick[]> {
  const now = options.now ?? new Date();
  const horizon = new Set(offeredDates(options.settings, options.timeZone, now));
  const today = venueToday(options.timeZone, now);
  const minuteNow = venueMinuteNow(options.timeZone, now);
  const slots = slotsForDay({
    opensAtMinute: options.settings.opensAtMinute,
    closesAtMinute: options.settings.closesAtMinute,
    slotMinutes: options.settings.slotMinutes,
  });

  const wanted: (ResolvedPick & { day: Date })[] = [];
  for (const key of [...new Set(options.keys)]) {
    const pick = parsePickKey(key);
    if (!pick || !horizon.has(pick.date)) continue;

    const unit = options.units.find((candidate) => candidate.id === pick.unitId);
    const slot = slots.find((candidate) => candidate.startMinute === pick.startMinute);
    const day = parseAccountingDate(pick.date);
    if (!unit || !slot || !day) continue;
    if (pick.date === today && slot.startMinute <= minuteNow) continue;

    const price = priceFor({
      rates: options.rates,
      unitId: unit.id,
      dayOfWeek: day.getUTCDay(),
      startMinute: slot.startMinute,
    });
    if (!price) continue;

    wanted.push({
      key,
      day,
      date: pick.date,
      unitId: unit.id,
      unitName: unit.name,
      startMinute: slot.startMinute,
      label: slot.label,
      endLabel: slot.endLabel,
      amount: price.amount.toFixed(2),
      rateLabel: price.label,
    });
  }
  if (wanted.length === 0) return [];

  const taken = await prisma.booking.findMany({
    where: {
      companyId: options.settings.companyId,
      status: { not: "CANCELLED" },
      OR: wanted.map((pick) => ({
        unitId: pick.unitId,
        date: pick.day,
        startMinute: pick.startMinute,
      })),
    },
    select: { unitId: true, date: true, startMinute: true, group: { select: { heldUntil: true } } },
  });
  const takenKeys = new Set(
    taken
      .filter((row) => !row.group.heldUntil || row.group.heldUntil > now)
      .map((row) => `${isoDate(row.date)}:${row.unitId}:${row.startMinute}`),
  );

  const free = wanted.filter((pick) => !takenKeys.has(pick.key));
  free.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.startMinute - b.startMinute ||
      a.unitName.localeCompare(b.unitName),
  );
  // `day` was only ever for the availability query above.
  return free.map((pick) => ({
    key: pick.key,
    date: pick.date,
    unitId: pick.unitId,
    unitName: pick.unitName,
    startMinute: pick.startMinute,
    label: pick.label,
    endLabel: pick.endLabel,
    amount: pick.amount,
    rateLabel: pick.rateLabel,
  }));
}

/** One booking by its reference, for the page the booker lands on. */
export async function bookingByReference(slug: string, reference: string) {
  const settings = await prisma.bookingSettings.findUnique({ where: { slug } });
  if (!settings) return null;
  return prisma.bookingGroup.findFirst({
    where: { companyId: settings.companyId, reference: reference.trim().toUpperCase() },
    include: {
      bookings: { include: { unit: true }, orderBy: [{ date: "asc" }, { startMinute: "asc" }] },
      company: { select: { name: true, baseCurrency: true } },
    },
  });
}

export { money };
