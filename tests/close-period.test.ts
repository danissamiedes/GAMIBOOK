import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closableMonths,
  closeBooksThrough,
  isMonthEnd,
  monthEnd,
  monthLabel,
  parseCloseDate,
  reopenAll,
} from "@/lib/periods/close";
import { recordExpense } from "@/lib/payables/expenses";
import { PostingError, RoleError } from "@/lib/errors";
import { makeCompanyWithChart, makeUser, makeVendor, prisma, resetDatabase } from "./helpers";

const AUGUST = new Date(Date.UTC(2026, 7, 15));
const JULY_END = new Date(Date.UTC(2026, 6, 31));
const JUNE_END = new Date(Date.UTC(2026, 5, 30));
/** Standing in August 2026, so July is the last month that has ended. */
const NOW = new Date(Date.UTC(2026, 7, 22));

describe("month ends", () => {
  it("finds the last day of the month, February included", () => {
    expect(monthEnd(new Date(Date.UTC(2026, 1, 3))).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    // A leap year, which a naive "the 30th or the 31st" gets wrong.
    expect(monthEnd(new Date(Date.UTC(2028, 1, 3))).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(monthEnd(new Date(Date.UTC(2026, 6, 1))).toISOString()).toBe(
      "2026-07-31T00:00:00.000Z",
    );
  });

  it("recognises a month end and refuses everything else", () => {
    expect(isMonthEnd(JULY_END)).toBe(true);
    expect(isMonthEnd(new Date(Date.UTC(2026, 6, 30)))).toBe(false);
  });

  it("names the month a close date belongs to", () => {
    expect(monthLabel(JULY_END)).toBe("July 2026");
  });
});

describe("closableMonths", () => {
  it("lists ended months from the first posting, newest first", () => {
    const months = closableMonths({ earliest: new Date(Date.UTC(2026, 4, 9)), now: NOW });
    expect(months.map((m) => m.value)).toEqual([
      "2026-07-31",
      "2026-06-30",
      "2026-05-31",
    ]);
    expect(months[0].label).toBe("July 2026 (through 07/31/2026)");
  });

  it("offers nothing when nothing has been posted", () => {
    expect(closableMonths({ earliest: null, now: NOW })).toEqual([]);
  });

  it("never offers the month you are standing in", () => {
    const months = closableMonths({ earliest: new Date(Date.UTC(2026, 7, 1)), now: NOW });
    expect(months).toEqual([]);
  });

  it("stops at the limit rather than running back for years", () => {
    const months = closableMonths({
      earliest: new Date(Date.UTC(2010, 0, 1)),
      now: NOW,
      limit: 4,
    });
    expect(months).toHaveLength(4);
    expect(months[0].value).toBe("2026-07-31");
  });
});

describe("parseCloseDate", () => {
  it("takes a month end that has passed", () => {
    expect(parseCloseDate("2026-07-31", NOW).toISOString()).toBe("2026-07-31T00:00:00.000Z");
  });

  it("refuses a date inside a month", () => {
    // Closing mid-month would leave a reported month still able to change.
    expect(() => parseCloseDate("2026-07-15", NOW)).toThrow(/not a month end/);
  });

  it("refuses a month that has not ended", () => {
    expect(() => parseCloseDate("2026-08-31", NOW)).toThrow(/has not ended/);
  });

  it("refuses nothing at all", () => {
    expect(() => parseCloseDate("", NOW)).toThrow(/Choose a month/);
    expect(() => parseCloseDate("31/07/2026", NOW)).toThrow(/Choose a month/);
  });
});

describe("closing and reopening", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Ledger Co", "PHP");
    owner = await makeUser("OWNER", fixture.company.id);
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const actor = (role: "OWNER" | "BOOKKEEPER") => ({
    companyId: fixture.company.id,
    userId: owner.id,
    role: role as never,
  });

  async function closedThrough() {
    const company = await prisma.company.findUniqueOrThrow({
      where: { id: fixture.company.id },
      select: { booksClosedThrough: true },
    });
    return company.booksClosedThrough;
  }

  it("sets the date and writes an audit row", async () => {
    await closeBooksThrough(actor("OWNER"), JULY_END);

    expect((await closedThrough())?.toISOString()).toBe("2026-07-31T00:00:00.000Z");
    const audit = await prisma.auditLog.findFirst({
      where: { companyId: fixture.company.id, action: "period.closed" },
    });
    expect(audit?.summary).toBe("Closed through 07/31/2026");
    expect(audit?.data).toEqual({ from: null, to: "2026-07-31" });
  });

  it("refuses anyone but an owner, and changes nothing", async () => {
    await expect(closeBooksThrough(actor("BOOKKEEPER"), JULY_END)).rejects.toThrow(RoleError);
    expect(await closedThrough()).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "period.closed" } })).toBe(0);
  });

  it("audits a move backwards as a reopen, not a close", async () => {
    await closeBooksThrough(actor("OWNER"), JULY_END);
    await closeBooksThrough(actor("OWNER"), JUNE_END);

    expect((await closedThrough())?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    const audit = await prisma.auditLog.findFirst({
      where: { action: "period.reopened" },
      orderBy: { at: "desc" },
    });
    expect(audit?.summary).toBe("Reopened back to 06/30/2026 from 07/31/2026");
  });

  it("does nothing, and says nothing, when the date is already set", async () => {
    await closeBooksThrough(actor("OWNER"), JULY_END);
    const again = await closeBooksThrough(actor("OWNER"), JULY_END);

    expect(again.changed).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "period." } } })).toBe(1);
  });

  it("reopens everything", async () => {
    await closeBooksThrough(actor("OWNER"), JULY_END);
    await reopenAll(actor("OWNER"));

    expect(await closedThrough()).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { action: "period.reopened" },
      orderBy: { at: "desc" },
    });
    expect(audit?.summary).toBe("Reopened everything — was closed through 07/31/2026");
    expect(audit?.data).toEqual({ from: "2026-07-31", to: null });
  });

  it("reopening when nothing is closed is not an event", async () => {
    const result = await reopenAll(actor("OWNER"));
    expect(result.changed).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "period.reopened" } })).toBe(0);
  });
});

/**
 * The point of the feature, and the reason the lock lives in postJournalEntry
 * rather than in each form: closing a month has to stop the vendor-side
 * documents the owner was thinking of AND the customer-side ones they were not,
 * or the P&L for a closed month can still move.
 */
describe("what a closed month actually stops", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let vendor: Awaited<ReturnType<typeof makeVendor>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Ledger Co", "PHP");
    owner = await makeUser("OWNER", fixture.company.id);
    vendor = await makeVendor(fixture.company.id, "REGULAR");
    await closeBooksThrough(
      { companyId: fixture.company.id, userId: owner.id, role: "OWNER" },
      JULY_END,
    );
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const expense = (kind: "DIRECT" | "BILL", date: Date, role: "OWNER" | "BOOKKEEPER") =>
    recordExpense({
      companyId: fixture.company.id,
      kind,
      date,
      currency: "PHP",
      amount: "100.00",
      expenseAccountId: fixture.code("6000").id,
      paymentAccountId: kind === "DIRECT" ? fixture.code("1000").id : null,
      // A bill is owed to someone; a direct expense need not name them.
      vendorId: kind === "BILL" ? vendor.id : null,
      description: "Paint",
      userId: owner.id,
      role,
    });

  it("refuses a bookkeeper's direct expense dated inside the closed month", async () => {
    await expect(expense("DIRECT", JULY_END, "BOOKKEEPER")).rejects.toThrow(
      /books are closed through 07\/31\/2026/,
    );
    expect(await prisma.expense.count()).toBe(0);
  });

  it("refuses a bookkeeper's bill dated inside the closed month", async () => {
    await expect(expense("BILL", new Date(Date.UTC(2026, 6, 2)), "BOOKKEEPER")).rejects.toThrow(
      /books are closed/,
    );
    expect(await prisma.expense.count()).toBe(0);
  });

  it("lets a bookkeeper post the day after the close", async () => {
    const ok = await expense("DIRECT", new Date(Date.UTC(2026, 7, 1)), "BOOKKEEPER");
    expect(ok.expense.id).toBeTruthy();
  });

  it("lets the owner through, deliberately", async () => {
    const ok = await expense("DIRECT", JULY_END, "OWNER");
    expect(ok.expense.id).toBeTruthy();
  });

  it("stops being a wall once the period is reopened", async () => {
    await reopenAll({ companyId: fixture.company.id, userId: owner.id, role: "OWNER" });
    const ok = await expense("DIRECT", JULY_END, "BOOKKEEPER");
    expect(ok.expense.id).toBeTruthy();
  });

  it("says mm/dd/yyyy in the refusal, like the rest of the app", async () => {
    await expect(expense("DIRECT", AUGUST, "BOOKKEEPER")).resolves.toBeTruthy();
    await expect(expense("DIRECT", JULY_END, "BOOKKEEPER")).rejects.toThrow(
      /closed through 07\/31\/2026\./,
    );
  });

  it("refuses a PostingError, so a form can show it rather than a stack trace", async () => {
    await expect(expense("DIRECT", JULY_END, "BOOKKEEPER")).rejects.toBeInstanceOf(PostingError);
  });
});
