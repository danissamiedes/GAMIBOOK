import { describe, expect, it } from "vitest";
import { isoDate } from "@/lib/dates";
import {
  periodInstantWhere,
  periodParams,
  periodWhere,
  resolvePeriod,
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
