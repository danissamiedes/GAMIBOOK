import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ClockError,
  adminUpsertEntry,
  autoCloseStaleEntries,
  clockIn,
  clockOut,
  requestCorrection,
} from "@/lib/time/clock";
import { timesheet, openEntries, flaggedEntries } from "@/lib/time/report";
import {
  dayBounds,
  formatDuration,
  parseLocalDateTime,
  workDayKey,
  weekBounds,
} from "@/lib/time/zone";
import { makeCompanyWithChart, makeUser, makeVendor, prisma, resetDatabase } from "./helpers";

const MANILA = "Asia/Manila";

describe("Manila time handling (SPEC §9)", () => {
  it("puts a shift on the day it started in Manila, not the UTC day", () => {
    // 23:30 PHT on 10 March is 15:30 UTC the same day.
    const lateStart = parseLocalDateTime("2026-03-10T23:30", MANILA)!;
    expect(lateStart.toISOString()).toBe("2026-03-10T15:30:00.000Z");
    expect(workDayKey(lateStart, MANILA)).toBe("2026-03-10");

    // 01:15 PHT the next morning is 17:15 UTC on the 10th — still "the 11th"
    // locally, which is why the UTC date cannot be used for grouping.
    const earlyFinish = parseLocalDateTime("2026-03-11T01:15", MANILA)!;
    expect(earlyFinish.toISOString()).toBe("2026-03-10T17:15:00.000Z");
    expect(workDayKey(earlyFinish, MANILA)).toBe("2026-03-11");
  });

  it("bounds a local day correctly", () => {
    const { start, end } = dayBounds("2026-03-10", MANILA);
    expect(start.toISOString()).toBe("2026-03-09T16:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-10T16:00:00.000Z");
  });

  it("uses the real zone rather than a fixed offset", () => {
    // New York observes DST; the same wall-clock time maps to different UTC
    // instants in January and July. Hardcoding an offset would break this.
    const winter = parseLocalDateTime("2026-01-15T09:00", "America/New_York")!;
    const summer = parseLocalDateTime("2026-07-15T09:00", "America/New_York")!;
    expect(winter.toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(summer.toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("builds a Monday-based week of local day keys", () => {
    const wednesday = parseLocalDateTime("2026-03-11T10:00", MANILA)!;
    const week = weekBounds(wednesday, MANILA);
    expect(week.dayKeys).toEqual([
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
      "2026-03-14",
      "2026-03-15",
    ]);
  });

  it("formats durations for people", () => {
    expect(formatDuration(0)).toBe("0h 00m");
    expect(formatDuration(105)).toBe("1h 45m");
    expect(formatDuration(600)).toBe("10h 00m");
  });
});

describe("the clock", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;
  let consultant: Awaited<ReturnType<typeof makeVendor>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Clock Co", "PHP");
    consultant = await makeVendor(fixture.company.id, "CONSULTANT", { name: "Abigail" });
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const at = (local: string) => parseLocalDateTime(local, MANILA)!;

  it("records a shift and stores its duration on clock-out", async () => {
    await clockIn({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T09:02"),
    });
    const entry = await clockOut({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T17:30"),
    });

    expect(entry.durationMinutes).toBe(508);
    expect(entry.source).toBe("SELF");
  });

  it("blocks a second clock-in while one is open", async () => {
    await clockIn({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T09:00"),
    });
    await expect(
      clockIn({
        companyId: fixture.company.id,
        consultantId: consultant.id,
        at: at("2026-03-10T10:00"),
      }),
    ).rejects.toBeInstanceOf(ClockError);

    expect(await prisma.timeEntry.count({ where: { clockOutAt: null } })).toBe(1);
  });

  it("refuses to clock out when nothing is open, or backwards in time", async () => {
    await expect(
      clockOut({ companyId: fixture.company.id, consultantId: consultant.id }),
    ).rejects.toThrow(/not clocked in/);

    await clockIn({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T09:00"),
    });
    await expect(
      clockOut({
        companyId: fixture.company.id,
        consultantId: consultant.id,
        at: at("2026-03-10T08:00"),
      }),
    ).rejects.toThrow(/cannot be before/);
  });

  it("keeps a cross-midnight shift on the day it started", async () => {
    // The case SPEC §9 asks for by name: 23:30 PHT to 01:15 PHT next day.
    await clockIn({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T23:30"),
    });
    const entry = await clockOut({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-11T01:15"),
    });

    expect(entry.durationMinutes).toBe(105);

    const sheet = await timesheet({
      companyId: fixture.company.id,
      timeZone: MANILA,
      fromDayKey: "2026-03-09",
      toDayKey: "2026-03-12",
    });

    const row = sheet.rows[0];
    // All 105 minutes land on the 10th; the 11th shows nothing.
    expect(row.cells.get("2026-03-10")?.minutes).toBe(105);
    expect(row.cells.get("2026-03-11")).toBeUndefined();
    expect(sheet.dayTotals.get("2026-03-10")).toBe(105);
    expect(row.totalMinutes).toBe(105);
  });

  it("auto-closes a shift left running, and flags it for review", async () => {
    await clockIn({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T09:00"),
    });

    // Nothing happens before the limit...
    const early = await autoCloseStaleEntries(at("2026-03-10T20:00"));
    expect(early.closed).toBe(0);

    // ...and after it, the entry is closed at the limit and flagged, not
    // guessed at some later time.
    const result = await autoCloseStaleEntries(at("2026-03-11T09:00"));
    expect(result.closed).toBe(1);

    const entry = await prisma.timeEntry.findFirstOrThrow({});
    expect(entry.source).toBe("AUTO_CLOSED");
    expect(entry.durationMinutes).toBe(16 * 60);
    expect(entry.clockOutAt?.toISOString()).toBe(at("2026-03-11T01:00").toISOString());
    expect(entry.correctionRequest).toMatch(/closed automatically/);
  });

  it("lets a consultant flag a row without changing the recorded time", async () => {
    await clockIn({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T09:00"),
    });
    const entry = await clockOut({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T17:00"),
    });

    await requestCorrection({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      entryId: entry.id,
      message: "I actually finished at 6pm",
    });

    const flagged = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(flagged.correctionRequest).toBe("I actually finished at 6pm");
    // The time itself is untouched: only an admin can change it.
    expect(flagged.clockOutAt?.toISOString()).toBe(at("2026-03-10T17:00").toISOString());
    expect(flagged.durationMinutes).toBe(480);

    expect(await flaggedEntries(fixture.company.id)).toHaveLength(1);
  });

  it("keeps the original values and a reason when an admin edits", async () => {
    const admin = await makeUser("OWNER", fixture.company.id);
    await clockIn({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T09:00"),
    });
    const entry = await clockOut({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T17:00"),
    });

    const edited = await adminUpsertEntry({
      companyId: fixture.company.id,
      entryId: entry.id,
      consultantId: consultant.id,
      clockInAt: at("2026-03-10T09:00"),
      clockOutAt: at("2026-03-10T18:00"),
      editReason: "Consultant reported finishing at 6pm",
      userId: admin.id,
    });

    expect(edited.source).toBe("ADMIN_EDITED");
    expect(edited.durationMinutes).toBe(540);
    expect(edited.originalClockOutAt?.toISOString()).toBe(at("2026-03-10T17:00").toISOString());
    expect(edited.editedByUserId).toBe(admin.id);

    const audit = await prisma.auditLog.findFirst({ where: { action: "time_entry.edited" } });
    expect(audit?.summary).toMatch(/finishing at 6pm/);
  });

  it("insists an admin edit carries a reason", async () => {
    const admin = await makeUser("OWNER", fixture.company.id);
    await expect(
      adminUpsertEntry({
        companyId: fixture.company.id,
        consultantId: consultant.id,
        clockInAt: at("2026-03-10T09:00"),
        clockOutAt: at("2026-03-10T17:00"),
        editReason: "   ",
        userId: admin.id,
      }),
    ).rejects.toThrow(/reason/);
  });

  it("lists shifts still running", async () => {
    await clockIn({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T09:00"),
    });
    const open = await openEntries(fixture.company.id);
    expect(open).toHaveLength(1);
    expect(open[0].consultant.name).toBe("Abigail");
  });

  it("keeps one company's timesheet out of another's", async () => {
    const other = await makeCompanyWithChart("Elsewhere", "PHP");
    await clockIn({
      companyId: fixture.company.id,
      consultantId: consultant.id,
      at: at("2026-03-10T09:00"),
    });

    const sheet = await timesheet({
      companyId: other.company.id,
      timeZone: MANILA,
      fromDayKey: "2026-03-09",
      toDayKey: "2026-03-12",
    });
    expect(sheet.rows).toHaveLength(0);
  });
});
