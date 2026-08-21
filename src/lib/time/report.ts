import { prisma } from "@/lib/db";
import { dayBounds, dayKeysBetween, minutesBetween, workDayKey } from "./zone";

/**
 * Timesheet and time report (SPEC §9, §12.7). Grouping, daily totals and date
 * filters all use the **local calendar date of clockInAt**, never the UTC date
 * — a shift that starts 23:30 and ends 01:15 belongs entirely to the day it
 * started, and its minutes are not split across two days.
 */

export type TimesheetCell = {
  dayKey: string;
  minutes: number;
  entryIds: string[];
  hasOpenEntry: boolean;
  hasFlag: boolean;
};

export type TimesheetRow = {
  consultantId: string;
  consultantName: string;
  cells: Map<string, TimesheetCell>;
  totalMinutes: number;
};

export async function timesheet(options: {
  companyId: string;
  timeZone: string;
  /** Inclusive local day keys. */
  fromDayKey: string;
  toDayKey: string;
  consultantId?: string | null;
}) {
  const from = dayBounds(options.fromDayKey, options.timeZone).start;
  const to = dayBounds(options.toDayKey, options.timeZone).end;
  const dayKeys = dayKeysBetween(from, new Date(to.getTime() - 1), options.timeZone);

  const entries = await prisma.timeEntry.findMany({
    where: {
      companyId: options.companyId,
      clockInAt: { gte: from, lt: to },
      ...(options.consultantId ? { consultantId: options.consultantId } : {}),
    },
    include: { consultant: { select: { id: true, name: true } } },
    orderBy: { clockInAt: "asc" },
  });

  const rows = new Map<string, TimesheetRow>();

  for (const entry of entries) {
    let row = rows.get(entry.consultantId);
    if (!row) {
      row = {
        consultantId: entry.consultantId,
        consultantName: entry.consultant.name,
        cells: new Map(),
        totalMinutes: 0,
      };
      rows.set(entry.consultantId, row);
    }

    // The work day is where the shift STARTED, even if it finished after
    // midnight — this is the rule the spec calls out by name.
    const dayKey = workDayKey(entry.clockInAt, options.timeZone);
    const minutes = entry.clockOutAt
      ? (entry.durationMinutes ?? minutesBetween(entry.clockInAt, entry.clockOutAt))
      : 0;

    const cell = row.cells.get(dayKey) ?? {
      dayKey,
      minutes: 0,
      entryIds: [],
      hasOpenEntry: false,
      hasFlag: false,
    };
    cell.minutes += minutes;
    cell.entryIds.push(entry.id);
    cell.hasOpenEntry = cell.hasOpenEntry || !entry.clockOutAt;
    cell.hasFlag =
      cell.hasFlag || (Boolean(entry.correctionRequest) && !entry.correctionResolvedAt);
    row.cells.set(dayKey, cell);
    row.totalMinutes += minutes;
  }

  const dayTotals = new Map<string, number>();
  for (const row of rows.values()) {
    for (const [dayKey, cell] of row.cells) {
      dayTotals.set(dayKey, (dayTotals.get(dayKey) ?? 0) + cell.minutes);
    }
  }

  const sorted = [...rows.values()].sort((a, b) => a.consultantName.localeCompare(b.consultantName));

  return {
    dayKeys,
    rows: sorted,
    dayTotals,
    totalMinutes: sorted.reduce((total, row) => total + row.totalMinutes, 0),
  };
}

/** Entries for one consultant over a window, newest first — their own view. */
export async function entriesForConsultant(options: {
  companyId: string;
  consultantId: string;
  since: Date;
}) {
  return prisma.timeEntry.findMany({
    where: {
      companyId: options.companyId,
      consultantId: options.consultantId,
      clockInAt: { gte: options.since },
    },
    orderBy: { clockInAt: "desc" },
  });
}

/** Shifts still running — the admin alert list (SPEC §9). */
export async function openEntries(companyId: string) {
  return prisma.timeEntry.findMany({
    where: { companyId, clockOutAt: null },
    include: { consultant: { select: { id: true, name: true } } },
    orderBy: { clockInAt: "asc" },
  });
}

/** Rows a consultant has flagged and nobody has resolved yet. */
export async function flaggedEntries(companyId: string) {
  return prisma.timeEntry.findMany({
    where: { companyId, correctionRequest: { not: null }, correctionResolvedAt: null },
    include: { consultant: { select: { id: true, name: true } } },
    orderBy: { clockInAt: "desc" },
  });
}
