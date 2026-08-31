import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { monthColumns, profitAndLossByMonth } from "@/lib/reports/profit-loss-by-month";
import { profitAndLoss } from "@/lib/reports/profit-loss";
import { postJournalEntry } from "@/lib/ledger/post";
import { money } from "@/lib/money";
import { makeCompanyWithChart, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day));

/**
 * SPEC §12.1: the standard P&L, cut by month.
 *
 * The load-bearing property is that the columns sum to the total and the total
 * matches the report this one is a variant of. A monthly P&L that disagrees
 * with the P&L is worse than no monthly P&L.
 */
describe("profit & loss by month", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Monthly Co", "PHP");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  /** Income of `amount` on a date, against cash. */
  const earn = (date: Date, amount: string) =>
    postJournalEntry({
      companyId: fixture.company.id,
      date,
      memo: "Sale",
      sourceType: "MANUAL",
      lines: [
        { accountId: fixture.code("1000").id, debit: amount, credit: "0" },
        { accountId: fixture.code("4000").id, debit: "0", credit: amount },
      ],
    });

  const spend = (date: Date, amount: string) =>
    postJournalEntry({
      companyId: fixture.company.id,
      date,
      memo: "Cost",
      sourceType: "MANUAL",
      lines: [
        { accountId: fixture.code("5000").id, debit: amount, credit: "0" },
        { accountId: fixture.code("1000").id, debit: "0", credit: amount },
      ],
    });

  describe("monthColumns", () => {
    it("gives one whole column per month across a clean period", () => {
      const columns = monthColumns(utc(2026, 0, 1), utc(2026, 2, 31));

      expect(columns).toHaveLength(3);
      expect(columns.map((column) => column.label)).toEqual(["Jan 2026", "Feb 2026", "Mar 2026"]);
      expect(columns.every((column) => column.whole)).toBe(true);
      expect(columns[0].to).toEqual(utc(2026, 0, 31));
      expect(columns[2].to).toEqual(utc(2026, 2, 31));
    });

    it("clips the ends to the period and says so in the header", () => {
      // A column that silently claims to be a whole month it only half is
      // makes the columns stop summing to the total.
      const columns = monthColumns(utc(2026, 0, 15), utc(2026, 2, 10));

      expect(columns).toHaveLength(3);
      expect(columns[0].whole).toBe(false);
      expect(columns[0].label).toBe("Jan 15–Jan 31, 2026");
      expect(columns[1].label).toBe("Feb 2026");
      expect(columns[2].whole).toBe(false);
      expect(columns[2].to).toEqual(utc(2026, 2, 10));
    });

    it("handles a single day and a backwards range", () => {
      expect(monthColumns(utc(2026, 5, 9), utc(2026, 5, 9))).toHaveLength(1);
      expect(monthColumns(utc(2026, 5, 9), utc(2026, 4, 9))).toEqual([]);
    });

    it("counts February correctly in a leap year", () => {
      const columns = monthColumns(utc(2028, 1, 1), utc(2028, 1, 29));
      expect(columns).toHaveLength(1);
      expect(columns[0].whole).toBe(true);
      expect(columns[0].to).toEqual(utc(2028, 1, 29));
    });
  });

  it("puts each posting in its own month, and sums to the period total", async () => {
    await earn(utc(2026, 0, 10), "1000.00");
    await earn(utc(2026, 1, 20), "2000.00");
    await earn(utc(2026, 2, 5), "3000.00");
    await spend(utc(2026, 1, 25), "500.00");

    const report = await profitAndLossByMonth({
      companyId: fixture.company.id,
      from: utc(2026, 0, 1),
      to: utc(2026, 2, 31),
    });

    expect(report.months).toHaveLength(3);
    expect(report.income.months.map((amount) => amount.toFixed(2))).toEqual([
      "1000.00",
      "2000.00",
      "3000.00",
    ]);
    expect(report.income.total.toFixed(2)).toBe("6000.00");
    expect(report.costOfSales.months.map((amount) => amount.toFixed(2))).toEqual([
      "0.00",
      "500.00",
      "0.00",
    ]);
    expect(report.netIncome.months.map((amount) => amount.toFixed(2))).toEqual([
      "1000.00",
      "1500.00",
      "3000.00",
    ]);
    expect(report.netIncome.total.toFixed(2)).toBe("5500.00");
  });

  it("agrees with the standard P&L over the same period", async () => {
    await earn(utc(2026, 0, 10), "1234.56");
    await earn(utc(2026, 3, 2), "765.44");
    await spend(utc(2026, 2, 15), "300.00");

    const from = utc(2026, 0, 1);
    const to = utc(2026, 4, 31);
    const [monthly, standard] = await Promise.all([
      profitAndLossByMonth({ companyId: fixture.company.id, from, to }),
      profitAndLoss({ companyId: fixture.company.id, from, to }),
    ]);

    expect(monthly.income.total.toFixed(2)).toBe(standard.income.toFixed(2));
    expect(monthly.costOfSales.total.toFixed(2)).toBe(standard.costOfSales.toFixed(2));
    expect(monthly.grossProfit.total.toFixed(2)).toBe(standard.grossProfit.toFixed(2));
    expect(monthly.netIncome.total.toFixed(2)).toBe(standard.netIncome.toFixed(2));

    // And the same accounts, in the same order.
    const rowsOf = (codes: string[]) => codes.join(",");
    expect(rowsOf(monthly.sections.flatMap((section) => section.rows.map((row) => row.code)))).toBe(
      rowsOf(standard.sections.flatMap((section) => section.rows.map((row) => row.code))),
    );
  });

  it("every row and section sums across its own months", async () => {
    await earn(utc(2026, 0, 10), "1000.00");
    await earn(utc(2026, 1, 10), "250.25");
    await spend(utc(2026, 0, 11), "99.75");

    const report = await profitAndLossByMonth({
      companyId: fixture.company.id,
      from: utc(2026, 0, 1),
      to: utc(2026, 1, 28),
    });

    for (const section of report.sections) {
      for (const row of section.rows) {
        const summed = row.months.reduce((total, amount) => total.plus(amount), money(0));
        expect(row.total.toFixed(2)).toBe(summed.toFixed(2));
      }
      const summed = section.months.reduce((total, amount) => total.plus(amount), money(0));
      expect(section.total.toFixed(2)).toBe(summed.toFixed(2));
    }
  });

  it("leaves out an account with nothing in any month, unless asked", async () => {
    await earn(utc(2026, 0, 10), "1000.00");

    const period = { companyId: fixture.company.id, from: utc(2026, 0, 1), to: utc(2026, 1, 28) };
    const lean = await profitAndLossByMonth(period);
    const full = await profitAndLossByMonth({ ...period, includeZeroRows: true });

    const codes = (report: typeof lean) =>
      report.sections.flatMap((section) => section.rows.map((row) => row.code));
    expect(codes(lean)).toEqual(["4000"]);
    expect(codes(full).length).toBeGreaterThan(1);
  });

  it("ignores postings outside the period and another company's books", async () => {
    await earn(utc(2025, 11, 31), "9999.00");
    await earn(utc(2026, 0, 10), "1000.00");
    await earn(utc(2026, 2, 1), "8888.00");

    const elsewhere = await makeCompanyWithChart("Elsewhere", "PHP");
    await postJournalEntry({
      companyId: elsewhere.company.id,
      date: utc(2026, 0, 15),
      memo: "Not ours",
      sourceType: "MANUAL",
      lines: [
        { accountId: elsewhere.code("1000").id, debit: "5000.00", credit: "0" },
        { accountId: elsewhere.code("4000").id, debit: "0", credit: "5000.00" },
      ],
    });

    const report = await profitAndLossByMonth({
      companyId: fixture.company.id,
      from: utc(2026, 0, 1),
      to: utc(2026, 1, 28),
    });

    expect(report.income.total.toFixed(2)).toBe("1000.00");
  });

  it("puts a part-month's postings in the part-month column", async () => {
    await earn(utc(2026, 0, 5), "100.00");
    await earn(utc(2026, 0, 20), "200.00");

    const report = await profitAndLossByMonth({
      companyId: fixture.company.id,
      from: utc(2026, 0, 15),
      to: utc(2026, 1, 15),
    });

    // The 5th is before the period and must not appear anywhere.
    expect(report.months[0].whole).toBe(false);
    expect(report.income.months[0].toFixed(2)).toBe("200.00");
    expect(report.income.total.toFixed(2)).toBe("200.00");
  });
});
