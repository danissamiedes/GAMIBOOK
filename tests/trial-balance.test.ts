import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { postJournalEntry } from "@/lib/ledger/post";
import { postOpeningBalances } from "@/lib/ledger/opening-balances";
import { accountBalance, trialBalance } from "@/lib/ledger/reports";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { makeCompanyWithChart, prisma, resetDatabase } from "./helpers";

describe("trial balance (SPEC §12.3)", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Reporting Co", "PHP");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const post = (date: string, lines: Parameters<typeof postJournalEntry>[0]["lines"]) =>
    postJournalEntry({
      companyId: fixture.company.id,
      date: new Date(`${date}T00:00:00Z`),
      sourceType: "MANUAL",
      lines,
    });

  it("totals debits and credits equally", async () => {
    await post("2026-01-10", [
      { accountId: fixture.code("1000").id, debit: "10000.00" },
      { accountId: fixture.code("3000").id, credit: "10000.00" },
    ]);
    await post("2026-02-05", [
      { accountId: fixture.code("6200").id, debit: "2500.00" },
      { accountId: fixture.code("1000").id, credit: "2500.00" },
    ]);

    const tb = await trialBalance({ companyId: fixture.company.id, asOf: new Date("2026-12-31") });

    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit.toFixed(2)).toBe(tb.totalCredit.toFixed(2));
    expect(tb.totalDebit.toFixed(2)).toBe("10000.00");

    const bank = tb.rows.find((row) => row.code === "1000");
    expect(bank?.debit.toFixed(2)).toBe("7500.00");
    expect(bank?.credit.toFixed(2)).toBe("0.00");

    const rent = tb.rows.find((row) => row.code === "6200");
    expect(rent?.debit.toFixed(2)).toBe("2500.00");
  });

  it("shows each account on its natural side, netting both directions", async () => {
    await post("2026-01-10", [
      { accountId: fixture.code("1000").id, debit: "500.00" },
      { accountId: fixture.code("4000").id, credit: "500.00" },
    ]);
    await post("2026-01-11", [
      { accountId: fixture.code("4000").id, debit: "200.00" },
      { accountId: fixture.code("1000").id, credit: "200.00" },
    ]);

    const tb = await trialBalance({ companyId: fixture.company.id, asOf: new Date("2026-12-31") });
    const income = tb.rows.find((row) => row.code === "4000");
    expect(income?.credit.toFixed(2)).toBe("300.00");
    expect(income?.debit.toFixed(2)).toBe("0.00");
  });

  it("respects the as-of date and the period start", async () => {
    await post("2026-01-10", [
      { accountId: fixture.code("6200").id, debit: "100.00" },
      { accountId: fixture.code("1000").id, credit: "100.00" },
    ]);
    await post("2026-06-10", [
      { accountId: fixture.code("6200").id, debit: "50.00" },
      { accountId: fixture.code("1000").id, credit: "50.00" },
    ]);

    const toMarch = await trialBalance({
      companyId: fixture.company.id,
      asOf: new Date("2026-03-31"),
    });
    expect(toMarch.rows.find((r) => r.code === "6200")?.debit.toFixed(2)).toBe("100.00");

    const fromApril = await trialBalance({
      companyId: fixture.company.id,
      asOf: new Date("2026-12-31"),
      from: new Date("2026-04-01"),
    });
    expect(fromApril.rows.find((r) => r.code === "6200")?.debit.toFixed(2)).toBe("50.00");
    expect(fromApril.balanced).toBe(true);
  });

  it("never mixes one company's figures into another's", async () => {
    const other = await makeCompanyWithChart("Neighbour Co", "USD");
    await post("2026-01-10", [
      { accountId: fixture.code("1000").id, debit: "999.00" },
      { accountId: fixture.code("3000").id, credit: "999.00" },
    ]);

    const theirs = await trialBalance({ companyId: other.company.id, asOf: new Date("2026-12-31") });
    expect(theirs.rows).toHaveLength(0);
    expect(theirs.totalDebit.toFixed(2)).toBe("0.00");
  });

  it("reports an account balance on its normal side", async () => {
    await post("2026-01-10", [
      { accountId: fixture.code("1000").id, debit: "1000.00" },
      { accountId: fixture.code("4000").id, credit: "1000.00" },
    ]);

    const bank = await accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.code("1000").id,
      asOf: new Date("2026-12-31"),
    });
    const income = await accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.code("4000").id,
      asOf: new Date("2026-12-31"),
    });

    // Both positive: a debit-normal asset and a credit-normal income account.
    expect(bank.toFixed(2)).toBe("1000.00");
    expect(income.toFixed(2)).toBe("1000.00");
  });
});

describe("opening balances (SPEC §4.3)", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Opening Co", "PHP");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("posts one entry with the difference plugged to Opening Balance Equity", async () => {
    const entry = await postOpeningBalances({
      companyId: fixture.company.id,
      date: new Date("2026-01-01T00:00:00Z"),
      balances: [
        { accountId: fixture.code("1000").id, amount: "250000.00" }, // bank
        { accountId: fixture.code("2100").id, amount: "40000.00" }, // credit card owed
      ],
    });

    expect(entry.sourceType).toBe("OPENING_BALANCE");

    const equity = fixture.system(SYSTEM_ACCOUNTS.OPENING_BALANCE_EQUITY);
    const plug = entry.lines.find((line) => line.accountId === equity.id);
    // 250,000 debit against 40,000 credit leaves a 210,000 credit plug.
    expect(plug?.credit.toFixed(2)).toBe("210000.00");

    const tb = await trialBalance({ companyId: fixture.company.id, asOf: new Date("2026-01-01") });
    expect(tb.balanced).toBe(true);
  });

  it("puts a negative balance on the other side", async () => {
    const entry = await postOpeningBalances({
      companyId: fixture.company.id,
      date: new Date("2026-01-01T00:00:00Z"),
      balances: [
        { accountId: fixture.code("1000").id, amount: "100000.00" },
        { accountId: fixture.code("1010").id, amount: "-500.00" }, // overdrawn petty cash
      ],
    });

    const pettyCash = entry.lines.find((line) => line.accountId === fixture.code("1010").id);
    expect(pettyCash?.credit.toFixed(2)).toBe("500.00");
    expect(pettyCash?.debit.toFixed(2)).toBe("0.00");
  });

  it("refuses income statement accounts — prior results are retained earnings", async () => {
    await expect(
      postOpeningBalances({
        companyId: fixture.company.id,
        date: new Date("2026-01-01T00:00:00Z"),
        balances: [
          { accountId: fixture.code("1000").id, amount: "100.00" },
          { accountId: fixture.code("4000").id, amount: "100.00" },
        ],
      }),
    ).rejects.toThrow(/income statement account/);
  });

  it("posts opening balances only once", async () => {
    await postOpeningBalances({
      companyId: fixture.company.id,
      date: new Date("2026-01-01T00:00:00Z"),
      balances: [{ accountId: fixture.code("1000").id, amount: "100.00" }],
    });
    await expect(
      postOpeningBalances({
        companyId: fixture.company.id,
        date: new Date("2026-01-01T00:00:00Z"),
        balances: [{ accountId: fixture.code("1000").id, amount: "200.00" }],
      }),
    ).rejects.toThrow(/already been posted/);
  });
});
