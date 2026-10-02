import { randomBytes } from "node:crypto";
import type { BookableUnit, Booking, BookingRate, BookingSettings } from "@prisma/client";
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
  /** Why it cannot be booked, or null when it can. */
  unavailable: "taken" | "past" | "no-price" | null;
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
    select: { unitId: true, startMinute: true, status: true, heldUntil: true },
  });

  const takenKeys = new Set(
    taken
      // An expired hold is not a booking. Leaving it on the grid would keep a
      // court off the market because somebody opened a form and wandered off.
      .filter((row) => row.status !== "HELD" || !row.heldUntil || row.heldUntil > now)
      .map((row) => `${row.unitId}:${row.startMinute}`),
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
        unavailable: takenKeys.has(key)
          ? "taken"
          : past
            ? "past"
            : price
              ? null
              : "no-price",
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

export type BookProblem =
  | "closed"
  | "unknown-unit"
  | "bad-slot"
  | "past"
  | "no-price"
  | "taken"
  | "name"
  | "email";

export const BOOK_MESSAGES: Record<BookProblem, string> = {
  closed: "This venue is not taking bookings at the moment.",
  "unknown-unit": "That is not something this venue takes bookings for.",
  "bad-slot": "That is not one of the available times.",
  past: "That time has already passed.",
  "no-price": "There is no price set for that time. Please contact the venue.",
  taken: "Somebody booked that slot a moment before you. Please pick another.",
  name: "Please give a name for the booking.",
  email: "Please give an email address — the confirmation goes there.",
};

export type BookResult =
  | { ok: true; booking: Booking }
  | { ok: false; problem: BookProblem };

export async function createBooking(options: {
  slug: string;
  unitId: string;
  date: string;
  startMinute: number;
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

  const unit = units.find((candidate) => candidate.id === options.unitId);
  if (!unit) return { ok: false, problem: "unknown-unit" };

  const name = options.customerName.trim();
  const email = options.customerEmail.trim().toLowerCase();
  if (!name) return { ok: false, problem: "name" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, problem: "email" };

  const slots = slotsForDay({
    opensAtMinute: settings.opensAtMinute,
    closesAtMinute: settings.closesAtMinute,
    slotMinutes: settings.slotMinutes,
  });
  const slot = slots.find((candidate) => candidate.startMinute === options.startMinute);
  if (!slot) return { ok: false, problem: "bad-slot" };

  const date = parseAccountingDate(options.date);
  if (!date) return { ok: false, problem: "bad-slot" };

  const horizon = offeredDates(settings, company.operatingTimeZone, now);
  if (!horizon.includes(options.date)) return { ok: false, problem: "past" };

  const today = venueToday(company.operatingTimeZone, now);
  if (options.date === today && slot.startMinute <= venueMinuteNow(company.operatingTimeZone, now)) {
    return { ok: false, problem: "past" };
  }

  // Priced from the stored rates, never from the request. A posted amount is
  // a number a stranger chose.
  const price = priceFor({
    rates,
    unitId: unit.id,
    dayOfWeek: date.getUTCDay(),
    startMinute: slot.startMinute,
  });
  if (!price) return { ok: false, problem: "no-price" };

  // An expired hold on this slot is cleared first, so the unique index does
  // not refuse a slot nobody is actually holding.
  await prisma.booking.updateMany({
    where: {
      unitId: unit.id,
      date,
      startMinute: slot.startMinute,
      status: "HELD",
      heldUntil: { lte: now },
    },
    data: { status: "CANCELLED", cancelledAt: now, cancelReason: "Hold expired" },
  });

  try {
    const booking = await prisma.booking.create({
      data: {
        companyId: settings.companyId,
        unitId: unit.id,
        reference: bookingReference(),
        date,
        startMinute: slot.startMinute,
        endMinute: slot.endMinute,
        status: "HELD",
        amount: price.amount.toFixed(2),
        currency: company.baseCurrency,
        rateLabel: price.label,
        customerName: name,
        customerEmail: email,
        customerPhone: options.customerPhone?.trim() || null,
        note: options.note?.trim() || null,
        userId: options.userId ?? null,
        heldUntil: new Date(now.getTime() + settings.holdMinutes * 60_000),
      },
    });
    return { ok: true, booking };
  } catch (error) {
    // The partial unique index is what actually decides who got the slot.
    // Checking first and writing after leaves a window two clicks can fit in.
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return { ok: false, problem: "taken" };
    }
    throw error;
  }
}

/** One booking by its reference, for the page the booker lands on. */
export async function bookingByReference(slug: string, reference: string) {
  const settings = await prisma.bookingSettings.findUnique({ where: { slug } });
  if (!settings) return null;
  return prisma.booking.findFirst({
    where: { companyId: settings.companyId, reference: reference.trim().toUpperCase() },
    include: { unit: true, company: { select: { name: true, baseCurrency: true } } },
  });
}

export { money };
