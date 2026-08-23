import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ExpenseKind, RecurringFrequency } from "@prisma/client";
import {
  firstRunDate,
  generateBillOccurrence,
  runRecurringBills,
  upcomingBills,
  whyTemplateCannotRun,
} from "@/lib/payables/recurring-bills";
import { closeBooksThrough } from "@/lib/periods/close";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/reports";
import { money } from "@/lib/money";
import { isoDate } from "@/lib/dates";
import { makeCompanyWithChart, makeUser, makeVendor, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const AS_OF = new Date(Date.UTC(2027, 11, 31));

/**
 * Recurring bills (SPEC §8.2a).
 *
 * The schedule arithmetic itself is tested once, against the invoice engine
 * these share — so what is proved here is the payables half: that a firing
 * posts through the one posting path, that it fires once and only once, that a
 * gap catches up period by period, and that every refusal lands somewhere a
 * person will see it rather than vanishing into a 06:00 job.
 */
describe("recurring bills", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let vendor: Awaited<ReturnType<typeof makeVendor>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Ledger Co", "PHP");
    owner = await makeUser("OWNER", fixture.company.id);
    vendor = await makeVendor(fixture.company.id, "REGULAR", { name: "Landlord" });
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const ap = () =>
    accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
      asOf: AS_OF,
    });

  const balance = (code: string) =>
    accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.code(code).id,
      asOf: AS_OF,
    });

  async function template(overrides: {
    kind?: ExpenseKind;
    frequency?: RecurringFrequency;
    startDate?: Date;
    nextRunDate?: Date;
    amount?: string;
    endDate?: Date | null;
    occurrenceLimit?: number | null;
    vendorId?: string | null;
    paymentAccountId?: string | null;
    isPaused?: boolean;
  } = {}) {
    const kind = overrides.kind ?? "BILL";
    const startDate = overrides.startDate ?? new Date(Date.UTC(2026, 7, 1));
    return prisma.recurringBillTemplate.create({
      data: {
        companyId: fixture.company.id,
        name: "Office rent",
        kind,
        vendorId:
          overrides.vendorId !== undefined
            ? overrides.vendorId
            : kind === "BILL"
              ? vendor.id
              : null,
        frequency: overrides.frequency ?? "MONTHLY",
        dayOfMonth: startDate.getUTCDate(),
        startDate,
        endDate: overrides.endDate ?? null,
        occurrenceLimit: overrides.occurrenceLimit ?? null,
        nextRunDate: overrides.nextRunDate ?? startDate,
        isPaused: overrides.isPaused ?? false,
        currency: "PHP",
        amount: overrides.amount ?? "25000.00",
        expenseAccountId: fixture.code("6000").id,
        paymentAccountId:
          overrides.paymentAccountId !== undefined
            ? overrides.paymentAccountId
            : kind === "DIRECT"
              ? fixture.code("1000").id
              : null,
        paymentTermsDays: 15,
        description: "August rent",
      },
    });
  }

  describe("recording one occurrence", () => {
    it("posts a bill to accounts payable and links the run to it", async () => {
      const rent = await template();

      const result = await generateBillOccurrence({
        templateId: rent.id,
        scheduledDate: new Date(Date.UTC(2026, 7, 1)),
      });

      expect(result.status).toBe("RECORDED");
      expect((await ap()).toFixed(2)).toBe("25000.00");
      expect((await balance("6000")).toFixed(2)).toBe("25000.00");

      const expense = await prisma.expense.findFirstOrThrow();
      expect(expense.kind).toBe("BILL");
      expect(expense.vendorId).toBe(vendor.id);
      expect(isoDate(expense.date)).toBe("2026-08-01");
      // paymentTermsDays: 15.
      expect(isoDate(expense.dueDate!)).toBe("2026-08-16");
      expect(money(expense.amount).toFixed(2)).toBe("25000.00");

      const run = await prisma.recurringBillRun.findFirstOrThrow();
      expect(run.expenseId).toBe(expense.id);
      expect(run.skippedReason).toBeNull();
    });

    it("posts a direct expense against the bank instead", async () => {
      const subscription = await template({ kind: "DIRECT", amount: "990.00" });

      await generateBillOccurrence({
        templateId: subscription.id,
        scheduledDate: new Date(Date.UTC(2026, 7, 1)),
      });

      expect((await ap()).toFixed(2)).toBe("0.00");
      expect((await balance("1000")).toFixed(2)).toBe("-990.00");
      const expense = await prisma.expense.findFirstOrThrow();
      expect(expense.kind).toBe("DIRECT");
      expect(expense.paymentAccountId).toBe(fixture.code("1000").id);
    });

    it("advances the schedule and counts the occurrence", async () => {
      const rent = await template();
      await generateBillOccurrence({
        templateId: rent.id,
        scheduledDate: new Date(Date.UTC(2026, 7, 1)),
      });

      const after = await prisma.recurringBillTemplate.findUniqueOrThrow({
        where: { id: rent.id },
      });
      expect(isoDate(after.nextRunDate)).toBe("2026-09-01");
      expect(isoDate(after.lastRunDate!)).toBe("2026-08-01");
      expect(after.occurrenceCount).toBe(1);
    });

    /*
     * The whole reason for the (templateId, scheduledDate) unique row. This
     * deployment runs two schedulers on purpose, so a second firing for the
     * same date is the expected case, not a hypothetical.
     */
    it("records a date once, however many times it is asked", async () => {
      const rent = await template();
      const date = new Date(Date.UTC(2026, 7, 1));

      const first = await generateBillOccurrence({ templateId: rent.id, scheduledDate: date });
      const second = await generateBillOccurrence({ templateId: rent.id, scheduledDate: date });

      expect(first.status).toBe("RECORDED");
      expect(second.status).toBe("ALREADY_RUN");
      expect(await prisma.expense.count()).toBe(1);
      expect((await ap()).toFixed(2)).toBe("25000.00");
    });

    it("survives two schedulers firing at the same moment", async () => {
      const rent = await template();
      const date = new Date(Date.UTC(2026, 7, 1));

      const results = await Promise.all([
        generateBillOccurrence({ templateId: rent.id, scheduledDate: date }),
        generateBillOccurrence({ templateId: rent.id, scheduledDate: date }),
      ]);

      expect(results.filter((r) => r.status === "RECORDED")).toHaveLength(1);
      expect(results.filter((r) => r.status === "ALREADY_RUN")).toHaveLength(1);
      expect(await prisma.expense.count()).toBe(1);
    });

    it("records the reason on the run row when the posting is refused", async () => {
      const rent = await template();
      await closeBooksThrough(
        { companyId: fixture.company.id, userId: owner.id, role: "OWNER" },
        new Date(Date.UTC(2026, 7, 31)),
      );

      const result = await generateBillOccurrence({
        templateId: rent.id,
        scheduledDate: new Date(Date.UTC(2026, 7, 1)),
      });

      // The scheduler is not an owner, so a closed period stops it — which is
      // right, and has to be visible rather than silent.
      expect(result.status).toBe("SKIPPED");
      expect(result.reason).toMatch(/books are closed/);
      const run = await prisma.recurringBillRun.findFirstOrThrow();
      expect(run.skippedReason).toMatch(/books are closed/);
      expect(run.expenseId).toBeNull();
      expect(await prisma.expense.count()).toBe(0);
    });

    it("stops past the end date, and says so on the run", async () => {
      const rent = await template({ endDate: new Date(Date.UTC(2026, 6, 31)) });
      const result = await generateBillOccurrence({
        templateId: rent.id,
        scheduledDate: new Date(Date.UTC(2026, 7, 1)),
      });

      expect(result.status).toBe("SKIPPED");
      expect(result.reason).toMatch(/end date/);
      expect(await prisma.expense.count()).toBe(0);
    });

    it("stops at the occurrence limit", async () => {
      const rent = await template({ occurrenceLimit: 1 });
      await generateBillOccurrence({
        templateId: rent.id,
        scheduledDate: new Date(Date.UTC(2026, 7, 1)),
      });
      const second = await generateBillOccurrence({
        templateId: rent.id,
        scheduledDate: new Date(Date.UTC(2026, 8, 1)),
      });

      expect(second.status).toBe("SKIPPED");
      expect(second.reason).toMatch(/limit/);
      expect(await prisma.expense.count()).toBe(1);
    });

    it("refuses a bill template with no vendor rather than posting a broken one", async () => {
      const orphan = await template({ vendorId: null });
      const result = await generateBillOccurrence({
        templateId: orphan.id,
        scheduledDate: new Date(Date.UTC(2026, 7, 1)),
      });

      expect(result.status).toBe("SKIPPED");
      expect(result.reason).toMatch(/needs a vendor/);
    });

    it("leaves what it records undeletable, because no person recorded it", async () => {
      const rent = await template();
      await generateBillOccurrence({
        templateId: rent.id,
        scheduledDate: new Date(Date.UTC(2026, 7, 1)),
      });

      // Same-day delete needs an author to match, and the scheduler is not a
      // person. So a generated bill is corrected by reverse-and-repost, which
      // is right for something that will be back next month.
      const entry = await prisma.journalEntry.findFirstOrThrow();
      expect(entry.createdByUserId).toBeNull();
    });
  });

  describe("whyTemplateCannotRun", () => {
    const base = {
      kind: "BILL" as ExpenseKind,
      vendorId: "vendor-1",
      paymentAccountId: null,
      amount: money("100.00"),
    };

    it("passes a usable bill", () => {
      expect(whyTemplateCannotRun(base)).toBeNull();
    });

    it("catches a bill with no vendor", () => {
      expect(whyTemplateCannotRun({ ...base, vendorId: null })).toMatch(/needs a vendor/);
    });

    it("catches a direct expense with nothing to pay from", () => {
      expect(
        whyTemplateCannotRun({ ...base, kind: "DIRECT", vendorId: null }),
      ).toMatch(/paid from/);
    });

    it("catches a zero amount", () => {
      expect(whyTemplateCannotRun({ ...base, amount: money("0") })).toMatch(/more than zero/);
    });
  });

  describe("the job", () => {
    // 10:00 UTC is 18:00 in Asia/Manila, the seed's operating zone — past the
    // 06:00 gate the job applies in each company's own time.
    const at = (year: number, month: number, day: number) =>
      new Date(Date.UTC(year, month, day, 10, 0, 0));

    it("records nothing before 06:00 in the company's own zone", async () => {
      await template({ nextRunDate: new Date(Date.UTC(2026, 7, 1)) });
      // 20:00 UTC is 04:00 the next day in Manila.
      const results = await runRecurringBills(new Date(Date.UTC(2026, 7, 1, 20, 0, 0)));
      expect(results).toEqual([]);
      expect(await prisma.expense.count()).toBe(0);
    });

    it("catches up one bill per missed period, not one lump", async () => {
      // Due since August, and nobody ran the job until November.
      await template({ startDate: new Date(Date.UTC(2026, 7, 1)) });

      const results = await runRecurringBills(at(2026, 10, 15));

      expect(results.map((r) => r.scheduledDate)).toEqual([
        "2026-08-01",
        "2026-09-01",
        "2026-10-01",
        "2026-11-01",
      ]);
      expect(results.every((r) => r.status === "RECORDED")).toBe(true);
      // Each month's rent was genuinely owed, so each is its own bill.
      expect(await prisma.expense.count()).toBe(4);
      expect((await ap()).toFixed(2)).toBe("100000.00");
    });

    it("does nothing on a second pass over the same day", async () => {
      await template();
      await runRecurringBills(at(2026, 7, 15));
      const before = await prisma.expense.count();

      const second = await runRecurringBills(at(2026, 7, 15));

      expect(second).toEqual([]);
      expect(await prisma.expense.count()).toBe(before);
    });

    it("skips a paused template entirely", async () => {
      await template({ isPaused: true });
      const results = await runRecurringBills(at(2026, 7, 15));
      expect(results).toEqual([]);
      expect(await prisma.expense.count()).toBe(0);
    });

    it("leaves a template whose date has not arrived alone", async () => {
      await template({ nextRunDate: new Date(Date.UTC(2026, 11, 1)) });
      const results = await runRecurringBills(at(2026, 7, 15));
      expect(results).toEqual([]);
    });
  });

  describe("the upcoming list", () => {
    it("lists what each live template will record in the window", async () => {
      await template({ startDate: new Date(Date.UTC(2026, 7, 1)) });

      const rows = await upcomingBills({
        companyId: fixture.company.id,
        from: new Date(Date.UTC(2026, 7, 1)),
        days: 90,
      });

      expect(rows.map((row) => isoDate(row.date))).toEqual([
        "2026-08-01",
        "2026-09-01",
        "2026-10-01",
      ]);
      expect(rows[0].vendorName).toBe("Landlord");
      expect(rows[0].kind).toBe("BILL");
    });

    it("shows nothing for a paused template", async () => {
      await template({ isPaused: true });
      const rows = await upcomingBills({
        companyId: fixture.company.id,
        from: new Date(Date.UTC(2026, 7, 1)),
        days: 90,
      });
      expect(rows).toEqual([]);
    });
  });

  describe("firstRunDate", () => {
    it("does not fire for a date already gone when a template is set up mid-month", () => {
      const schedule = {
        frequency: "MONTHLY" as const,
        startDate: new Date(Date.UTC(2026, 7, 1)),
        dayOfMonth: 1,
      };
      // Set up on the 20th: the next rent is September's, not August's.
      const next = firstRunDate(schedule, new Date(Date.UTC(2026, 7, 20)));
      expect(isoDate(next)).toBe("2026-09-01");
    });

    it("clamps a day that a month does not have", () => {
      const schedule = {
        frequency: "MONTHLY" as const,
        startDate: new Date(Date.UTC(2026, 0, 31)),
        dayOfMonth: 31,
      };
      expect(isoDate(firstRunDate(schedule, new Date(Date.UTC(2026, 1, 1))))).toBe("2026-02-28");
    });
  });
});
