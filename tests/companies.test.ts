import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createCompany, whyNotACompany } from "@/lib/companies";
import { withCompanyScope } from "@/lib/company-scope";
import { recordExpense } from "@/lib/payables/expenses";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/reports";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

const DATE = new Date(Date.UTC(2026, 7, 15));

/**
 * Creating a company (SPEC §3).
 *
 * The thing worth proving is not that a row appears — it is that the new
 * company is genuinely usable and genuinely separate. A half-built company is
 * worse than none: it is reachable from the switcher and fails at the first
 * posting.
 */
describe("creating a company", () => {
  let existing: Awaited<ReturnType<typeof makeCompanyWithChart>>;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDatabase();
    existing = await makeCompanyWithChart("Bookkeeping Point", "PHP");
    owner = await makeUser("OWNER", existing.company.id);
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const create = (name = "GAMI Studio Apartments", currency = "PHP") =>
    createCompany({
      name,
      baseCurrency: currency,
      fiscalYearStartMonth: 1,
      timeClockTimeZone: "Asia/Manila",
      operatingTimeZone: "Asia/Manila",
      userId: owner.id,
    });

  it("arrives usable: chart of accounts, numbering and an owner", async () => {
    const company = await create();

    expect(company.name).toBe("GAMI Studio Apartments");
    expect(company.setupCompletedAt).toBeTruthy();

    // Without these three it is reachable and broken.
    expect(await prisma.account.count({ where: { companyId: company.id } })).toBeGreaterThan(10);
    expect(await prisma.numberSequence.count({ where: { companyId: company.id } })).toBe(4);
    const membership = await prisma.membership.findFirstOrThrow({
      where: { companyId: company.id, userId: owner.id },
    });
    expect(membership.role).toBe("OWNER");
  });

  it("starts its document numbering from scratch, not the other company's", async () => {
    const company = await create();
    const invoices = await prisma.numberSequence.findFirstOrThrow({
      where: { companyId: company.id, kind: "INVOICE" },
    });
    expect(invoices.prefix).toBe("INV");
    expect(invoices.nextValue).toBe(1001);
  });

  it("keeps its books entirely separate", async () => {
    const company = await create();
    const chart = await prisma.account.findMany({ where: { companyId: company.id } });
    const expenseAccount = chart.find((account) => account.code === "6000")!;
    const bank = chart.find((account) => account.code === "1000")!;

    await recordExpense({
      companyId: company.id,
      kind: "DIRECT",
      date: DATE,
      currency: "PHP",
      amount: "1500.00",
      expenseAccountId: expenseAccount.id,
      paymentAccountId: bank.id,
      description: "Studio cleaning",
      userId: owner.id,
      role: "OWNER",
    });

    // The new company's expense.
    expect(
      (
        await accountBalance({
          companyId: company.id,
          accountId: expenseAccount.id,
          asOf: new Date(Date.UTC(2026, 11, 31)),
        })
      ).toFixed(2),
    ).toBe("1500.00");

    // The old company's identically-coded account has not moved.
    expect(
      (
        await accountBalance({
          companyId: existing.company.id,
          accountId: existing.code("6000").id,
          asOf: new Date(Date.UTC(2026, 11, 31)),
        })
      ).toFixed(2),
    ).toBe("0.00");

    expect(await prisma.expense.count({ where: { companyId: existing.company.id } })).toBe(0);
    expect(await prisma.expense.count({ where: { companyId: company.id } })).toBe(1);
  });

  it("gives the new company its own system accounts", async () => {
    const company = await create();
    const ap = await prisma.account.findFirstOrThrow({
      where: { companyId: company.id, systemKey: SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE },
    });
    // Same key, different row: a system account is per company, never shared.
    expect(ap.companyId).toBe(company.id);
    const theirs = await prisma.account.findFirstOrThrow({
      where: {
        companyId: existing.company.id,
        systemKey: SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE,
      },
    });
    expect(theirs.id).not.toBe(ap.id);
  });

  it("puts the creator's companies under one organisation", async () => {
    const company = await create();
    expect(company.organizationId).toBe(existing.company.organizationId);
  });

  it("lets the creator reach it, and nobody else", async () => {
    const company = await create();
    const stranger = await makeUser("OWNER", existing.company.id, "stranger@example.test");

    const scope = await withCompanyScope(owner.id, company.id);
    expect(scope.role).toBe("OWNER");
    expect(scope.hasSection("VENDORS")).toBe(true);

    await expect(withCompanyScope(stranger.id, company.id)).rejects.toThrow();
  });

  it("refuses a second company with the same name for one person", async () => {
    await create();
    // Two identically named entries make a switcher nobody can read.
    await expect(create()).rejects.toThrow(/already have a company called/);
  });

  it("allows the same name for a different person", async () => {
    await create();
    const other = await makeUser("OWNER", existing.company.id, "other@example.test");
    const theirs = await createCompany({
      name: "GAMI Studio Apartments",
      baseCurrency: "PHP",
      fiscalYearStartMonth: 1,
      timeClockTimeZone: "Asia/Manila",
      operatingTimeZone: "Asia/Manila",
      userId: other.id,
    });
    expect(theirs.id).toBeTruthy();
  });

  it("leaves nothing behind when it refuses", async () => {
    const before = await prisma.company.count();
    await expect(create("", "PHP")).rejects.toThrow(/Give the company a name/);
    expect(await prisma.company.count()).toBe(before);
  });

  it("takes a currency other than the first company's", async () => {
    const company = await create("Northbridge", "USD");
    expect(company.baseCurrency).toBe("USD");
  });
});

describe("whyNotACompany", () => {
  const base = { name: "GAMI Studio Apartments", baseCurrency: "PHP", fiscalYearStartMonth: 1 };

  it("passes a usable one", () => {
    expect(whyNotACompany(base)).toBeNull();
  });

  it("catches an empty or whitespace name", () => {
    expect(whyNotACompany({ ...base, name: "   " })).toMatch(/Give the company a name/);
  });

  it("catches a currency the app cannot report in", () => {
    expect(whyNotACompany({ ...base, baseCurrency: "XYZ" })).toMatch(/base currency/);
  });

  it("catches a fiscal year starting in month 13", () => {
    expect(whyNotACompany({ ...base, fiscalYearStartMonth: 13 })).toMatch(/real month/);
    expect(whyNotACompany({ ...base, fiscalYearStartMonth: 0 })).toMatch(/real month/);
  });
});
