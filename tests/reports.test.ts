import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { postJournalEntry } from "@/lib/ledger/post";
import { postOpeningBalances } from "@/lib/ledger/opening-balances";
import { profitAndLoss } from "@/lib/reports/profit-loss";
import { balanceSheet } from "@/lib/reports/balance-sheet";
import { accountDetail } from "@/lib/reports/general-ledger";
import { trialBalance } from "@/lib/ledger/reports";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { makeCompanyWithChart, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

/**
 * SPEC §12.1 and §12.2, and the Phase 5 tests the spec asks for by name:
 * the balance sheet balances, its current-year earnings equal the P&L for the
 * same fiscal year to date, and a balance sheet dated in a PRIOR fiscal year
 * still balances with that year's profit in retained earnings.
 */
describe("P&L and Balance Sheet", () => {
  let fixture: Fixture;

  const post = (date: string, lines: { code: string; debit?: string; credit?: string }[], memo = "") =>
    postJournalEntry({
      companyId: fixture.company.id,
      date: new Date(`${date}T00:00:00Z`),
      memo,
      sourceType: "MANUAL",
      role: "OWNER",
      lines: lines.map((line) => ({
        accountId: fixture.code(line.code).id,
        debit: line.debit,
        credit: line.credit,
      })),
    });

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Reporting Co", "PHP");

    // Opening balances at the start of FY2025.
    await postOpeningBalances({
      companyId: fixture.company.id,
      date: new Date(Date.UTC(2025, 0, 1)),
      balances: [{ accountId: fixture.code("1000").id, amount: "100000.00" }],
      role: "OWNER",
    });

    // FY2025: income 300,000, expenses 120,000 → profit 180,000.
    await post("2025-06-30", [
      { code: "1000", debit: "300000.00" },
      { code: "4000", credit: "300000.00" },
    ], "2025 income");
    await post("2025-06-30", [
      { code: "5000", debit: "120000.00" },
      { code: "1000", credit: "120000.00" },
    ], "2025 consultant fees");

    // FY2026: income 200,000, expenses 50,000 → profit 150,000.
    await post("2026-03-31", [
      { code: "1000", debit: "200000.00" },
      { code: "4000", credit: "200000.00" },
    ], "2026 income");
    await post("2026-03-31", [
      { code: "6200", debit: "50000.00" },
      { code: "1000", credit: "50000.00" },
    ], "2026 rent");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("reports the P&L for a period, with gross profit and net income", async () => {
    const pl = await profitAndLoss({
      companyId: fixture.company.id,
      from: new Date(Date.UTC(2025, 0, 1)),
      to: new Date(Date.UTC(2025, 11, 31)),
    });

    expect(pl.income.toFixed(2)).toBe("300000.00");
    expect(pl.costOfSales.toFixed(2)).toBe("120000.00");
    expect(pl.grossProfit.toFixed(2)).toBe("180000.00");
    expect(pl.expenses.toFixed(2)).toBe("0.00");
    expect(pl.netIncome.toFixed(2)).toBe("180000.00");
  });

  it("counts only postings inside the period", async () => {
    const pl = await profitAndLoss({
      companyId: fixture.company.id,
      from: new Date(Date.UTC(2026, 0, 1)),
      to: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(pl.income.toFixed(2)).toBe("200000.00");
    expect(pl.expenses.toFixed(2)).toBe("50000.00");
    expect(pl.netIncome.toFixed(2)).toBe("150000.00");
  });

  it("balances, and its current-year earnings equal the P&L for the same year", async () => {
    const asOf = new Date(Date.UTC(2026, 11, 31));
    const bs = await balanceSheet({ companyId: fixture.company.id, asOf });
    const pl = await profitAndLoss({
      companyId: fixture.company.id,
      from: bs.fiscalYearStart,
      to: asOf,
    });

    expect(bs.balanced).toBe(true);
    expect(bs.difference.toFixed(2)).toBe("0.00");
    expect(bs.equity.netIncome.toFixed(2)).toBe(pl.netIncome.toFixed(2));
    expect(bs.equity.netIncome.toFixed(2)).toBe("150000.00");
  });

  it("rolls prior-year profit into retained earnings — the bug this test exists for", async () => {
    const bs = await balanceSheet({
      companyId: fixture.company.id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });

    // Nothing has ever posted to the Retained Earnings account itself...
    expect(bs.equity.retainedEarningsPosted.toFixed(2)).toBe("0.00");
    // ...but FY2025's profit must appear there all the same.
    expect(bs.equity.priorYearEarnings.toFixed(2)).toBe("180000.00");
    expect(bs.equity.retainedEarnings.toFixed(2)).toBe("180000.00");

    // Taking retained earnings from the account balance alone would show 0 and
    // the sheet would be out by exactly the prior year's profit.
    expect(bs.equity.total.toFixed(2)).toBe("430000.00"); // 100k OBE + 180k RE + 150k NI
  });

  it("balances when dated inside a PRIOR fiscal year, with no prior earnings yet", async () => {
    const bs = await balanceSheet({
      companyId: fixture.company.id,
      asOf: new Date(Date.UTC(2025, 11, 31)),
    });

    expect(bs.balanced).toBe(true);
    expect(bs.fiscalYearStart.toISOString().slice(0, 10)).toBe("2025-01-01");
    // In FY2025 the 180,000 is current-year income, not retained earnings.
    expect(bs.equity.netIncome.toFixed(2)).toBe("180000.00");
    expect(bs.equity.retainedEarnings.toFixed(2)).toBe("0.00");

    // And the 2026 postings are simply not there yet.
    expect(bs.assets.total.toFixed(2)).toBe("280000.00");
  });

  it("respects a non-January fiscal year start", async () => {
    await prisma.company.update({
      where: { id: fixture.company.id },
      data: { fiscalYearStartMonth: 7 },
    });

    // As at 31 March 2026 the fiscal year began 1 July 2025, so the 2025
    // postings dated 30 June fall in the PRIOR year and the March 2026
    // postings are current-year.
    const bs = await balanceSheet({
      companyId: fixture.company.id,
      asOf: new Date(Date.UTC(2026, 2, 31)),
    });

    expect(bs.fiscalYearStart.toISOString().slice(0, 10)).toBe("2025-07-01");
    expect(bs.equity.priorYearEarnings.toFixed(2)).toBe("180000.00");
    expect(bs.equity.netIncome.toFixed(2)).toBe("150000.00");
    expect(bs.balanced).toBe(true);
  });

  it("agrees with the trial balance", async () => {
    const asOf = new Date(Date.UTC(2026, 11, 31));
    const [bs, tb] = await Promise.all([
      balanceSheet({ companyId: fixture.company.id, asOf }),
      trialBalance({ companyId: fixture.company.id, asOf }),
    ]);

    expect(tb.balanced).toBe(true);
    // Assets are the debit-side balance-sheet accounts; the trial balance and
    // the balance sheet are two views of the same ledger and must agree.
    const bank = tb.rows.find((row) => row.code === "1000");
    expect(bank?.debit.toFixed(2)).toBe(bs.assets.current.total.toFixed(2));
  });

  it("keeps another company's postings out", async () => {
    const other = await makeCompanyWithChart("Neighbour", "USD");
    const bs = await balanceSheet({
      companyId: other.company.id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(bs.assets.total.toFixed(2)).toBe("0.00");
    expect(bs.balanced).toBe(true);
  });
});

describe("general ledger detail (SPEC §12.4)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Detail Co", "PHP");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("runs a balance forward and carries an opening figure", async () => {
    const post = (date: string, amount: string) =>
      postJournalEntry({
        companyId: fixture.company.id,
        date: new Date(`${date}T00:00:00Z`),
        sourceType: "MANUAL",
        lines: [
          { accountId: fixture.code("1000").id, debit: amount },
          { accountId: fixture.code("4000").id, credit: amount },
        ],
      });

    await post("2026-01-10", "1000.00");
    await post("2026-02-10", "500.00");
    await post("2026-03-10", "250.00");

    const detail = await accountDetail({
      companyId: fixture.company.id,
      accountId: fixture.code("1000").id,
      from: new Date(Date.UTC(2026, 1, 1)),
      to: new Date(Date.UTC(2026, 11, 31)),
    });

    // January is before the period, so it is the opening balance.
    expect(detail.opening.toFixed(2)).toBe("1000.00");
    expect(detail.rows).toHaveLength(2);
    expect(detail.rows[0].runningBalance.toFixed(2)).toBe("1500.00");
    expect(detail.rows[1].runningBalance.toFixed(2)).toBe("1750.00");
    expect(detail.closing.toFixed(2)).toBe("1750.00");
  });

  it("names the party on a control-account line, so aging can be read from the ledger", async () => {
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.company.id,
        name: "Acme",
        emails: [],
        defaultCurrency: "PHP",
      },
    });
    await postJournalEntry({
      companyId: fixture.company.id,
      date: new Date(Date.UTC(2026, 2, 1)),
      sourceType: "INVOICE",
      lines: [
        {
          accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id,
          debit: "100.00",
          customerId: customer.id,
        },
        { accountId: fixture.code("4000").id, credit: "100.00" },
      ],
    });

    const detail = await accountDetail({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id,
      to: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(detail.rows[0].partyName).toBe("Acme");
    expect(detail.rows[0].sourceType).toBe("INVOICE");
  });
});
