import { beforeEach, describe, expect, it } from "vitest";
import { createBooking, dayGrid, offeredDates, publicVenue, venueToday } from "@/lib/bookings/book";
import { formatMinute, parseMinute, priceFor, slotsForDay } from "@/lib/bookings/slots";
import { prisma, resetDatabase, makeCompanyWithChart } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
});

/** A venue that opens 7am–11pm with three courts and peak/off-peak pricing. */
async function pickleFarm() {
  const fixture = await makeCompanyWithChart("The Pickle Farm");
  const companyId = fixture.company.id;

  await prisma.bookingSettings.create({
    data: {
      companyId,
      slug: "the-pickle-farm",
      isPublished: true,
      unitLabel: "Court",
      unitLabelPlural: "Courts",
      venueName: "THE PICKLE FARM",
      opensAtMinute: 7 * 60,
      closesAtMinute: 23 * 60,
      slotMinutes: 60,
      horizonDays: 14,
      holdMinutes: 120,
    },
  });

  const units = [];
  for (const [index, name] of ["Court 1", "Court 2", "Court 3"].entries()) {
    units.push(
      await prisma.bookableUnit.create({ data: { companyId, name, sortOrder: index } }),
    );
  }

  await prisma.bookingRate.create({
    data: {
      companyId,
      label: "Off-Peak",
      amount: "200.00",
      daysOfWeek: [],
      startMinute: 7 * 60,
      endMinute: 17 * 60,
    },
  });
  await prisma.bookingRate.create({
    data: {
      companyId,
      label: "Peak",
      amount: "350.00",
      daysOfWeek: [],
      startMinute: 17 * 60,
      endMinute: 23 * 60,
    },
  });

  return { fixture, companyId, units };
}

/** A date inside the horizon, so "past" never decides a test by accident. */
function soon(days = 3): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe("slots (SPEC §17)", () => {
  it("offers every whole slot between opening and closing, and no part one", () => {
    const slots = slotsForDay({ opensAtMinute: 420, closesAtMinute: 1380, slotMinutes: 60 });
    expect(slots).toHaveLength(16);
    expect(slots[0]).toMatchObject({ startMinute: 420, label: "7:00 AM" });
    expect(slots.at(-1)).toMatchObject({ startMinute: 1320, label: "10:00 PM", endLabel: "11:00 PM" });
  });

  it("does not sell an hour that runs past closing", () => {
    // Closing at 23:30 with hour slots means the 23:00 slot cannot be offered.
    const slots = slotsForDay({ opensAtMinute: 1320, closesAtMinute: 1410, slotMinutes: 60 });
    expect(slots).toHaveLength(1);
    expect(slots[0].startMinute).toBe(1320);
  });

  it("reads and writes the times a person recognises", () => {
    expect(formatMinute(0)).toBe("12:00 AM");
    expect(formatMinute(720)).toBe("12:00 PM");
    expect(formatMinute(1380)).toBe("11:00 PM");
    expect(parseMinute("7:00 AM")).toBe(420);
    expect(parseMinute("12:00 AM")).toBe(0);
    expect(parseMinute("23:00")).toBe(1380);
    expect(parseMinute("nonsense")).toBeNull();
  });
});

describe("pricing (SPEC §17)", () => {
  const rate = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      id: "r", companyId: "c", label: "Base", amount: "100.00", daysOfWeek: [],
      startMinute: 0, endMinute: 1440, unitId: null, priority: 0,
      createdAt: new Date(), updatedAt: new Date(), ...over,
    }) as never;

  it("picks the rate whose window the slot starts in", () => {
    const rates = [
      rate({ label: "Off-Peak", amount: "200.00", startMinute: 420, endMinute: 1020 }),
      rate({ label: "Peak", amount: "350.00", startMinute: 1020, endMinute: 1380 }),
    ];
    expect(priceFor({ rates, unitId: "u", dayOfWeek: 3, startMinute: 600 })?.label).toBe("Off-Peak");
    expect(priceFor({ rates, unitId: "u", dayOfWeek: 3, startMinute: 1020 })?.label).toBe("Peak");
  });

  it("lets a rule for one unit beat the general one", () => {
    const rates = [
      rate({ label: "Standard", amount: "200.00" }),
      rate({ label: "Premium court", amount: "500.00", unitId: "u2" }),
    ];
    expect(priceFor({ rates, unitId: "u1", dayOfWeek: 3, startMinute: 600 })?.label).toBe("Standard");
    expect(priceFor({ rates, unitId: "u2", dayOfWeek: 3, startMinute: 600 })?.label).toBe(
      "Premium court",
    );
  });

  it("honours priority over specificity when they disagree", () => {
    const rates = [
      rate({ label: "Holiday", amount: "600.00", priority: 10 }),
      rate({ label: "Court rule", amount: "500.00", unitId: "u1", priority: 0 }),
    ];
    expect(priceFor({ rates, unitId: "u1", dayOfWeek: 3, startMinute: 600 })?.label).toBe("Holiday");
  });

  it("limits a weekday rule to its days", () => {
    const rates = [rate({ label: "Weekend", amount: "400.00", daysOfWeek: [0, 6] })];
    expect(priceFor({ rates, unitId: "u", dayOfWeek: 6, startMinute: 600 })?.label).toBe("Weekend");
    expect(priceFor({ rates, unitId: "u", dayOfWeek: 3, startMinute: 600 })).toBeNull();
  });

  it("returns nothing rather than zero when no rate covers the slot", () => {
    // A court with no price is misconfigured. Selling it for nothing is the
    // worst possible reading of that.
    expect(priceFor({ rates: [], unitId: "u", dayOfWeek: 3, startMinute: 600 })).toBeNull();
  });
});

describe("taking a booking (SPEC §17)", () => {
  const booker = {
    customerName: "Juan Dela Cruz",
    customerEmail: "juan@example.com",
  };

  it("books a slot, prices it from the stored rates and holds it", async () => {
    const { units } = await pickleFarm();
    const result = await createBooking({
      slug: "the-pickle-farm",
      unitId: units[0].id,
      date: soon(),
      startMinute: 13 * 60,
      ...booker,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.booking.amount.toString()).toBe("200");
    expect(result.booking.rateLabel).toBe("Off-Peak");
    expect(result.booking.status).toBe("HELD");
    expect(result.booking.heldUntil).not.toBeNull();
    expect(result.booking.reference).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
  });

  it("charges the peak rate in the evening", async () => {
    const { units } = await pickleFarm();
    const result = await createBooking({
      slug: "the-pickle-farm",
      unitId: units[0].id,
      date: soon(),
      startMinute: 19 * 60,
      ...booker,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.booking.amount.toString()).toBe("350");
    expect(result.booking.rateLabel).toBe("Peak");
  });

  it("refuses the same slot twice — the database decides, not a prior check", async () => {
    // Two people can press Book in the same second. The loser must find out
    // here rather than when the other turns up at the court.
    const { units } = await pickleFarm();
    const slot = { slug: "the-pickle-farm", unitId: units[0].id, date: soon(), startMinute: 600 };

    const [first, second] = await Promise.all([
      createBooking({ ...slot, ...booker }),
      createBooking({ ...slot, customerName: "Maria", customerEmail: "maria@example.com" }),
    ]);

    const outcomes = [first.ok, second.ok].sort();
    expect(outcomes).toEqual([false, true]);
    const loser = first.ok ? second : first;
    expect(loser).toEqual({ ok: false, problem: "taken" });
    expect(await prisma.booking.count()).toBe(1);
  });

  it("leaves the same hour on another court free", async () => {
    const { units } = await pickleFarm();
    const common = { slug: "the-pickle-farm", date: soon(), startMinute: 600, ...booker };
    expect((await createBooking({ ...common, unitId: units[0].id })).ok).toBe(true);
    expect((await createBooking({ ...common, unitId: units[1].id })).ok).toBe(true);
  });

  it("re-sells a slot whose hold has expired", async () => {
    const { units } = await pickleFarm();
    const slot = { slug: "the-pickle-farm", unitId: units[0].id, date: soon(), startMinute: 600 };

    const first = await createBooking({ ...slot, ...booker });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await prisma.booking.update({
      where: { id: first.booking.id },
      data: { heldUntil: new Date(Date.now() - 1000) },
    });

    const second = await createBooking({
      ...slot,
      customerName: "Maria",
      customerEmail: "maria@example.com",
    });
    expect(second.ok).toBe(true);

    const expired = await prisma.booking.findUniqueOrThrow({ where: { id: first.booking.id } });
    expect(expired.status).toBe("CANCELLED");
  });

  it("refuses a slot the venue does not offer", async () => {
    const { units } = await pickleFarm();
    // 6am — before opening, so it is not one of the day's slots at all.
    const result = await createBooking({
      slug: "the-pickle-farm",
      unitId: units[0].id,
      date: soon(),
      startMinute: 6 * 60,
      ...booker,
    });
    expect(result).toEqual({ ok: false, problem: "bad-slot" });
  });

  it("refuses a date beyond the horizon, and one in the past", async () => {
    const { units } = await pickleFarm();
    const common = { slug: "the-pickle-farm", unitId: units[0].id, startMinute: 600, ...booker };
    expect(await createBooking({ ...common, date: soon(60) })).toEqual({
      ok: false,
      problem: "past",
    });
    expect(await createBooking({ ...common, date: soon(-2) })).toEqual({
      ok: false,
      problem: "past",
    });
  });

  it("refuses a unit belonging to another venue", async () => {
    // The company comes from the slug. Nothing the form says decides whose
    // books a booking lands in.
    const { units } = await pickleFarm();
    const other = await makeCompanyWithChart("Another Venue");
    const theirs = await prisma.bookableUnit.create({
      data: { companyId: other.company.id, name: "Their Court" },
    });

    const result = await createBooking({
      slug: "the-pickle-farm",
      unitId: theirs.id,
      date: soon(),
      startMinute: 600,
      ...booker,
    });
    expect(result).toEqual({ ok: false, problem: "unknown-unit" });
    expect(units.length).toBe(3);
  });

  it("refuses an unpublished venue outright", async () => {
    const { units } = await pickleFarm();
    await prisma.bookingSettings.update({
      where: { slug: "the-pickle-farm" },
      data: { isPublished: false },
    });
    expect(
      await createBooking({
        slug: "the-pickle-farm",
        unitId: units[0].id,
        date: soon(),
        startMinute: 600,
        ...booker,
      }),
    ).toEqual({ ok: false, problem: "closed" });
    expect(await publicVenue("the-pickle-farm")).toBeNull();
  });

  it("needs a name and a real-looking email", async () => {
    const { units } = await pickleFarm();
    const common = { slug: "the-pickle-farm", unitId: units[0].id, date: soon(), startMinute: 600 };
    expect(
      await createBooking({ ...common, customerName: "  ", customerEmail: "a@b.co" }),
    ).toEqual({ ok: false, problem: "name" });
    expect(
      await createBooking({ ...common, customerName: "Juan", customerEmail: "not-an-email" }),
    ).toEqual({ ok: false, problem: "email" });
  });

  it("books as a guest with no account at all", async () => {
    const { units } = await pickleFarm();
    const result = await createBooking({
      slug: "the-pickle-farm",
      unitId: units[0].id,
      date: soon(),
      startMinute: 600,
      ...booker,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.booking.userId).toBeNull();
  });
});

describe("the public grid (SPEC §17)", () => {
  it("marks taken slots and prices the rest", async () => {
    const { companyId, units } = await pickleFarm();
    const date = soon();
    await createBooking({
      slug: "the-pickle-farm",
      unitId: units[0].id,
      date,
      startMinute: 600,
      customerName: "Juan",
      customerEmail: "juan@example.com",
    });

    const venue = (await publicVenue("the-pickle-farm"))!;
    const grid = await dayGrid({
      settings: venue.settings,
      units: venue.units,
      rates: venue.rates,
      date,
      timeZone: "Asia/Manila",
    });

    expect(grid.units).toHaveLength(3);
    expect(grid.slots).toHaveLength(16);
    expect(grid.cells.get(`${units[0].id}:600`)?.unavailable).toBe("taken");
    // Same hour, different court — still for sale.
    expect(grid.cells.get(`${units[1].id}:600`)?.unavailable).toBeNull();
    expect(grid.cells.get(`${units[1].id}:600`)?.amount?.toFixed(2)).toBe("200.00");
    expect(grid.cells.get(`${units[1].id}:1140`)?.amount?.toFixed(2)).toBe("350.00");
    expect(companyId).toBeTruthy();
  });

  it("offers exactly the horizon, starting with today in the venue's zone", async () => {
    const venue = (await publicVenue("the-pickle-farm")) ?? (await pickleFarm(), (await publicVenue("the-pickle-farm"))!);
    const dates = offeredDates(venue.settings, "Asia/Manila");
    expect(dates).toHaveLength(14);
    expect(dates[0]).toBe(venueToday("Asia/Manila"));
  });
});
