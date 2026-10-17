import { describe, expect, it } from "vitest";
import { isoDate } from "@/lib/dates";
import {
  PERIOD_OPTIONS,
  periodInstantWhere,
  periodParams,
  periodWhere,
  resolveAsOf,
  resolvePeriod,
  resolveReportPeriod,
} from "@/lib/reports/date-filter";

// A Sunday, deliberately: it is the day a Monday-start week gets wrong.
const SUNDAY = new Date(Date.UTC(2026, 7, 23));
const WEDNESDAY = new Date(Date.UTC(2026, 7, 19));

const range = (period: ReturnType<typeof resolvePeriod>) => [
  period.from ? isoDate(period.from) : null,
  period.to ? isoDate(period.to) : null,
];

describe("the period filter", () => {
  it("defaults to everything", () => {
    const period = resolvePeriod({}, SUNDAY);
    expect(period.key).toBe("all");
    expect(period.active).toBe(false);
    expect(range(period)).toEqual([null, null]);
    expect(period.label).toBe("All dates");
  });

  it("resolves today to the single day", () => {
    const period = resolvePeriod({ period: "today" }, SUNDAY);
    expect(range(period)).toEqual(["2026-08-23", "2026-08-23"]);
    expect(period.label).toBe("Today (08/23/2026)");
  });

  it("runs a week Monday to Sunday", () => {
    const period = resolvePeriod({ period: "week" }, WEDNESDAY);
    expect(range(period)).toEqual(["2026-08-17", "2026-08-23"]);
  });

  it("keeps Sunday in the week that began the Monday before", () => {
    // getUTCDay() is 0 on Sunday, so the obvious arithmetic starts a new week
    // here and hides the six days a person just worked.
    const period = resolvePeriod({ period: "week" }, SUNDAY);
    expect(range(period)).toEqual(["2026-08-17", "2026-08-23"]);
  });

  it("runs a month from the first to the last day", () => {
    const period = resolvePeriod({ period: "month" }, SUNDAY);
    expect(range(period)).toEqual(["2026-08-01", "2026-08-31"]);
  });

  it("gets February's last day right, leap year included", () => {
    expect(range(resolvePeriod({ period: "month" }, new Date(Date.UTC(2026, 1, 10))))).toEqual([
      "2026-02-01",
      "2026-02-28",
    ]);
    expect(range(resolvePeriod({ period: "month" }, new Date(Date.UTC(2028, 1, 10))))).toEqual([
      "2028-02-01",
      "2028-02-29",
    ]);
  });

  it("offers exactly the options the dropdown lists, in order", () => {
    expect(PERIOD_OPTIONS.map((option) => option.label)).toEqual([
      "All",
      "Today",
      "Yesterday",
      "This Week",
      "This Month",
      "This Year",
      "This Year-to-Date",
      "Last Week",
      "Last Month",
      "Last Year",
      "Last Year-to-Date",
      "Custom dates",
    ]);
  });

  it("runs yesterday as the single day before today", () => {
    const period = resolvePeriod({ period: "yesterday" }, SUNDAY);
    expect(range(period)).toEqual(["2026-08-22", "2026-08-22"]);
    expect(period.label).toBe("Yesterday (08/22/2026)");
  });

  it("runs last week Monday to Sunday, the week before this one", () => {
    expect(range(resolvePeriod({ period: "lastWeek" }, WEDNESDAY))).toEqual([
      "2026-08-10",
      "2026-08-16",
    ]);
    // And Sunday still belongs to the week that began the Monday before.
    expect(range(resolvePeriod({ period: "lastWeek" }, SUNDAY))).toEqual([
      "2026-08-10",
      "2026-08-16",
    ]);
  });

  it("runs last month from its first day to its last, across a year end", () => {
    expect(range(resolvePeriod({ period: "lastMonth" }, SUNDAY))).toEqual([
      "2026-07-01",
      "2026-07-31",
    ]);
    expect(
      range(resolvePeriod({ period: "lastMonth" }, new Date(Date.UTC(2026, 0, 15)))),
    ).toEqual(["2025-12-01", "2025-12-31"]);
  });

  describe("the year, which is the company's financial year", () => {
    it("runs January to December when the book starts in January", () => {
      expect(range(resolvePeriod({ period: "year" }, SUNDAY, 1))).toEqual([
        "2026-01-01",
        "2026-12-31",
      ]);
      expect(range(resolvePeriod({ period: "lastYear" }, SUNDAY, 1))).toEqual([
        "2025-01-01",
        "2025-12-31",
      ]);
    });

    it("runs April to March when the book starts in April", () => {
      // The reports have always followed the financial year; the dropdown
      // must not quietly switch them to the calendar one.
      expect(range(resolvePeriod({ period: "year" }, SUNDAY, 4))).toEqual([
        "2026-04-01",
        "2027-03-31",
      ]);
      expect(range(resolvePeriod({ period: "lastYear" }, SUNDAY, 4))).toEqual([
        "2025-04-01",
        "2026-03-31",
      ]);
    });

    it("ends year-to-date today, and last year-to-date at the matching day", () => {
      // The pair only earns its place if the two are comparable.
      expect(range(resolvePeriod({ period: "ytd" }, SUNDAY, 1))).toEqual([
        "2026-01-01",
        "2026-08-23",
      ]);
      expect(range(resolvePeriod({ period: "lastYtd" }, SUNDAY, 1))).toEqual([
        "2025-01-01",
        "2025-08-23",
      ]);
    });

    it("lands 29 February on the 28th a year earlier rather than in March", () => {
      expect(range(resolvePeriod({ period: "lastYtd" }, new Date(Date.UTC(2028, 1, 29)), 1))).toEqual(
        ["2027-01-01", "2027-02-28"],
      );
    });
  });

  it("takes the dates given for a custom range", () => {
    const period = resolvePeriod(
      { period: "custom", from: "2026-08-01", to: "2026-08-15" },
      SUNDAY,
    );
    expect(range(period)).toEqual(["2026-08-01", "2026-08-15"]);
    expect(period.label).toBe("08/01/2026 to 08/15/2026");
  });

  it("swaps a range typed backwards rather than returning nothing", () => {
    // An empty list looks like "you have no work", which is a worse answer to
    // a slip than quietly doing what was meant.
    const period = resolvePeriod(
      { period: "custom", from: "2026-08-15", to: "2026-08-01" },
      SUNDAY,
    );
    expect(range(period)).toEqual(["2026-08-01", "2026-08-15"]);
  });

  it("accepts a one-sided custom range", () => {
    expect(range(resolvePeriod({ period: "custom", from: "2026-08-01" }, SUNDAY))).toEqual([
      "2026-08-01",
      null,
    ]);
    expect(resolvePeriod({ period: "custom", to: "2026-08-31" }, SUNDAY).label).toBe(
      "Up to 08/31/2026",
    );
  });

  it("treats a custom range with no dates as no filter at all", () => {
    const period = resolvePeriod({ period: "custom" }, SUNDAY);
    expect(period.active).toBe(false);
    expect(range(period)).toEqual([null, null]);
  });

  it("honours from/to on a link that never named a period", () => {
    // An older or hand-edited URL. Ignoring the dates would show every row
    // while the page claimed to be filtered.
    const period = resolvePeriod({ from: "2026-08-01", to: "2026-08-31" }, SUNDAY);
    expect(period.key).toBe("custom");
    expect(range(period)).toEqual(["2026-08-01", "2026-08-31"]);
  });

  it("ignores a period it does not recognise", () => {
    const period = resolvePeriod({ period: "last-fortnight" }, SUNDAY);
    expect(period.key).toBe("all");
    expect(period.active).toBe(false);
  });
});

describe("periodWhere", () => {
  it("is empty when nothing is filtered, so it can always be spread", () => {
    expect(periodWhere(resolvePeriod({}, SUNDAY), "issueDate")).toEqual({});
  });

  it("bounds the named column inclusively at both ends", () => {
    expect(periodWhere(resolvePeriod({ period: "month" }, SUNDAY), "issueDate")).toEqual({
      issueDate: {
        gte: new Date(Date.UTC(2026, 7, 1)),
        lte: new Date(Date.UTC(2026, 7, 31)),
      },
    });
  });

  it("bounds one end only for a one-sided range", () => {
    expect(
      periodWhere(resolvePeriod({ period: "custom", from: "2026-08-01" }, SUNDAY), "date"),
    ).toEqual({ date: { gte: new Date(Date.UTC(2026, 7, 1)) } });
  });
});

describe("periodParams", () => {
  it("carries a fixed period as one param", () => {
    expect(periodParams(resolvePeriod({ period: "week" }, SUNDAY))).toEqual({ period: "week" });
  });

  it("carries a custom range with its dates", () => {
    expect(
      periodParams(resolvePeriod({ period: "custom", from: "2026-08-01", to: "2026-08-15" }, SUNDAY)),
    ).toEqual({ period: "custom", from: "2026-08-01", to: "2026-08-15" });
  });

  it("carries nothing when nothing is filtered", () => {
    expect(periodParams(resolvePeriod({}, SUNDAY))).toEqual({});
  });
});

describe("periodInstantWhere", () => {
  // The email log stamps rows in the company's zone, so the filter has to
  // bound the local day rather than the UTC one.
  const MANILA = "Asia/Manila";

  it("bounds a local day, half-open at the top", () => {
    const where = periodInstantWhere(
      resolvePeriod({ period: "today" }, SUNDAY),
      "createdAt",
      MANILA,
    ) as { createdAt: { gte: Date; lt: Date } };

    // Midnight in Manila is 16:00 UTC the day before, and the day ends at
    // the next one's midnight — not at 00:00 UTC, which would hide
    // everything sent after eight in the morning.
    expect(where.createdAt.gte.toISOString()).toBe("2026-08-22T16:00:00.000Z");
    expect(where.createdAt.lt.toISOString()).toBe("2026-08-23T16:00:00.000Z");
  });

  it("keeps a message sent late in the local evening inside that day", () => {
    const where = periodInstantWhere(
      resolvePeriod({ period: "today" }, SUNDAY),
      "createdAt",
      MANILA,
    ) as { createdAt: { gte: Date; lt: Date } };
    // 8:34pm in Manila on the 23rd.
    const evening = new Date("2026-08-23T12:34:00.000Z");
    expect(evening >= where.createdAt.gte && evening < where.createdAt.lt).toBe(true);
  });

  it("spans a custom range from the first local midnight to the last", () => {
    const where = periodInstantWhere(
      resolvePeriod({ period: "custom", from: "2026-08-01", to: "2026-08-15" }, SUNDAY),
      "createdAt",
      MANILA,
    ) as { createdAt: { gte: Date; lt: Date } };
    expect(where.createdAt.gte.toISOString()).toBe("2026-07-31T16:00:00.000Z");
    expect(where.createdAt.lt.toISOString()).toBe("2026-08-15T16:00:00.000Z");
  });

  it("filters nothing when no period is chosen", () => {
    expect(periodInstantWhere(resolvePeriod({}, SUNDAY), "createdAt", MANILA)).toEqual({});
  });
});

describe("a report, which must have two ends", () => {
  it("opens on the financial year to date, and says so in the dropdown", () => {
    // A dropdown reading "All" above dates reading 01/01 to today is the
    // control contradicting the report.
    const period = resolveReportPeriod({}, SUNDAY, 1);
    expect(period.key).toBe("ytd");
    expect(isoDate(period.from!)).toBe("2026-01-01");
    expect(isoDate(period.to)).toBe("2026-08-23");
  });

  it("leaves the start open when All is asked for, for the books to answer", () => {
    const period = resolveReportPeriod({ period: "all" }, SUNDAY, 1);
    expect(period.key).toBe("all");
    expect(period.from).toBeNull();
    expect(isoDate(period.to)).toBe("2026-08-23");
  });

  it("keeps the one end that was given and fills in the other", () => {
    const period = resolveReportPeriod({ from: "2026-03-01" }, SUNDAY, 1);
    expect(isoDate(period.from!)).toBe("2026-03-01");
    expect(isoDate(period.to)).toBe("2026-08-23");
  });

  it("uses a named period as it stands", () => {
    const period = resolveReportPeriod({ period: "lastMonth" }, SUNDAY, 1);
    expect([isoDate(period.from!), isoDate(period.to)]).toEqual(["2026-07-01", "2026-07-31"]);
  });
});

describe("a report drawn at a single moment", () => {
  it("takes the last day of the period chosen", () => {
    // A balance sheet has no start: "Last month" means as it stood at the
    // end of last month.
    expect(isoDate(resolveAsOf({ period: "lastMonth" }, SUNDAY, 1).asOf)).toBe("2026-07-31");
    expect(isoDate(resolveAsOf({ period: "lastYear" }, SUNDAY, 1).asOf)).toBe("2025-12-31");
  });

  it("means today for All — there is no balance sheet for all of time", () => {
    expect(isoDate(resolveAsOf({}, SUNDAY, 1).asOf)).toBe("2026-08-23");
    expect(isoDate(resolveAsOf({ period: "all" }, SUNDAY, 1).asOf)).toBe("2026-08-23");
  });

  it("still honours a bookmarked asOf, which is the more specific answer", () => {
    const resolved = resolveAsOf({ asOf: "2026-05-04" }, SUNDAY, 1);
    expect(isoDate(resolved.asOf)).toBe("2026-05-04");
    expect(resolved.key).toBe("custom");
  });

  it("lets a period chosen on the screen override the asOf it arrived with", () => {
    // The dropdown submits the old asOf alongside the new period; the thing
    // just clicked has to win.
    expect(
      isoDate(resolveAsOf({ asOf: "2026-05-04", period: "lastMonth" }, SUNDAY, 1).asOf),
    ).toBe("2026-07-31");
  });
});
