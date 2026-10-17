import { beforeEach, describe, expect, it } from "vitest";
import { partyTransactionCount, partyTransactions } from "@/lib/parties/transactions";
import {
  buildPartyTransactionsWorkbook,
  partyTransactionsFilename,
} from "@/lib/exports/party-transactions-workbook";
import { recordExpense } from "@/lib/payables/expenses";
import { recordBillPayment } from "@/lib/payables/bill-payments";
import { recordVendorCredit } from "@/lib/payables/vendor-credits";
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
    reference: "REF-0013",
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
    // The reference opens the document itself, not the list it is on.
    expect(billRow?.href).toBe(`/expenses/${expense.id}`);

    const paymentRow = rows.find((row) => row.label === "Payment");
    expect(paymentRow?.outstanding).toBeNull();
    expect(paymentRow?.amount.toFixed(2)).toBe("2000.00");
  });

  it("counts a work order that is itself payable, and links it to its own page", async () => {
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
        // Raised under the earlier flow, so approving it put it in A/P.
        postedOnApproval: true,
        memo: "Framing",
        total: "12000.00",
        baseTotal: "12000.00",
      },
    });

    const { rows, totals } = await partyTransactions({
      companyId: fixture.company.id,
      vendorId: consultant.id,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Work order", reference: "WO-1001" });
    expect(rows[0].href).toBe(`/work-orders/${order.id}`);
    expect(totals.spend.toFixed(2)).toBe("12000.00");
    expect(totals.outstanding.toFixed(2)).toBe("12000.00");
  });

  it("shows an approved work order that has not been billed, and counts nothing for it", async () => {
    const consultant = await prisma.vendor.create({
      data: {
        companyId: fixture.company.id,
        kind: "CONSULTANT",
        name: "RITCHIE",
        defaultCurrency: "PHP",
      },
    });
    await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        workOrderNumber: "WO-1002",
        issueDate: JULY,
        dueDate: AUGUST,
        currency: "PHP",
        status: "APPROVED",
        memo: "Plumbing",
        total: "9000.00",
        baseTotal: "9000.00",
      },
    });

    const { rows, totals } = await partyTransactions({
      companyId: fixture.company.id,
      vendorId: consultant.id,
    });

    // It is part of the account's story, so it is listed — but nothing has
    // posted for it, so counting it would show the consultant owed twice
    // once the bill arrives.
    expect(rows).toHaveLength(1);
    expect(rows[0].outstanding).toBeNull();
    expect(totals.spend.toFixed(2)).toBe("0.00");
    expect(totals.outstanding.toFixed(2)).toBe("0.00");
  });

  it("nets a credit note off what the party has cost and what is owed", async () => {
    await recordExpense({
      companyId: fixture.company.id,
      kind: "BILL",
      vendorId: vendor.id,
      date: JULY,
      dueDate: AUGUST,
      currency: "PHP",
      amount: "10000.00",
      expenseAccountId: fixture.code("6100").id,
      description: "Power",
      reference: "DL-9",
    });
    const { credit } = await recordVendorCredit({
      companyId: fixture.company.id,
      vendorId: vendor.id,
      date: JULY,
      reference: "CN-9",
      currency: "PHP",
      amount: "2500.00",
      expenseAccountId: fixture.code("6100").id,
      memo: "Overbilled",
    });

    const { rows, totals } = await partyTransactions({
      companyId: fixture.company.id,
      vendorId: vendor.id,
    });

    const creditRow = rows.find((row) => row.kind === "CREDIT");
    expect(creditRow).toMatchObject({ label: "Credit note", reference: "CN-9" });
    expect(creditRow?.href).toBe(`/vendor-credits/${credit.id}`);
    // Listed positive; the sign is put on at the point of display.
    expect(creditRow?.amount.toFixed(2)).toBe("2500.00");
    expect(totals.spend.toFixed(2)).toBe("7500.00");
    expect(totals.outstanding.toFixed(2)).toBe("7500.00");
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
      reference: "REF-0014",
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
    });
    expect(rows).toEqual([]);
    expect(totals.spend.toFixed(2)).toBe("0.00");
  });

  it("bounds the rows and the totals by the period", async () => {
    await bill("5000.00", JULY, "July electricity");
    await bill("4000.00", AUGUST, "August electricity");

    const july = await partyTransactions({
      companyId: fixture.company.id,
      vendorId: vendor.id,
      from: new Date("2025-07-01"),
      to: new Date("2025-07-31"),
    });
    expect(july.rows.map((row) => row.description)).toEqual(["July electricity"]);
    // The three figures at the top must be the figures the rows add up to.
    expect(july.totals.spend.toFixed(2)).toBe("5000.00");
    expect(july.totals.outstanding.toFixed(2)).toBe("5000.00");

    // One end on its own is a half-open period, not a filter that is ignored.
    const fromAugust = await partyTransactions({
      companyId: fixture.company.id,
      vendorId: vendor.id,
      from: new Date("2025-08-01"),
    });
    expect(fromAugust.rows.map((row) => row.description)).toEqual(["August electricity"]);

    // And the unfiltered view still shows everything.
    const all = await forVendor();
    expect(all.rows).toHaveLength(2);
    expect(all.totals.spend.toFixed(2)).toBe("9000.00");
  });

  it("writes a spreadsheet of the period, totalled in base currency", async () => {
    const owner = await makeUser("OWNER", fixture.company.id);
    const { expense } = await bill("5000.00", JULY);
    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: vendor.id,
      date: JULY,
      amount: "2000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1010").id,
      applications: [{ expenseId: expense.id, amountApplied: "2000.00" }],
      userId: owner.id,
    });

    const { rows, totals } = await forVendor();
    const bytes = await buildPartyTransactionsWorkbook({
      companyName: "KASAGAMI APARTMENTS",
      baseCurrency: "PHP",
      party: { name: "DAVAO LIGHT", kind: "Vendor" },
      from: new Date("2025-07-01"),
      to: new Date("2025-07-31"),
      rows,
      totals,
    });

    const ExcelJS = (await import("exceljs")).default;
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as unknown as ArrayBuffer);
    const sheet = book.getWorksheet("DAVAO LIGHT")!;
    expect(sheet.getCell("A1").value).toBe("DAVAO LIGHT");
    expect(String(sheet.getCell("A3").value)).toMatch(/07\/01\/2025/);
    expect(sheet.getRow(6).getCell(1).value).toBe("Date");

    // Amounts are numbers — a column nobody can sum is not much of an export.
    const amounts = [sheet.getRow(7).getCell(5).value, sheet.getRow(8).getCell(5).value];
    expect(amounts.every((value) => typeof value === "number")).toBe(true);
    // The payment reads as money going the other way.
    expect(amounts).toContain(-2000);
    expect(amounts).toContain(5000);

    // Only the base-currency column is totalled.
    const totalRow = sheet.getRow(9);
    expect(String(totalRow.getCell(4).value)).toBe("Total (PHP)");
    expect((totalRow.getCell(7).value as { formula: string }).formula).toBe("SUM(G7:G8)");
  });

  it("names the file after the party and the day", () => {
    expect(partyTransactionsFilename("DAVAO LIGHT", new Date("2026-10-17"))).toBe(
      "Transactions-DAVAO-LIGHT-2026-10-17.xlsx",
    );
  });

  it("counts without reading, for the tab's label", async () => {
    await bill("5000.00", JULY);
    await direct("750.00", AUGUST);
    expect(await partyTransactionCount(fixture.company.id, vendor.id)).toBe(2);
  });
});
