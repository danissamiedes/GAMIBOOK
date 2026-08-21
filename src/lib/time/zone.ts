import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { addDays, differenceInMinutes, startOfWeek } from "date-fns";

/**
 * Time zone handling for the clock (SPEC §9). The rules, restated because they
 * are the most common source of bugs in this kind of feature:
 *
 *   - Timestamps are stored in UTC, always.
 *   - They are rendered in the company's `timeClockTimeZone` for every viewer,
 *     whatever their browser says, with an explicit label so nobody guesses.
 *   - The "work day" an entry belongs to is the **local calendar date of
 *     clockInAt in that zone**, not the UTC date. A shift starting 23:30 PHT
 *     belongs to that day, even though it is already tomorrow in UTC.
 *   - Asia/Manila has no daylight saving, but nothing here hardcodes +8. Every
 *     conversion goes through the IANA zone, so the rest of the app is DST-safe
 *     if a company ever runs its clock somewhere that observes it.
 */

export const DEFAULT_TIME_CLOCK_ZONE = "Asia/Manila";

/** Short label shown beside every rendered time, e.g. "PHT". */
export function zoneAbbreviation(instant: Date, timeZone: string): string {
  return formatInTimeZone(instant, timeZone, "zzz");
}

/** The local calendar date, as yyyy-MM-dd. This is the work-day key. */
export function workDayKey(instant: Date, timeZone: string): string {
  return formatInTimeZone(instant, timeZone, "yyyy-MM-dd");
}

/** The UTC instants bounding a local calendar day, half-open: [start, end). */
export function dayBounds(dayKey: string, timeZone: string): { start: Date; end: Date } {
  const start = fromZonedTime(`${dayKey}T00:00:00`, timeZone);
  const nextDayKey = formatInTimeZone(addDays(start, 1), timeZone, "yyyy-MM-dd");
  return { start, end: fromZonedTime(`${nextDayKey}T00:00:00`, timeZone) };
}

/** Every day key from `from` to `to` inclusive, in the clock's zone. */
export function dayKeysBetween(from: Date, to: Date, timeZone: string): string[] {
  const keys: string[] = [];
  let cursor = dayBounds(workDayKey(from, timeZone), timeZone).start;
  const lastKey = workDayKey(to, timeZone);
  for (let guard = 0; guard < 400; guard++) {
    const key = workDayKey(cursor, timeZone);
    keys.push(key);
    if (key === lastKey) break;
    cursor = dayBounds(key, timeZone).end;
  }
  return keys;
}

/** The week (Monday-based) containing `instant`, in local terms. */
export function weekBounds(instant: Date, timeZone: string): { start: Date; end: Date; dayKeys: string[] } {
  const local = toZonedTime(instant, timeZone);
  const localWeekStart = startOfWeek(local, { weekStartsOn: 1 });
  const startKey = formatInTimeZone(fromZonedTime(localWeekStart, timeZone), timeZone, "yyyy-MM-dd");
  const start = dayBounds(startKey, timeZone).start;

  const dayKeys: string[] = [];
  let cursor = start;
  for (let index = 0; index < 7; index++) {
    const key = workDayKey(cursor, timeZone);
    dayKeys.push(key);
    cursor = dayBounds(key, timeZone).end;
  }
  return { start, end: cursor, dayKeys };
}

export function formatTimeInZone(instant: Date, timeZone: string): string {
  return formatInTimeZone(instant, timeZone, "h:mm a");
}

export function formatDateTimeInZone(instant: Date, timeZone: string): string {
  return formatInTimeZone(instant, timeZone, "d MMM yyyy, h:mm a");
}

export function formatDayLabel(dayKey: string, timeZone: string): string {
  return formatInTimeZone(dayBounds(dayKey, timeZone).start, timeZone, "EEE d MMM");
}

/** Minutes between two instants — zone-independent, but kept here for clarity. */
export function minutesBetween(from: Date, to: Date): number {
  return differenceInMinutes(to, from);
}

export function formatDuration(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const total = Math.abs(minutes);
  return `${sign}${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}

/** Parse a local wall-clock value from a datetime-local input into UTC. */
export function parseLocalDateTime(value: string, timeZone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const instant = fromZonedTime(value.length === 16 ? `${value}:00` : value, timeZone);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** Render an instant for a datetime-local input, in the clock's zone. */
export function toLocalInputValue(instant: Date, timeZone: string): string {
  return formatInTimeZone(instant, timeZone, "yyyy-MM-dd'T'HH:mm");
}
