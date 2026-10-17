import { beforeEach, describe, expect, it } from "vitest";
import { partyTransactionCount, partyTransactions } from "@/lib/parties/transactions";
import { recordExpense } from "@/lib/payables/expenses";
import { recordBillPayment } from "@/lib/payables/bill-payments";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

let fixture: Fixture;
let vendor: Awaited<ReturnType<typeof prisma.vendor.create>>;

const JULY = new Date("2025-07-10");
const AUGUST = new Date("2025-08-10");

beforeEach(async () => {
  await resetDatabase();
  fixture = await makeCompanyWithChart("KASAGAMI APARTMENTS");
  vendor = await prisma.vendor.create({
    data: {
      companyId: fixture.company.id,
      kind: "REGULAR",
      name: "DAVAO LIGHT",
      defaultCurrency: "PHP",
    },
  });
});

const bill = (amount: string, date = JULY, description = "July electricity") =>
  recordExpense({
    companyId: fixture.company.id,
    kind: "BILL",
    vendorId: vendor.id,
    date,
    dueDate: date,
    currency: "PHP",
    amount,
    expenseAccountId: fixture.code("6100").id,
    description,
    reference: "DL-0001",
  });

const direct = (amount: string, date = JULY, description = "Reconnection fee") =>
  recordExpense({
    companyId: fixture.company.id,
    kind: "DIRECT",
    vendorId: vendor.id,
    date,
    currency: "PHP",
    amount,
    expenseAccountId: fixture.code("6100").id,
    paymentAccountId: fixture.code("1010").id,
    description,
  });

const forVendor = () =>
  partyTransactions({
    companyId: fixture.company.id,
    vendorId: vendor.id,
    vendorKind: "REGULAR",
  });

describe("a party's own transactions (SPEC §6)", () => {
  it("brings the bills, the direct expenses and the payments into one list", async () => {
    const owner = await makeUser("OWNER", fixture.company.id);
    const { expense } = await bill("5000.00", JULY);
    await direct("750.00", AUGUST);
    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: vendor.id,
      date: AUGUST,
      amount: "2000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1010").id,
      applications: [{ expenseId: expense.id, amountApplied: "2000.00" }],
      userId: owner.id,
    });

    const { rows, totals } = await forVendor();

    expect(rows.map((row) => row.label).sort()).toEqual(["Bill", "Direct expense", "Payment"]);
    // Newest first, the way an account is read.
    expect(rows[rows.length - 1].label).toBe("Bill");

    // 5,000 billed plus 750 spent directly.
    expect(totals.spend.toFixed(2)).toBe("5750.00");
    // 2,000 paid against the bill, and the 750 that was paid when recorded.
    expect(totals.paid.toFixed(2)).toBe("2750.00");
    // What is left on the bill.
    expect(totals.outstanding.toFixed(2)).toBe("3000.00");

    const billRow = rows.find((row) => row.label === "Bill");
    expect(billRow?.reference).toBe("DL-0001");
    expect(billRow?.outstanding?.toFixed(2)).toBe("3000.00");
    expect(billRow?.href).toContain("/expenses?tab=bill");

    const paymentRow = rows.find((row) => row.label === "Payment");
    expect(paymentRow?.outstanding).toBeNull();
    expect(paymentRow?.amount.toFixed(2)).toBe("2000.00");
  });

  it("counts a work order, and links it to its own page", async () => {
    const consultant = await prisma.vendor.create({
      data: {
        companyId: fixture.company.id,
        kind: "CONSULTANT",
        name: "DANNY",
        defaultCurrency: "PHP",
      },
    });
    const order = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        workOrderNumber: "WO-1001",
        issueDate: JULY,
        dueDate: AUGUST,
        currency: "PHP",
        status: "APPROVED",
        memo: "Framing",
        total: "12000.00",
        baseTotal: "12000.00",
      },
    });

    const { rows, totals } = await partyTransactions({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      vendorKind: "CONSULTANT",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Work order", reference: "WO-1001" });
    expect(rows[0].href).toBe(`/work-orders/${order.id}`);
    expect(totals.spend.toFixed(2)).toBe("12000.00");
    expect(totals.outstanding.toFixed(2)).toBe("12000.00");
  });

  it("leaves a draft work order out of the totals, and shows it all the same", async () => {
    const consultant = await prisma.vendor.create({
      data: {
        companyId: fixture.company.id,
        kind: "CONSULTANT",
        name: "RODRING",
        defaultCurrency: "PHP",
      },
    });
    await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: JULY,
        dueDate: AUGUST,
        currency: "PHP",
        status: "DRAFT",
        total: "4000.00",
        baseTotal: "4000.00",
      },
    });

    const { rows, totals } = await partyTransactions({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      vendorKind: "CONSULTANT",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Draft");
    // Nothing has posted for a draft, so nothing is owed on it.
    expect(totals.spend.toFixed(2)).toBe("0.00");
    expect(totals.outstanding.toFixed(2)).toBe("0.00");
  });

  it("shows a foreign-currency bill in its own currency and totals in base", async () => {
    await recordExpense({
      companyId: fixture.company.id,
      kind: "BILL",
      vendorId: vendor.id,
      date: JULY,
      dueDate: AUGUST,
      currency: "USD",
      fxRate: "56.00",
      amount: "100.00",
      expenseAccountId: fixture.code("6100").id,
      description: "Imported meter",
    });

    const { rows, totals } = await forVendor();
    expect(rows[0].currency).toBe("USD");
    expect(rows[0].amount.toFixed(2)).toBe("100.00");
    expect(rows[0].baseAmount.toFixed(2)).toBe("5600.00");
    expect(totals.spend.toFixed(2)).toBe("5600.00");
  });

  it("shows another company's vendor nothing", async () => {
    await bill("5000.00");
    const other = await makeCompanyWithChart("THE PICKLE FARM");

    const { rows, totals } = await partyTransactions({
      companyId: other.company.id,
      vendorId: vendor.id,
      vendorKind: "REGULAR",
    });
    expect(rows).toEqual([]);
    expect(totals.spend.toFixed(2)).toBe("0.00");
  });

  it("counts without reading, for the tab's label", async () => {
    await bill("5000.00", JULY);
    await direct("750.00", AUGUST);
    expect(await partyTransactionCount(fixture.company.id, vendor.id)).toBe(2);
  });
});
