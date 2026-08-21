import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { postJournalEntry } from "@/lib/ledger/post";
import { issueInvoice } from "@/lib/invoices/service";
import { approveWorkOrder } from "@/lib/payables/work-orders";
import { withCompanyScope } from "@/lib/company-scope";
import { dashboard, trailingMonths } from "@/lib/reports/dashboard";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  makeUser,
  makeVendor,
  prisma,
  resetDatabase,
} from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

/**
 * SPEC §12 — the dashboard. Two things are being asserted: the figures agree
 * with the reports they are summarising, and a tile a user's sections do not
 * cover is absent rather than zeroed. A zero would be a claim about the
 * business; `null` is the honest answer to "you may not see this".
 */
describe("dashboard", () => {
  let fixture: Fixture;
  const asOf = new Date(Date.UTC(2026, 5, 30)); // 30 June 2026

  const ownerScope = () =>
    makeUser("OWNER", fixture.company.id).then((user) =>
      withCompanyScope(user.id, fixture.company.id),
    );

  const post = (
    date: string,
    lines: { code: string; debit?: string; credit?: string }[],
  ) =>
    postJournalEntry({
      companyId: fixture.company.id,
      date: new Date(`${date}T00:00:00Z`),
      memo: "",
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
    fixture = await makeCompanyWithChart("Dashboard Co", "PHP");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("counts trailing months inclusive of the month containing asOf", () => {
    const months = trailingMonths(asOf, 6);
    expect(months).toHaveLength(6);
    expect(months[0].key).toBe("2026-01");
    expect(months[5].key).toBe("2026-06");
    expect(months[5].label).toBe("Jun 26");
    // December of the previous year, not month -1 of this one.
    expect(trailingMonths(new Date(Date.UTC(2026, 0, 15)), 2)[0].key).toBe(
      "2025-12",
    );
  });

  it("totals cash from the ledger and splits income and expenses by month", async () => {
    await post("2026-04-10", [
      { code: "1000", debit: "50000.00" },
      { code: "4000", credit: "50000.00" },
    ]);
    await post("2026-05-12", [
      { code: "6000", debit: "12000.00" },
      { code: "1000", credit: "12000.00" },
    ]);

    const view = await dashboard({
      scope: await ownerScope(),
      asOf,
      baseCurrency: "PHP",
      now: asOf,
    });

    expect(view.cash?.total.toFixed(2)).toBe("38000.00");
    expect(view.cash?.accounts.some((account) => account.code === "1000")).toBe(
      true,
    );

    const april = view.trend?.find((month) => month.key === "2026-04");
    const may = view.trend?.find((month) => month.key === "2026-05");
    expect(april?.income.toFixed(2)).toBe("50000.00");
    expect(april?.expenses.toFixed(2)).toBe("0.00");
    expect(may?.expenses.toFixed(2)).toBe("12000.00");
    expect(may?.net.toFixed(2)).toBe("-12000.00");

    // A month with no postings is a zero row, not a missing one — the chart
    // would otherwise silently compress its own x-axis.
    expect(view.trend).toHaveLength(6);
    expect(
      view.trend?.find((month) => month.key === "2026-02")?.income.toFixed(2),
    ).toBe("0.00");
  });

  it("reports receivables and payables with their overdue portions", async () => {
    const customer = await makeCustomer(fixture.company.id);
    const overdue = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: new Date(Date.UTC(2026, 2, 1)), // due 31 March, overdue at 30 June
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "30000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: overdue.id,
      role: "OWNER",
    });

    const current = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: new Date(Date.UTC(2026, 5, 20)), // due 20 July, not yet due
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "10000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: current.id,
      role: "OWNER",
    });

    const consultant = await makeVendor(fixture.company.id, "CONSULTANT");
    const workOrder = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: new Date(Date.UTC(2026, 3, 1)),
        dueDate: new Date(Date.UTC(2026, 3, 30)), // overdue at 30 June
        currency: "PHP",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Fieldwork",
              quantity: "1",
              rate: "8000.00",
              amount: "8000.00",
              accountId: fixture.code("6000").id,
            },
          ],
        },
      },
    });
    await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
      role: "OWNER",
    });

    const view = await dashboard({
      scope: await ownerScope(),
      asOf,
      baseCurrency: "PHP",
      now: asOf,
    });

    expect(view.receivables?.total.toFixed(2)).toBe("40000.00");
    expect(view.receivables?.overdue.toFixed(2)).toBe("30000.00");
    expect(view.receivables?.openCount).toBe(2);
    expect(view.receivables?.oldestDaysOverdue).toBe(91);

    expect(view.payables?.total.toFixed(2)).toBe("8000.00");
    expect(view.payables?.overdue.toFixed(2)).toBe("8000.00");
    expect(view.payables?.kinds).toEqual(["CONSULTANT", "REGULAR"]);
  });

  it("lists who is clocked in, and for how long", async () => {
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT", {
      name: "Abigail",
    });
    await prisma.timeEntry.create({
      data: {
        companyId: fixture.company.id,
        consultantId: consultant.id,
        clockInAt: new Date(Date.UTC(2026, 5, 30, 1, 0)),
      },
    });
    // A closed entry is not "currently clocked in".
    await prisma.timeEntry.create({
      data: {
        companyId: fixture.company.id,
        consultantId: consultant.id,
        clockInAt: new Date(Date.UTC(2026, 5, 29, 1, 0)),
        clockOutAt: new Date(Date.UTC(2026, 5, 29, 9, 0)),
        durationMinutes: 480,
      },
    });

    const view = await dashboard({
      scope: await ownerScope(),
      asOf,
      baseCurrency: "PHP",
      now: new Date(Date.UTC(2026, 5, 30, 4, 30)),
    });

    expect(view.clockedIn).toHaveLength(1);
    expect(view.clockedIn?.[0].name).toBe("Abigail");
    expect(view.clockedIn?.[0].minutes).toBe(210);
  });

  it("withholds a tile the user's sections do not cover", async () => {
    const customer = await makeCustomer(fixture.company.id);
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "5000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      role: "OWNER",
    });

    const vendorsOnly = await makeUser(
      "BOOKKEEPER",
      fixture.company.id,
      undefined,
      ["VENDORS"],
    );
    const view = await dashboard({
      scope: await withCompanyScope(vendorsOnly.id, fixture.company.id),
      asOf,
      baseCurrency: "PHP",
      now: asOf,
    });

    // The whole point of §2.1: not a zero, an absence.
    expect(view.receivables).toBeNull();
    expect(view.cash).toBeNull();
    expect(view.trend).toBeNull();
    expect(view.clockedIn).toBeNull();
    expect(view.payables?.kinds).toEqual(["REGULAR"]);
    expect(view.empty).toBe(false);
  });

  it("says so when a user's sections produce nothing at all", async () => {
    const noSections = await makeUser(
      "BOOKKEEPER",
      fixture.company.id,
      undefined,
      [],
    );
    const view = await dashboard({
      scope: await withCompanyScope(noSections.id, fixture.company.id),
      asOf,
      baseCurrency: "PHP",
      now: asOf,
    });
    expect(view.empty).toBe(true);
  });
});
