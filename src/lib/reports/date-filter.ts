import { fiscalYearStart, formatAccountingDate, isoDate, parseAccountingDate } from "@/lib/dates";
import { dayBounds } from "@/lib/time/zone";

/**
 * The period dropdown every screen in the app filters by (SPEC §12).
 *
 * One list, one resolver, one meaning. Reports used to offer five preset
 * links, party accounts a different five, and list screens a dropdown of
 * four — so "This year" on one screen and "This year" on another were not
 * reliably the same dates, which is the sort of difference nobody notices
 * until two reports disagree.
 *
 * **The year is the company's financial year**, not the calendar year,
 * because that is what its accounts are drawn up to. For a book starting in
 * January the two coincide; for one starting in April they do not, and the
 * reports have always followed the financial year.
 *
 * **Year-to-date stops today, and last year-to-date stops at the same point
 * a year earlier.** That is what makes the two comparable, which is the only
 * reason to offer both.
 */

export const PERIOD_KEYS = [
  "all",
  "today",
  "yesterday",
  "week",
  "month",
  "year",
  "ytd",
  "lastWeek",
  "lastMonth",
  "lastYear",
  "lastYtd",
  "custom",
] as const;

export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "year", label: "This Year" },
  { value: "ytd", label: "This Year-to-Date" },
  { value: "lastWeek", label: "Last Week" },
  { value: "lastMonth", label: "Last Month" },
  { value: "lastYear", label: "Last Year" },
  { value: "lastYtd", label: "Last Year-to-Date" },
  // Last, and unnamed in the list the user asked for: it is not a period
  // somebody picks, it is where typing your own dates lands you.
  { value: "custom", label: "Custom dates" },
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

const DAY = 86_400_000;

/** Monday of the week containing `date`. */
function weekStart(date: Date): Date {
  // getUTCDay() is 0 for Sunday, so Sunday belongs to the week that began six
  // days earlier rather than starting a new one.
  const dayFromMonday = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - dayFromMonday * DAY);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

/** The same day one year earlier, 29 February landing on the 28th. */
function aYearEarlier(date: Date): Date {
  const year = date.getUTCFullYear() - 1;
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastOfMonth)));
}

/** The financial year containing `date`, as a whole. */
function fiscalYear(date: Date, startMonth: number): { from: Date; to: Date } {
  const from = fiscalYearStart(date, startMonth);
  return {
    from,
    to: new Date(Date.UTC(from.getUTCFullYear() + 1, from.getUTCMonth(), 0)),
  };
}

export type PeriodParams = { period?: string; from?: string; to?: string };

/**
 * Read the period from the query string.
 *
 * `today` is passed in rather than read here, so the caller stays in control
 * of which zone "today" means and this stays testable. The financial year
 * start comes from the company for the same reason.
 */
export function resolvePeriod(
  params: PeriodParams,
  today: Date,
  fiscalYearStartMonth = 1,
): ResolvedPeriod {
  const requested: PeriodKey = PERIOD_KEYS.includes(params.period as PeriodKey)
    ? (params.period as PeriodKey)
    : // Dates with no period is a hand-edited or older URL — and every link
      // written before this dropdown existed is one. Honour the dates rather
      // than silently ignoring them.
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

  const span = (from: Date, to: Date, name: string) =>
    range(
      from,
      to,
      `${name} (${formatAccountingDate(from)} to ${formatAccountingDate(to)})`,
    );

  const monthOf = (date: Date) => ({
    from: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)),
    to: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)),
  });

  switch (requested) {
    case "today":
      return range(today, today, `Today (${formatAccountingDate(today)})`);

    case "yesterday": {
      const day = addDays(today, -1);
      return range(day, day, `Yesterday (${formatAccountingDate(day)})`);
    }

    case "week": {
      const start = weekStart(today);
      return span(start, addDays(start, 6), "This week");
    }

    case "lastWeek": {
      const start = addDays(weekStart(today), -7);
      return span(start, addDays(start, 6), "Last week");
    }

    case "month": {
      const { from, to } = monthOf(today);
      return span(from, to, "This month");
    }

    case "lastMonth": {
      const { from, to } = monthOf(
        new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)),
      );
      return span(from, to, "Last month");
    }

    case "year": {
      const { from, to } = fiscalYear(today, fiscalYearStartMonth);
      return span(from, to, "This year");
    }

    case "ytd": {
      const { from } = fiscalYear(today, fiscalYearStartMonth);
      return span(from, today, "This year to date");
    }

    case "lastYear": {
      const { from } = fiscalYear(today, fiscalYearStartMonth);
      const start = new Date(
        Date.UTC(from.getUTCFullYear() - 1, from.getUTCMonth(), 1),
      );
      return span(start, addDays(from, -1), "Last year");
    }

    case "lastYtd": {
      // The same stretch of last year as this year-to-date covers of this
      // one, so the two can be put side by side and mean something.
      const { from } = fiscalYear(today, fiscalYearStartMonth);
      const start = new Date(
        Date.UTC(from.getUTCFullYear() - 1, from.getUTCMonth(), 1),
      );
      return span(start, aYearEarlier(today), "Last year to date");
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

/**
 * The period a report is showing, for one that insists on having a range.
 *
 * A report needs two ends, so the two cases that have none are given them:
 *
 *   **Nothing asked for** opens on the financial year to date, which is
 *   what every one of these reports opened on before this dropdown existed.
 *   The dropdown then reads "This Year-to-Date" rather than "All", because
 *   a control that says one thing while the dates below it say another is
 *   worse than no control.
 *
 *   **"All" asked for** means every date in the books. How far back that
 *   reaches is a question for the database, so `from` comes back null and
 *   `reportRange` fills it in; a report with nothing posted falls back to
 *   the financial year.
 */
export function resolveReportPeriod(
  params: PeriodParams,
  today: Date,
  fiscalYearStartMonth = 1,
): { key: PeriodKey; from: Date | null; to: Date } {
  const period = resolvePeriod(params, today, fiscalYearStartMonth);
  if (period.from && period.to) {
    return { key: period.key, from: period.from, to: period.to };
  }

  const { from } = fiscalYear(today, fiscalYearStartMonth);

  if (period.key === "all") {
    // Asked for explicitly, or simply not asked at all — and those are two
    // different requests.
    return params.period === "all"
      ? { key: "all", from: null, to: today }
      : { key: "ytd", from, to: today };
  }

  return {
    key: period.key,
    // One end given and not the other is still a real request: hold the end
    // that was asked for and take the other from the financial year.
    from: period.from ?? from,
    to: period.to ?? today,
  };
}

/**
 * The as-of date a period implies, for a report drawn at a single moment.
 *
 * A balance sheet has no start, so "Last month" means as it stood at the end
 * of last month. "All" means today — there is no such thing as a balance
 * sheet for all of time.
 */
export function resolveAsOf(
  params: PeriodParams & { asOf?: string },
  today: Date,
  fiscalYearStartMonth = 1,
): { key: PeriodKey; asOf: Date } {
  // A hand-written or bookmarked ?asOf= still works and still wins: it is a
  // more specific answer than a named period.
  const explicit = parseAccountingDate(params.asOf ?? "");
  if (explicit && !params.period) return { key: "custom", asOf: explicit };

  const period = resolvePeriod(params, today, fiscalYearStartMonth);
  return { key: period.key, asOf: period.to ?? explicit ?? today };
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

/**
 * The same, for a column holding an instant rather than an accounting date.
 *
 * A timestamp needs the local day's *boundaries*, not its midnight: filtering
 * `createdAt <= 2026-10-17T00:00Z` for "today" in Manila would hide
 * everything sent after eight in the morning, and the rows on screen are
 * stamped in the company's zone. Half-open at the top, so the last second of
 * the day is in and the first of the next is not.
 */
export function periodInstantWhere(
  period: ResolvedPeriod,
  column: string,
  timeZone: string,
) {
  if (!period.from && !period.to) return {};
  return {
    [column]: {
      ...(period.from ? { gte: dayBounds(isoDate(period.from), timeZone).start } : {}),
      ...(period.to ? { lt: dayBounds(isoDate(period.to), timeZone).end } : {}),
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
