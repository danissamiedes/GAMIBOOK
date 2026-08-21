import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { minutesBetween } from "./zone";

/**
 * The time clock (SPEC §9). Attendance only: nothing here ever feeds a work
 * order, by explicit instruction.
 */

export class ClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClockError";
  }
}

/** The consultant record for a signed-in user in a company, if any. */
export async function consultantForUser(userId: string, companyId: string) {
  return prisma.vendor.findFirst({
    where: { companyId, userId, kind: "CONSULTANT" },
  });
}

export async function openEntryFor(consultantId: string) {
  return prisma.timeEntry.findFirst({
    where: { consultantId, clockOutAt: null },
    orderBy: { clockInAt: "desc" },
  });
}

/**
 * Clock in. Only one open entry per consultant at a time — a second clock-in
 * while one is open is blocked rather than silently opening a parallel shift.
 */
export async function clockIn(input: {
  companyId: string;
  consultantId: string;
  at?: Date;
  note?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const consultant = await tx.vendor.findFirst({
      where: { id: input.consultantId, companyId: input.companyId, kind: "CONSULTANT" },
    });
    if (!consultant) throw new ClockError("Consultant not found in this company");
    if (!consultant.isActive) throw new ClockError("This consultant record is inactive");

    const open = await tx.timeEntry.findFirst({
      where: { consultantId: consultant.id, clockOutAt: null },
    });
    if (open) throw new ClockError("You are already clocked in. Clock out before starting again.");

    return tx.timeEntry.create({
      data: {
        companyId: input.companyId,
        consultantId: consultant.id,
        clockInAt: input.at ?? new Date(),
        note: input.note ?? null,
        source: "SELF",
      },
    });
  });
}

export async function clockOut(input: {
  companyId: string;
  consultantId: string;
  at?: Date;
  note?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const open = await tx.timeEntry.findFirst({
      where: {
        consultantId: input.consultantId,
        companyId: input.companyId,
        clockOutAt: null,
      },
      orderBy: { clockInAt: "desc" },
    });
    if (!open) throw new ClockError("You are not clocked in");

    const clockOutAt = input.at ?? new Date();
    if (clockOutAt <= open.clockInAt) {
      throw new ClockError("Clock-out cannot be before clock-in");
    }

    return tx.timeEntry.update({
      where: { id: open.id },
      data: {
        clockOutAt,
        durationMinutes: minutesBetween(open.clockInAt, clockOutAt),
        note: input.note ?? open.note,
      },
    });
  });
}

/** The consultant can flag a row; only an admin can change a recorded time. */
export async function requestCorrection(input: {
  companyId: string;
  consultantId: string;
  entryId: string;
  message: string;
}) {
  const entry = await prisma.timeEntry.findFirst({
    where: { id: input.entryId, companyId: input.companyId, consultantId: input.consultantId },
  });
  if (!entry) throw new ClockError("Entry not found");

  return prisma.timeEntry.update({
    where: { id: entry.id },
    data: { correctionRequest: input.message.trim() || null, correctionResolvedAt: null },
  });
}

/**
 * Auto-close a shift left running longer than the company's `maxShiftHours`
 * and flag it, rather than letting it run forever (SPEC §9). Written as a plain
 * function so the scheduler is just a caller.
 */
export async function autoCloseStaleEntries(now: Date = new Date()) {
  const companies = await prisma.company.findMany({
    select: { id: true, maxShiftHours: true },
  });

  let closed = 0;
  for (const company of companies) {
    const cutoff = new Date(now.getTime() - company.maxShiftHours * 3_600_000);
    const stale = await prisma.timeEntry.findMany({
      where: { companyId: company.id, clockOutAt: null, clockInAt: { lt: cutoff } },
    });

    for (const entry of stale) {
      const clockOutAt = new Date(entry.clockInAt.getTime() + company.maxShiftHours * 3_600_000);
      await prisma.timeEntry.update({
        where: { id: entry.id },
        data: {
          clockOutAt,
          durationMinutes: minutesBetween(entry.clockInAt, clockOutAt),
          source: "AUTO_CLOSED",
          // Flag it for review: an auto-closed shift is a guess, not a record.
          correctionRequest:
            entry.correctionRequest ??
            `Left open longer than ${company.maxShiftHours} hours and closed automatically. Check the real finish time.`,
        },
      });
      await writeAudit({
        companyId: company.id,
        action: "time_entry.auto_closed",
        entityType: "TimeEntry",
        entityId: entry.id,
        summary: `Closed at ${company.maxShiftHours}h for review`,
      });
      closed += 1;
    }
  }
  return { closed };
}

/** Admin add or edit, keeping the original values and a reason (SPEC §9). */
export async function adminUpsertEntry(input: {
  companyId: string;
  entryId?: string | null;
  consultantId: string;
  clockInAt: Date;
  clockOutAt?: Date | null;
  note?: string | null;
  editReason: string;
  userId: string;
}) {
  if (input.clockOutAt && input.clockOutAt <= input.clockInAt) {
    throw new ClockError("Clock-out must be after clock-in");
  }
  if (!input.editReason.trim()) {
    throw new ClockError("Give a reason — an edited time without one is unauditable");
  }

  const duration = input.clockOutAt ? minutesBetween(input.clockInAt, input.clockOutAt) : null;

  if (!input.entryId) {
    const created = await prisma.timeEntry.create({
      data: {
        companyId: input.companyId,
        consultantId: input.consultantId,
        clockInAt: input.clockInAt,
        clockOutAt: input.clockOutAt ?? null,
        durationMinutes: duration,
        note: input.note ?? null,
        source: "ADMIN_ENTERED",
        editedByUserId: input.userId,
        editReason: input.editReason.trim(),
      },
    });
    await writeAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: "time_entry.created",
      entityType: "TimeEntry",
      entityId: created.id,
      summary: input.editReason.trim(),
    });
    return created;
  }

  const existing = await prisma.timeEntry.findFirst({
    where: { id: input.entryId, companyId: input.companyId },
  });
  if (!existing) throw new ClockError("Entry not found in this company");

  const updated = await prisma.timeEntry.update({
    where: { id: existing.id },
    data: {
      clockInAt: input.clockInAt,
      clockOutAt: input.clockOutAt ?? null,
      durationMinutes: duration,
      note: input.note ?? existing.note,
      source: "ADMIN_EDITED",
      editedByUserId: input.userId,
      editReason: input.editReason.trim(),
      // Keep what the consultant actually recorded, once.
      originalClockInAt: existing.originalClockInAt ?? existing.clockInAt,
      originalClockOutAt: existing.originalClockOutAt ?? existing.clockOutAt,
      correctionResolvedAt: existing.correctionRequest ? new Date() : existing.correctionResolvedAt,
    },
  });

  await writeAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: "time_entry.edited",
    entityType: "TimeEntry",
    entityId: existing.id,
    summary: input.editReason.trim(),
    data: {
      from: {
        clockInAt: existing.clockInAt.toISOString(),
        clockOutAt: existing.clockOutAt?.toISOString() ?? null,
      },
      to: {
        clockInAt: input.clockInAt.toISOString(),
        clockOutAt: input.clockOutAt?.toISOString() ?? null,
      },
    } as Prisma.InputJsonValue,
  });

  return updated;
}
