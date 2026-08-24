import { formatAccountingDate, isoDate, parseAccountingDate } from "@/lib/dates";

/**
 * The period dropdown a list screen filters by: Today, This week, This month,
 * or dates you choose.
 *
 * Resolved on the server from the query string, so a filtered list is a URL —
 * which is what makes one shareable, bookmarkable and safe to reload. The
 * alternative, resolving "this month" in the browser, gives two people looking
 * at the same link different rows.
 *
 * "Today" is today in the company's own operating zone, not UTC and not the
 * viewer's. A Manila business at nine in the evening is still on today's date;
 * a UTC-based "today" would have rolled over and quietly hidden the day's work.
 */

export const PERIOD_KEYS = ["all", "today", "week", "month", "custom"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: "all", label: "All dates" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom…" },
];

export type ResolvedPeriod = {
  key: PeriodKey;
  /** Inclusive. Null means unbounded. */
  from: Date | null;
  /** Inclusive. Null means unbounded. */
  to: Date | null;
  /** "Today (08/23/2026)", "08/01/2026 to 08/31/2026", "All dates". */
  label: string;
  /** True when anything is actually being narrowed. */
  active: boolean;
};

/** Monday of the week containing `date`. */
function weekStart(date: Date): Date {
  // getUTCDay() is 0 for Sunday, so Sunday belongs to the week that began six
  // days earlier rather than starting a new one.
  const dayFromMonday = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - dayFromMonday * 86_400_000);
}

/**
 * Read the period from the query string.
 *
 * `today` is the company's own today, passed in rather than read here so the
 * caller stays in control of the zone and this stays testable.
 */
export function resolvePeriod(
  params: { period?: string; from?: string; to?: string },
  today: Date,
): ResolvedPeriod {
  const requested = PERIOD_KEYS.includes(params.period as PeriodKey)
    ? (params.period as PeriodKey)
    : // A from or a to without a period is a hand-edited or older URL. Honour
      // it as a custom range rather than silently ignoring the dates.
      params.from || params.to
      ? "custom"
      : "all";

  const range = (from: Date, to: Date, label: string): ResolvedPeriod => ({
    key: requested,
    from,
    to,
    label,
    active: true,
  });

  switch (requested) {
    case "today":
      return range(today, today, `Today (${formatAccountingDate(today)})`);

    case "week": {
      const start = weekStart(today);
      const end = new Date(start.getTime() + 6 * 86_400_000);
      return range(
        start,
        end,
        `This week (${formatAccountingDate(start)} to ${formatAccountingDate(end)})`,
      );
    }

    case "month": {
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
      return range(
        start,
        end,
        `This month (${formatAccountingDate(start)} to ${formatAccountingDate(end)})`,
      );
    }

    case "custom": {
      let from = parseAccountingDate(params.from ?? "");
      let to = parseAccountingDate(params.to ?? "");
      // A range typed backwards is a slip, not a request for nothing. Swapping
      // beats returning an empty list that looks like "you have no work".
      if (from && to && from > to) [from, to] = [to, from];

      if (!from && !to) {
        return { key: "custom", from: null, to: null, label: "All dates", active: false };
      }
      return {
        key: "custom",
        from,
        to,
        label:
          from && to
            ? `${formatAccountingDate(from)} to ${formatAccountingDate(to)}`
            : from
              ? `From ${formatAccountingDate(from)}`
              : `Up to ${formatAccountingDate(to!)}`,
        active: true,
      };
    }

    default:
      return { key: "all", from: null, to: null, label: "All dates", active: false };
  }
}

/** A Prisma `where` fragment for one date column, or `{}` when unfiltered. */
export function periodWhere(period: ResolvedPeriod, column: string) {
  if (!period.from && !period.to) return {};
  return {
    [column]: {
      ...(period.from ? { gte: period.from } : {}),
      ...(period.to ? { lte: period.to } : {}),
    },
  };
}

/** The period as query params, for links that must keep the current filter. */
export function periodParams(period: ResolvedPeriod): Record<string, string> {
  if (period.key === "all") return {};
  if (period.key !== "custom") return { period: period.key };
  return {
    period: "custom",
    ...(period.from ? { from: isoDate(period.from) } : {}),
    ...(period.to ? { to: isoDate(period.to) } : {}),
  };
}
