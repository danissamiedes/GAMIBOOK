import { beforeEach, describe, expect, it } from "vitest";
import {
  createBookingGroup,
  dayGrid,
  offeredDates,
  publicVenue,
  venueToday,
  MAX_SLOTS_PER_BOOKING,
} from "@/lib/bookings/book";
import { formatMinute, parseMinute, priceFor, slotsForDay } from "@/lib/bookings/slots";
import { expireStaleHolds, isExpiredHold } from "@/lib/bookings/expire";
import { submitProof } from "@/lib/bookings/payment";
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
    units.push(await prisma.bookableUnit.create({ data: { companyId, name, sortOrder: index } }));
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

const booker = { customerName: "Juan Dela Cruz", customerEmail: "juan@example.com" };

describe("slots (SPEC §17)", () => {
  it("offers every whole slot between opening and closing, and no part one", () => {
    const slots = slotsForDay({ opensAtMinute: 420, closesAtMinute: 1380, slotMinutes: 60 });
    expect(slots).toHaveLength(16);
    expect(slots[0]).toMatchObject({ startMinute: 420, label: "7:00 AM" });
    expect(slots.at(-1)).toMatchObject({
      startMinute: 1320,
      label: "10:00 PM",
      endLabel: "11:00 PM",
    });
  });

  it("does not sell an hour that runs past closing", () => {
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
      id: "r",
      companyId: "c",
      label: "Base",
      amount: "100.00",
      daysOfWeek: [],
      startMinute: 0,
      endMinute: 1440,
      unitId: null,
      priority: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
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
    expect(priceFor({ rates, unitId: "u1", dayOfWeek: 3, startMinute: 600 })?.label).toBe(
      "Standard",
    );
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
    expect(priceFor({ rates: [], unitId: "u", dayOfWeek: 3, startMinute: 600 })).toBeNull();
  });
});

describe("booking one slot (SPEC §17)", () => {
  it("books it, prices it from the stored rates, and holds it", async () => {
    const { units } = await pickleFarm();
    const result = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[0].id, startMinute: 13 * 60 }],
      date: soon(),
      ...booker,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.amount.toString()).toBe("200");
    expect(result.group.status).toBe("HELD");
    expect(result.group.heldUntil).not.toBeNull();
    expect(result.group.reference).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    expect(result.group.bookings).toHaveLength(1);
    expect(result.group.bookings[0].rateLabel).toBe("Off-Peak");
  });

  it("charges the peak rate in the evening", async () => {
    const { units } = await pickleFarm();
    const result = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[0].id, startMinute: 19 * 60 }],
      date: soon(),
      ...booker,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.amount.toString()).toBe("350");
  });

  it("books as a guest with no account at all", async () => {
    const { units } = await pickleFarm();
    const result = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[0].id, startMinute: 600 }],
      date: soon(),
      ...booker,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.userId).toBeNull();
  });
});

describe("booking several slots at once (SPEC §17)", () => {
  it("takes consecutive hours on one court as one booking and one total", async () => {
    // 7am to 9am on court 1 — two slots, one payment.
    const { units } = await pickleFarm();
    const result = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [
        { unitId: units[0].id, startMinute: 7 * 60 },
        { unitId: units[0].id, startMinute: 8 * 60 },
      ],
      date: soon(),
      ...booker,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.bookings).toHaveLength(2);
    expect(result.group.amount.toString()).toBe("400");
    // One reference for the lot: the booker quotes one thing at the desk.
    expect(await prisma.bookingGroup.count()).toBe(1);
  });

  it("takes the same hour across several courts as one booking", async () => {
    // 9am to 10am on courts 1, 2 and 3.
    const { units } = await pickleFarm();
    const result = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: units.map((unit) => ({ unitId: unit.id, startMinute: 9 * 60 })),
      date: soon(),
      ...booker,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.bookings).toHaveLength(3);
    expect(result.group.amount.toString()).toBe("600");
    expect(new Set(result.group.bookings.map((slot) => slot.unitId)).size).toBe(3);
  });

  it("totals a mix of peak and off-peak correctly", async () => {
    const { units } = await pickleFarm();
    const result = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [
        { unitId: units[0].id, startMinute: 16 * 60 }, // 200 off-peak
        { unitId: units[0].id, startMinute: 17 * 60 }, // 350 peak
      ],
      date: soon(),
      ...booker,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.amount.toString()).toBe("550");
  });

  it("counts the same slot ticked twice once", async () => {
    const { units } = await pickleFarm();
    const result = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [
        { unitId: units[0].id, startMinute: 600 },
        { unitId: units[0].id, startMinute: 600 },
      ],
      date: soon(),
      ...booker,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.bookings).toHaveLength(1);
    expect(result.group.amount.toString()).toBe("200");
  });

  it("writes nothing at all when one slot of several is already taken", async () => {
    // A group that booked three of four and failed on the fourth would be a
    // partial booking nobody asked for and nobody could price.
    const { units } = await pickleFarm();
    const date = soon();
    await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[1].id, startMinute: 9 * 60 }],
      date,
      ...booker,
    });

    const result = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: units.map((unit) => ({ unitId: unit.id, startMinute: 9 * 60 })),
      date,
      customerName: "Maria",
      customerEmail: "maria@example.com",
    });

    expect(result).toEqual({ ok: false, problem: "taken" });
    // Only the original single-slot booking survives.
    expect(await prisma.bookingGroup.count()).toBe(1);
    expect(await prisma.booking.count()).toBe(1);
  });

  it("refuses an empty selection", async () => {
    await pickleFarm();
    expect(
      await createBookingGroup({
        slug: "the-pickle-farm",
        picks: [],
        date: soon(),
        ...booker,
      }),
    ).toEqual({ ok: false, problem: "empty" });
  });

  it("caps how much of a day one booking can take", async () => {
    // A public form should not be able to empty a venue's calendar in one go.
    const { units } = await pickleFarm();
    const picks = Array.from({ length: MAX_SLOTS_PER_BOOKING + 1 }, (_, index) => ({
      unitId: units[index % 3].id,
      startMinute: (7 + Math.floor(index / 3)) * 60,
    }));
    expect(
      await createBookingGroup({ slug: "the-pickle-farm", picks, date: soon(), ...booker }),
    ).toEqual({ ok: false, problem: "too-many" });
  });

  it("refuses the whole group if any slot has no price", async () => {
    const { units } = await pickleFarm();
    // Nothing prices 6am; it is before the first rate's window.
    await prisma.bookingSettings.update({
      where: { slug: "the-pickle-farm" },
      data: { opensAtMinute: 6 * 60 },
    });
    const result = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [
        { unitId: units[0].id, startMinute: 6 * 60 },
        { unitId: units[0].id, startMinute: 8 * 60 },
      ],
      date: soon(),
      ...booker,
    });
    expect(result).toEqual({ ok: false, problem: "no-price" });
    expect(await prisma.bookingGroup.count()).toBe(0);
  });
});

describe("who gets the slot (SPEC §17)", () => {
  it("refuses the same slot twice — the database decides, not a prior check", async () => {
    const { units } = await pickleFarm();
    const picks = [{ unitId: units[0].id, startMinute: 600 }];
    const date = soon();

    const [first, second] = await Promise.all([
      createBookingGroup({ slug: "the-pickle-farm", picks, date, ...booker }),
      createBookingGroup({
        slug: "the-pickle-farm",
        picks,
        date,
        customerName: "Maria",
        customerEmail: "maria@example.com",
      }),
    ]);

    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    const loser = first.ok ? second : first;
    expect(loser).toEqual({ ok: false, problem: "taken" });
    expect(await prisma.booking.count()).toBe(1);
  });

  it("leaves the same hour on another court free", async () => {
    const { units } = await pickleFarm();
    const date = soon();
    for (const unit of units.slice(0, 2)) {
      const result = await createBookingGroup({
        slug: "the-pickle-farm",
        picks: [{ unitId: unit.id, startMinute: 600 }],
        date,
        ...booker,
      });
      expect(result.ok).toBe(true);
    }
  });

  it("re-sells a slot whose hold has expired, cancelling the whole stale group", async () => {
    const { units } = await pickleFarm();
    const date = soon();
    const first = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [
        { unitId: units[0].id, startMinute: 600 },
        { unitId: units[1].id, startMinute: 600 },
      ],
      date,
      ...booker,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await prisma.bookingGroup.update({
      where: { id: first.group.id },
      data: { heldUntil: new Date(Date.now() - 1000) },
    });

    const second = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[0].id, startMinute: 600 }],
      date,
      customerName: "Maria",
      customerEmail: "maria@example.com",
    });
    expect(second.ok).toBe(true);

    const expired = await prisma.bookingGroup.findUniqueOrThrow({
      where: { id: first.group.id },
      include: { bookings: true },
    });
    // The group goes, and every slot with it: half an expired booking is not
    // a state anybody can act on.
    expect(expired.status).toBe("CANCELLED");
    expect(expired.bookings.every((slot) => slot.status === "CANCELLED")).toBe(true);
  });
});

describe("what a booking refuses (SPEC §17)", () => {
  it("refuses a slot the venue does not offer", async () => {
    const { units } = await pickleFarm();
    expect(
      await createBookingGroup({
        slug: "the-pickle-farm",
        picks: [{ unitId: units[0].id, startMinute: 6 * 60 }],
        date: soon(),
        ...booker,
      }),
    ).toEqual({ ok: false, problem: "bad-slot" });
  });

  it("refuses a date beyond the horizon, and one in the past", async () => {
    const { units } = await pickleFarm();
    const picks = [{ unitId: units[0].id, startMinute: 600 }];
    expect(
      await createBookingGroup({ slug: "the-pickle-farm", picks, date: soon(60), ...booker }),
    ).toEqual({ ok: false, problem: "past" });
    expect(
      await createBookingGroup({ slug: "the-pickle-farm", picks, date: soon(-2), ...booker }),
    ).toEqual({ ok: false, problem: "past" });
  });

  it("refuses a unit belonging to another venue", async () => {
    await pickleFarm();
    const other = await makeCompanyWithChart("Another Venue");
    const theirs = await prisma.bookableUnit.create({
      data: { companyId: other.company.id, name: "Their Court" },
    });

    expect(
      await createBookingGroup({
        slug: "the-pickle-farm",
        picks: [{ unitId: theirs.id, startMinute: 600 }],
        date: soon(),
        ...booker,
      }),
    ).toEqual({ ok: false, problem: "unknown-unit" });
  });

  it("refuses an unpublished venue outright", async () => {
    const { units } = await pickleFarm();
    await prisma.bookingSettings.update({
      where: { slug: "the-pickle-farm" },
      data: { isPublished: false },
    });
    expect(
      await createBookingGroup({
        slug: "the-pickle-farm",
        picks: [{ unitId: units[0].id, startMinute: 600 }],
        date: soon(),
        ...booker,
      }),
    ).toEqual({ ok: false, problem: "closed" });
    expect(await publicVenue("the-pickle-farm")).toBeNull();
  });

  it("needs a name and a real-looking email", async () => {
    const { units } = await pickleFarm();
    const common = {
      slug: "the-pickle-farm",
      picks: [{ unitId: units[0].id, startMinute: 600 }],
      date: soon(),
    };
    expect(
      await createBookingGroup({ ...common, customerName: "  ", customerEmail: "a@b.co" }),
    ).toEqual({ ok: false, problem: "name" });
    expect(
      await createBookingGroup({ ...common, customerName: "Juan", customerEmail: "nope" }),
    ).toEqual({ ok: false, problem: "email" });
  });
});

describe("the public grid (SPEC §17)", () => {
  it("marks held slots pending and confirmed ones taken", async () => {
    const { units } = await pickleFarm();
    const date = soon();
    await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[0].id, startMinute: 600 }],
      date,
      ...booker,
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
    // A fresh booking is held, not paid for: the grid says so rather than
    // telling a stranger the court is gone when the hold may yet lapse.
    expect(grid.cells.get(`${units[0].id}:600`)?.unavailable).toBe("pending");
    expect(grid.cells.get(`${units[1].id}:600`)?.unavailable).toBeNull();
    expect(grid.cells.get(`${units[1].id}:600`)?.amount?.toFixed(2)).toBe("200.00");
    expect(grid.cells.get(`${units[1].id}:1140`)?.amount?.toFixed(2)).toBe("350.00");
  });

  it("marks a confirmed slot taken", async () => {
    const { units } = await pickleFarm();
    const date = soon();
    const booked = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[0].id, startMinute: 600 }],
      date,
      ...booker,
    });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;
    await prisma.bookingGroup.update({
      where: { id: booked.group.id },
      data: {
        status: "CONFIRMED",
        bookings: { updateMany: { where: {}, data: { status: "CONFIRMED" } } },
      },
    });

    const venue = (await publicVenue("the-pickle-farm"))!;
    const grid = await dayGrid({
      settings: venue.settings,
      units: venue.units,
      rates: venue.rates,
      date,
      timeZone: "Asia/Manila",
    });
    expect(grid.cells.get(`${units[0].id}:600`)?.unavailable).toBe("taken");
  });

  it("puts an expired hold's slots back on the grid", async () => {
    const { units } = await pickleFarm();
    const date = soon();
    const held = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[0].id, startMinute: 600 }],
      date,
      ...booker,
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    await prisma.bookingGroup.update({
      where: { id: held.group.id },
      data: { heldUntil: new Date(Date.now() - 1000) },
    });

    const venue = (await publicVenue("the-pickle-farm"))!;
    const grid = await dayGrid({
      settings: venue.settings,
      units: venue.units,
      rates: venue.rates,
      date,
      timeZone: "Asia/Manila",
    });
    expect(grid.cells.get(`${units[0].id}:600`)?.unavailable).toBeNull();
  });

  it("offers exactly the horizon, starting with today in the venue's zone", async () => {
    await pickleFarm();
    const venue = (await publicVenue("the-pickle-farm"))!;
    const dates = offeredDates(venue.settings, "Asia/Manila");
    expect(dates).toHaveLength(14);
    expect(dates[0]).toBe(venueToday("Asia/Manila"));
  });
});

describe("a hold that runs out (SPEC §17)", () => {
  /** Book a slot and move its deadline into the past. */
  async function lapsedHold() {
    const { units } = await pickleFarm();
    const date = soon();
    const held = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[0].id, startMinute: 600 }],
      date,
      ...booker,
    });
    if (!held.ok) throw new Error("fixture did not book");
    const group = await prisma.bookingGroup.update({
      where: { id: held.group.id },
      data: { heldUntil: new Date(Date.now() - 60_000) },
    });
    return { units, date, group };
  }

  it("is expired at read time, with no sweep having run", async () => {
    const { group } = await lapsedHold();
    expect(isExpiredHold(group)).toBe(true);
    // Still HELD in the database — nothing has written anything yet.
    expect(group.status).toBe("HELD");
  });

  it("refuses proof of payment for slots that are back on the market", async () => {
    const { group } = await lapsedHold();
    const result = await submitProof({
      slug: "the-pickle-farm",
      reference: group.reference,
      file: { name: "receipt.png", bytes: Buffer.from("x"), mimeType: "image/png" },
    });
    expect(result).toEqual({ ok: false, problem: "expired" });
  });

  it("cancels the group and releases its slots when swept", async () => {
    const { units, date, group } = await lapsedHold();

    const swept = await expireStaleHolds();
    expect(swept.expired).toBe(1);

    const after = await prisma.bookingGroup.findUniqueOrThrow({
      where: { id: group.id },
      include: { bookings: true },
    });
    expect(after.status).toBe("CANCELLED");
    expect(after.heldUntil).toBeNull();
    expect(after.bookings.every((slot) => slot.status === "CANCELLED")).toBe(true);

    // And the court is bookable again, rather than merely hidden from the grid.
    const retry = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[0].id, startMinute: 600 }],
      date,
      ...booker,
    });
    expect(retry.ok).toBe(true);
  });

  it("leaves a hold that is still running, and a booking already paid", async () => {
    const { units } = await pickleFarm();
    const date = soon();
    const live = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[0].id, startMinute: 600 }],
      date,
      ...booker,
    });
    const paid = await createBookingGroup({
      slug: "the-pickle-farm",
      picks: [{ unitId: units[1].id, startMinute: 600 }],
      date,
      ...booker,
    });
    if (!live.ok || !paid.ok) throw new Error("fixture did not book");
    await prisma.bookingGroup.update({
      where: { id: paid.group.id },
      // Paid for, so the hold was cleared: a sweep must never touch it, however
      // long it sits waiting for somebody to check the proof.
      data: { status: "PAYMENT_SUBMITTED", heldUntil: null },
    });

    expect((await expireStaleHolds()).expired).toBe(0);
    expect(
      (await prisma.bookingGroup.findUniqueOrThrow({ where: { id: live.group.id } })).status,
    ).toBe("HELD");
    expect(
      (await prisma.bookingGroup.findUniqueOrThrow({ where: { id: paid.group.id } })).status,
    ).toBe("PAYMENT_SUBMITTED");
  });
});
