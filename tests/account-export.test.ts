import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  accountFilename,
  buildAccountWorkbook,
  type AccountLedgerRow,
} from "@/lib/exports/account-workbook";

const HEADER_ROW = 5;

const line = (over: Partial<AccountLedgerRow> = {}): AccountLedgerRow => ({
  date: new Date(Date.UTC(2026, 7, 21)),
  entryNumber: 13,
  source: "Work order",
  description: "Consultation for period 072626-081026",
  partyName: "MANILYN GAYTA",
  debit: "9500.00",
  credit: "0.00",
  runningBalance: "9500.00",
  ...over,
});

const build = (over: Partial<Parameters<typeof buildAccountWorkbook>[0]> = {}) =>
  buildAccountWorkbook({
    companyName: "Bookkeeping Point",
    baseCurrency: "PHP",
    account: {
      code: "5000",
      name: "Consultant Fees",
      type: "EXPENSE",
      normalBalance: "DEBIT",
    },
    from: new Date(Date.UTC(2026, 0, 1)),
    to: new Date(Date.UTC(2026, 7, 23)),
    opening: "0.00",
    closing: "9500.00",
    rows: [line()],
    ...over,
  });

async function read(bytes: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return workbook.worksheets[0];
}

/** The row values, 1-indexed by ExcelJS, with the leading hole dropped. */
const cells = (sheet: ExcelJS.Worksheet, row: number) =>
  (sheet.getRow(row).values as unknown[]).slice(1);

/*
 * Column numbers, not the keys the builder writes with: `columns[].key` is an
 * in-memory convenience that xlsx does not store, so a workbook read back has
 * none. Reading by key here would silently return empty cells and prove
 * nothing.
 */
const COL = {
  date: 1,
  entry: 2,
  source: 3,
  description: 4,
  party: 5,
  debit: 6,
  credit: 7,
  balance: 8,
} as const;

describe("the account detail spreadsheet", () => {
  it("says which account, period and company it is, before the numbers", async () => {
    const sheet = await read(await build());

    expect(sheet.getCell("A1").value).toBe("5000 Consultant Fees");
    expect(sheet.getCell("A2").value).toBe("expense · debit-normal · 01/01/2026 to 08/23/2026");
    expect(sheet.getCell("A3").value).toBe("Bookkeeping Point · amounts in PHP");
  });

  it("says 'up to' when the report has no start date", async () => {
    const sheet = await read(await build({ from: null }));
    expect(sheet.getCell("A2").value).toBe("expense · debit-normal · Up to 08/23/2026");
  });

  it("writes the columns in the order the screen shows them", async () => {
    const sheet = await read(await build());
    expect(cells(sheet, HEADER_ROW)).toEqual([
      "Date",
      "Entry",
      "Source",
      "Description",
      "Party",
      "Debit",
      "Credit",
      "Balance",
    ]);
  });

  it("opens with the opening balance when a start date was given", async () => {
    const sheet = await read(await build({ opening: "1250.00" }));
    const row = cells(sheet, HEADER_ROW + 1);
    expect(row[3]).toBe("Opening balance");
    expect(row[7]).toBe(1250);
  });

  it("omits the opening row entirely without a start date", async () => {
    const sheet = await read(await build({ from: null }));
    // Straight into the lines: no start date means the report runs from the
    // beginning of the books, and there is nothing to open with.
    expect(cells(sheet, HEADER_ROW + 1)[3]).toBe("Consultation for period 072626-081026");
  });

  it("writes amounts as numbers, so the column can be summed", async () => {
    const sheet = await read(await build());
    const row = sheet.getRow(HEADER_ROW + 2);
    expect(row.getCell(COL.debit).value).toBe(9500);
    expect(row.getCell(COL.balance).value).toBe(9500);
    expect(typeof row.getCell(COL.debit).value).toBe("number");
    expect(row.getCell(COL.debit).numFmt).toBe("#,##0.00");
  });

  it("writes the date as a real date in mm/dd/yyyy", async () => {
    const sheet = await read(await build());
    const cell = sheet.getRow(HEADER_ROW + 2).getCell(COL.date);
    expect(cell.value).toBeInstanceOf(Date);
    expect(cell.numFmt).toBe("mm/dd/yyyy");
  });

  it("leaves the unused side blank rather than writing a zero", async () => {
    const sheet = await read(await build());
    const row = sheet.getRow(HEADER_ROW + 2);
    // A column of zeroes hides which side each line actually hit.
    expect(row.getCell(COL.credit).value).toBeNull();
    expect(row.getCell(COL.debit).value).toBe(9500);
  });

  it("totals debit and credit with live formulas over the lines only", async () => {
    const sheet = await read(
      await build({
        rows: [line(), line({ entryNumber: 14, debit: "0.00", credit: "500.00" })],
        closing: "9000.00",
      }),
    );
    // Header at 5, opening at 6, lines at 7-8, total at 9.
    const total = sheet.getRow(9);
    expect(total.getCell(COL.description).value).toBe("Closing balance");
    expect(total.getCell(COL.debit).value).toMatchObject({ formula: "SUM(F7:F8)" });
    expect(total.getCell(COL.credit).value).toMatchObject({ formula: "SUM(G7:G8)" });
    // The balance is a running figure, so a SUM of it would be meaningless.
    expect(total.getCell(COL.balance).value).toBe(9000);
  });

  it("still writes a closing row for an account with no postings", async () => {
    const sheet = await read(await build({ rows: [], closing: "0.00" }));
    const total = sheet.getRow(HEADER_ROW + 2);
    expect(total.getCell(COL.description).value).toBe("Closing balance");
    // No lines means no range to sum, so no formula rather than SUM(F7:F6).
    expect(total.getCell(COL.debit).value).toBeNull();
  });

  it("freezes the header so a long ledger stays readable", async () => {
    const sheet = await read(await build());
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: HEADER_ROW });
  });

  it("keeps the sheet name inside what Excel accepts", async () => {
    const sheet = await read(
      await build({
        account: {
          code: "5000",
          name: "Consultant Fees / Retainers [prior] *all*",
          type: "EXPENSE",
          normalBalance: "DEBIT",
        },
      }),
    );
    expect(sheet.name.length).toBeLessThanOrEqual(31);
    expect(sheet.name).not.toMatch(/[:\\/?*[\]]/);
  });
});

describe("accountFilename", () => {
  it("names the file for the account, the company and the day", () => {
    expect(
      accountFilename(
        { code: "5000", name: "Consultant Fees" },
        "Bookkeeping Point",
        new Date(Date.UTC(2026, 7, 23)),
      ),
    ).toBe("5000-Consultant-Fees-Bookkeeping-Point-2026-08-23.xlsx");
  });

  it("keeps the date ISO, because a slash is not a legal filename character", () => {
    const name = accountFilename(
      { code: "1000", name: "Bank" },
      "Co",
      new Date(Date.UTC(2026, 7, 23)),
    );
    expect(name).not.toContain("/");
    expect(name).toContain("2026-08-23");
  });

  it("strips anything a filesystem would object to", () => {
    const name = accountFilename(
      { code: "4000", name: "Sales: retail & wholesale" },
      "A/B Trading",
      new Date(Date.UTC(2026, 7, 23)),
    );
    expect(name).toMatch(/^[\w.-]+$/);
  });
});
