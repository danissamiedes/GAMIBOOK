import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildExpensesWorkbook,
  expensesFilename,
  type ExpenseRow,
} from "@/lib/exports/expenses-workbook";

const row = (over: Partial<ExpenseRow> = {}): ExpenseRow => ({
  date: new Date(Date.UTC(2026, 7, 15)),
  reference: "INV-88",
  vendorName: "Suremix Paint Center",
  description: "Paint for the office",
  amount: "3250.00",
  balanceDue: "0.00",
  currency: "PHP",
  receiptUrl: "https://drive.google.com/file/d/abc/view",
  ...over,
});

async function read(bytes: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return workbook.worksheets[0];
}

describe("the expenses spreadsheet", () => {
  it("writes the columns in the order the screen shows them", async () => {
    const sheet = await read(
      await buildExpensesWorkbook({ kind: "DIRECT", companyName: "Bookkeeping Point", rows: [row()] }),
    );
    const headers = sheet.getRow(1).values as (string | undefined)[];
    expect(headers.slice(1)).toEqual([
      "Date",
      "Reference",
      "Vendor",
      "Description",
      "Amount",
      "Currency",
      "File link",
    ]);
  });

  it("gives bills a Balance column that direct expenses do not have", async () => {
    const sheet = await read(
      await buildExpensesWorkbook({ kind: "BILL", companyName: "Co", rows: [row({ balanceDue: "1200.00" })] }),
    );
    const headers = (sheet.getRow(1).values as (string | undefined)[]).slice(1);
    expect(headers).toContain("Balance");
    expect(sheet.getRow(2).getCell(6).value).toBe(1200);
  });

  it("writes the amount as a number Excel can sum, not text", async () => {
    const sheet = await read(
      await buildExpensesWorkbook({ kind: "DIRECT", companyName: "Co", rows: [row()] }),
    );
    const amount = sheet.getRow(2).getCell(5);
    expect(typeof amount.value).toBe("number");
    expect(amount.value).toBe(3250);
    expect(amount.numFmt).toBe("#,##0.00");
    expect(sheet.getRow(2).getCell(1).numFmt).toBe("mm/dd/yyyy");
    // And a real date, so sorting and filtering work.
    expect(sheet.getRow(2).getCell(1).value).toBeInstanceOf(Date);
  });

  it("makes a good file link clickable and leaves a bad one inert", async () => {
    const sheet = await read(
      await buildExpensesWorkbook({
        kind: "DIRECT",
        companyName: "Co",
        rows: [row(), row({ receiptUrl: "javascript:alert(1)" }), row({ receiptUrl: null })],
      }),
    );
    const good = sheet.getRow(2).getCell(7).value as { hyperlink?: string };
    expect(good.hyperlink).toBe("https://drive.google.com/file/d/abc/view");

    // The same check the screen applies — a spreadsheet must not become the
    // route by which a hostile URL gets clicked.
    expect(sheet.getRow(3).getCell(7).value).toBe("javascript:alert(1)");
    expect((sheet.getRow(3).getCell(7).value as { hyperlink?: string }).hyperlink).toBeUndefined();
    expect(sheet.getRow(4).getCell(7).value).toBe("");
  });

  it("totals the money columns", async () => {
    const sheet = await read(
      await buildExpensesWorkbook({
        kind: "DIRECT",
        companyName: "Co",
        rows: [row(), row({ amount: "750.00" })],
      }),
    );
    const total = sheet.getRow(4);
    expect(total.getCell(4).value).toBe("Total");
    expect((total.getCell(5).value as { formula: string }).formula).toBe("SUM(E2:E3)");
  });

  it("copes with an empty list", async () => {
    const sheet = await read(
      await buildExpensesWorkbook({ kind: "DIRECT", companyName: "Co", rows: [] }),
    );
    expect(sheet.rowCount).toBe(1);
  });

  it("names the file after the list, the company and the day", () => {
    expect(expensesFilename("BILL", "Bookkeeping Point", new Date(Date.UTC(2026, 7, 22)))).toBe(
      "Bills-Bookkeeping-Point-2026-08-22.xlsx",
    );
    expect(expensesFilename("DIRECT", "Levy Brands, LLC", new Date(Date.UTC(2026, 7, 22)))).toBe(
      "Direct-expenses-Levy-Brands-LLC-2026-08-22.xlsx",
    );
  });
});
