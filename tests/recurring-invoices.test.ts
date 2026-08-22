import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  dueOccurrences,
  generateOccurrence,
  occurrenceAfter,
  occurrenceOnOrAfter,
  operatingHour,
  runRecurringInvoices,
  upcomingOccurrences,
} from "@/lib/invoices/recurring";
import { isoDate } from "@/lib/dates";
import { accountBalance } from "@/lib/ledger/reports";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import {
  makeCompanyWithChart,
  makeCustomer,
  prisma,
  resetDatabase,
} from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const at = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));
const iso = (date: Date) => isoDate(date);

/** SPEC §7.2 — the schedule arithmetic, with no database in the way. */
describe("recurring schedules", () => {
  it("keeps a monthly schedule on its day, clamping only where the month is short", () => {
    const schedule = {
      frequency: "MONTHLY" as const,
      startDate: at(2026, 1, 31),
      dayOfMonth: 31,
    };
    const dates: Date[] = [];
    let cursor = occurrenceOnOrAfter(schedule, at(2026, 1, 1));
    for (let i = 0; i < 5; i += 1) {
      dates.push(cursor);
      cursor = occurrenceAfter(schedule, cursor);
    }
    // February is short, but March must go back to the 31st rather than
    // inheriting February's clamp and drifting to the 28th for ever.
    expect(dates.map(iso)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
  });

  it("keeps a fortnightly schedule on its own rhythm rather than near a month", () => {
    const schedule = {
      frequency: "BIWEEKLY" as const,
      startDate: at(2026, 1, 5),
    };
    const dates: Date[] = [];
    let cursor = occurrenceOnOrAfter(schedule, at(2026, 1, 1));
    for (let i = 0; i < 4; i += 1) {
      dates.push(cursor);
      cursor = occurrenceAfter(schedule, cursor);
    }
    expect(dates.map(iso)).toEqual([
      "2026-01-05",
      "2026-01-19",
      "2026-02-02",
      "2026-02-16",
    ]);
  });

  it("handles quarterly and annual", () => {
    const quarterly = {
      frequency: "QUARTERLY" as const,
      startDate: at(2026, 1, 15),
      dayOfMonth: 15,
    };
    expect(iso(occurrenceOnOrAfter(quarterly, at(2026, 2, 1)))).toBe(
      "2026-04-15",
    );

    const annually = {
      frequency: "ANNUALLY" as const,
      startDate: at(2026, 3, 1),
      dayOfMonth: 1,
      monthOfYear: 3,
    };
    expect(iso(occurrenceOnOrAfter(annually, at(2026, 4, 1)))).toBe(
      "2027-03-01",
    );
  });

  it("catches up one occurrence per missed period, not one lump", () => {
    const template = {
      frequency: "MONTHLY" as const,
      startDate: at(2026, 1, 10),
      dayOfMonth: 10,
      nextRunDate: at(2026, 1, 10),
    };
    expect(dueOccurrences(template, at(2026, 4, 30)).map(iso)).toEqual([
      "2026-01-10",
      "2026-02-10",
      "2026-03-10",
      "2026-04-10",
    ]);
  });

  it("stops at the end date", () => {
    const template = {
      frequency: "MONTHLY" as const,
      startDate: at(2026, 1, 10),
      dayOfMonth: 10,
      nextRunDate: at(2026, 1, 10),
      endDate: at(2026, 2, 28),
    };
    expect(dueOccurrences(template, at(2026, 6, 30)).map(iso)).toEqual([
      "2026-01-10",
      "2026-02-10",
    ]);
  });

  it("reads the hour in the company's own zone, not the server's", () => {
    // 22:00 UTC is 06:00 the next day in Manila — a Manila company is due, a
    // New York company is still on the previous evening.
    const instant = new Date("2026-03-01T22:00:00Z");
    expect(operatingHour(instant, "Asia/Manila")).toBe(6);
    expect(operatingHour(instant, "America/New_York")).toBe(17);
  });
});

describe("recurring invoices (SPEC §7.2)", () => {
  let fixture: Fixture;
  let customerId: string;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Retainer Co", "PHP");
    const customer = await makeCustomer(fixture.company.id, {
      name: "Cebu Retail",
    });
    customerId = customer.id;
  });

  const makeTemplate = (overrides: Record<string, unknown> = {}) =>
    prisma.recurringInvoiceTemplate.create({
      data: {
        companyId: fixture.company.id,
        customerId,
        name: "Monthly retainer",
        frequency: "MONTHLY",
        dayOfMonth: 1,
        startDate: at(2026, 6, 1),
        nextRunDate: at(2026, 6, 1),
        currency: "PHP",
        paymentTermsDays: 30,
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Retainer",
              quantity: "1",
              rate: "25000.00",
              incomeAccountId: fixture.code("4000").id,
            },
          ],
        },
        ...overrides,
      },
    });

  it("creates a draft and posts nothing, which is the default", async () => {
    const template = await makeTemplate();
    const result = await generateOccurrence({
      templateId: template.id,
      scheduledDate: at(2026, 6, 1),
    });
    expect(result.status).toBe("CREATED");

    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: result.invoiceId! },
      include: { lines: true },
    });
    expect(invoice.status).toBe("DRAFT");
    expect(invoice.invoiceNumber).toBeNull();
    // The draft carries its own total, rather than reading 0.00 on the list
    // until somebody issues it.
    expect(invoice.total.toFixed(2)).toBe("25000.00");
    expect(iso(invoice.dueDate)).toBe("2026-07-01");
    expect(invoice.lines).toHaveLength(1);

    // Nothing reached the ledger: a draft is not a receivable.
    const receivable = await accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id,
      asOf: at(2026, 6, 30),
    });
    expect(receivable.toFixed(2)).toBe("0.00");
  });

  it("issues when the template opts in, and posts through the normal service", async () => {
    const template = await makeTemplate({ mode: "AUTO_SEND" });
    const result = await generateOccurrence({
      templateId: template.id,
      scheduledDate: at(2026, 6, 1),
    });
    expect(result.status).toBe("ISSUED");
    expect(result.invoiceNumber).toMatch(/^INV\d+$/);

    const receivable = await accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id,
      asOf: at(2026, 6, 30),
    });
    expect(receivable.toFixed(2)).toBe("25000.00");
  });

  it("§15.13 — the job runs twice and invoices once, the requirement stated by name", async () => {
    await makeTemplate();
    const now = new Date("2026-06-01T00:00:00Z"); // 08:00 in Manila
    const first = await runRecurringInvoices(now);
    const second = await runRecurringInvoices(now);

    expect(first.filter((row) => row.status === "CREATED")).toHaveLength(1);
    expect(second.every((row) => row.status === "ALREADY_RUN")).toBe(true);
    expect(
      await prisma.invoice.count({ where: { companyId: fixture.company.id } }),
    ).toBe(1);
  });

  it("two runs at the same moment still invoice once", async () => {
    const template = await makeTemplate();
    // The check-then-write version of this passes when run sequentially and
    // fails here, which is the whole reason the constraint does the work.
    // Prisma logs the losing inserts as unique-constraint errors; they are
    // caught and turned into ALREADY_RUN, so that output is the test working.
    const results = await Promise.all([
      generateOccurrence({
        templateId: template.id,
        scheduledDate: at(2026, 6, 1),
      }),
      generateOccurrence({
        templateId: template.id,
        scheduledDate: at(2026, 6, 1),
      }),
      generateOccurrence({
        templateId: template.id,
        scheduledDate: at(2026, 6, 1),
      }),
    ]);
    expect(results.filter((row) => row.status === "CREATED")).toHaveLength(1);
    expect(results.filter((row) => row.status === "ALREADY_RUN")).toHaveLength(
      2,
    );
    expect(
      await prisma.invoice.count({ where: { companyId: fixture.company.id } }),
    ).toBe(1);
  });

  it("catches up a template that has not run for months, one invoice per period", async () => {
    await makeTemplate();
    const results = await runRecurringInvoices(
      new Date("2026-08-15T00:00:00Z"),
    );
    expect(
      results
        .filter((row) => row.status === "CREATED")
        .map((row) => row.scheduledDate),
    ).toEqual(["2026-06-01", "2026-07-01", "2026-08-01"]);
  });

  it("waits until 06:00 in the company's operating zone", async () => {
    await prisma.company.update({
      where: { id: fixture.company.id },
      data: { operatingTimeZone: "Asia/Manila" },
    });
    await makeTemplate();

    // 21:00 UTC on 31 May is 05:00 on 1 June in Manila — not yet.
    expect(
      await runRecurringInvoices(new Date("2026-05-31T21:00:00Z")),
    ).toEqual([]);
    // An hour later it is 06:00 there.
    const after = await runRecurringInvoices(new Date("2026-05-31T22:00:00Z"));
    expect(after.filter((row) => row.status === "CREATED")).toHaveLength(1);
  });

  it("skips a paused template, and stops at the occurrence limit", async () => {
    const paused = await makeTemplate({ isPaused: true, name: "Paused" });
    expect(
      await runRecurringInvoices(new Date("2026-06-01T00:00:00Z")),
    ).toEqual([]);

    await prisma.recurringInvoiceTemplate.update({
      where: { id: paused.id },
      data: { isPaused: false, occurrenceLimit: 2 },
    });
    const results = await runRecurringInvoices(
      new Date("2026-09-15T00:00:00Z"),
    );
    expect(results.filter((row) => row.status === "CREATED")).toHaveLength(2);
    expect(
      results.some((row) => row.reason === "Occurrence limit reached"),
    ).toBe(true);
    expect(
      await prisma.invoice.count({ where: { companyId: fixture.company.id } }),
    ).toBe(2);
  });

  it("lists what is coming in the next 30 days", async () => {
    await makeTemplate();
    const upcoming = await upcomingOccurrences({
      companyId: fixture.company.id,
      from: at(2026, 6, 1),
      days: 70,
    });
    expect(upcoming.map((row) => iso(row.date))).toEqual([
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
    ]);
    expect(upcoming[0].customerName).toBe("Cebu Retail");
    expect(upcoming[0].total?.toFixed(2)).toBe("25000.00");
  });

  it("keeps one company's templates out of another's run", async () => {
    await makeTemplate();
    const other = await makeCompanyWithChart("Other Co", "PHP");
    const otherCustomer = await makeCustomer(other.company.id);
    await prisma.recurringInvoiceTemplate.create({
      data: {
        companyId: other.company.id,
        customerId: otherCustomer.id,
        name: "Theirs",
        frequency: "MONTHLY",
        dayOfMonth: 1,
        startDate: at(2026, 6, 1),
        nextRunDate: at(2026, 6, 1),
        currency: "PHP",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Retainer",
              quantity: "1",
              rate: "1000.00",
              incomeAccountId: other.code("4000").id,
            },
          ],
        },
      },
    });

    await runRecurringInvoices(new Date("2026-06-01T00:00:00Z"));
    const mine = await prisma.invoice.findMany({
      where: { companyId: fixture.company.id },
    });
    const theirs = await prisma.invoice.findMany({
      where: { companyId: other.company.id },
    });
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    // Different figures, so neither run picked up the other's template.
    expect(mine[0].total.toFixed(2)).toBe("25000.00");
    expect(theirs[0].total.toFixed(2)).toBe("1000.00");
  });
});
