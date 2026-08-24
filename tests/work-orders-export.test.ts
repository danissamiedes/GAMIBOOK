import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildWorkOrdersWorkbook,
  workOrderFilterSummary,
  workOrdersFilename,
  type WorkOrderRow,
} from "@/lib/exports/work-orders-workbook";

const HEADER_ROW = 4;

/*
 * Column numbers, not the keys the builder writes with: `columns[].key` is an
 * in-memory convenience that xlsx does not store, so a workbook read back has
 * none. Reading by key here would return empty cells and prove nothing.
 */
const COL = {
  number: 1,
  consultant: 2,
  date: 3,
  due: 4,
  lines: 5,
  status: 6,
  total: 7,
  balance: 8,
  currency: 9,
} as const;

const row = (over: Partial<WorkOrderRow> = {}): WorkOrderRow => ({
  number: "WO1007",
  consultantName: "JOCEL MALO",
  issueDate: new Date(Date.UTC(2026, 7, 22)),
  dueDate: new Date(Date.UTC(2026, 8, 6)),
  lineCount: 2,
  status: "APPROVED",
  total: "10000.00",
  balanceDue: "10000.00",
  currency: "PHP",
  ...over,
});

const build = (over: Partial<Parameters<typeof buildWorkOrdersWorkbook>[0]> = {}) =>
  buildWorkOrdersWorkbook({
    companyName: "Bookkeeping Point",
    filterSummary: "all work orders",
    rows: [row()],
    ...over,
  });

async function read(bytes: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return workbook.worksheets[0];
}

const cells = (sheet: ExcelJS.Worksheet, n: number) =>
  (sheet.getRow(n).values as unknown[]).slice(1);

describe("the work orders spreadsheet", () => {
  it("says whose books and which filters produced it", async () => {
    const sheet = await read(await build({ filterSummary: "approved · 08/01/2026 to 08/31/2026" }));
    expect(sheet.getCell("A1").value).toBe("Work orders");
    // Two files of the same list under different filters look identical at a
    // glance, and only one is the one someone meant to send.
    expect(sheet.getCell("A2").value).toBe(
      "Bookkeeping Point · approved · 08/01/2026 to 08/31/2026",
    );
  });

  it("writes the columns in the order the screen shows them", async () => {
    const sheet = await read(await build());
    expect(cells(sheet, HEADER_ROW)).toEqual([
      "Number",
      "Consultant",
      "Date",
      "Due",
      "Lines",
      "Status",
      "Total",
      "Balance",
      "Currency",
    ]);
  });

  it("writes amounts as numbers, so the columns can be summed", async () => {
    const sheet = await read(await build());
    const line = sheet.getRow(HEADER_ROW + 1);
    expect(line.getCell(COL.total).value).toBe(10000);
    expect(line.getCell(COL.balance).value).toBe(10000);
    expect(line.getCell(COL.total).numFmt).toBe("#,##0.00");
  });

  it("writes both dates as real dates in mm/dd/yyyy", async () => {
    const sheet = await read(await build());
    const line = sheet.getRow(HEADER_ROW + 1);
    expect(line.getCell(COL.date).value).toBeInstanceOf(Date);
    expect(line.getCell(COL.due).value).toBeInstanceOf(Date);
    expect(line.getCell(COL.date).numFmt).toBe("mm/dd/yyyy");
  });

  it("says 'draft' where the screen does, rather than leaving a blank", async () => {
    const sheet = await read(await build({ rows: [row({ number: null })] }));
    expect(sheet.getRow(HEADER_ROW + 1).getCell(COL.number).value).toBe("draft");
  });

  it("writes the status the way the screen reads it", async () => {
    const sheet = await read(await build({ rows: [row({ status: "PARTIALLY_PAID" })] }));
    expect(sheet.getRow(HEADER_ROW + 1).getCell(COL.status).value).toBe("partially paid");
  });

  it("totals with live formulas over the lines only", async () => {
    const sheet = await read(
      await build({ rows: [row(), row({ number: "WO1008", total: "9000.00" })] }),
    );
    const total = sheet.getRow(HEADER_ROW + 3);
    expect(total.getCell(COL.consultant).value).toBe("Total");
    expect(total.getCell(COL.total).value).toMatchObject({ formula: "SUM(G5:G6)" });
    expect(total.getCell(COL.balance).value).toMatchObject({ formula: "SUM(H5:H6)" });
  });

  it("writes no total row at all for an empty list", async () => {
    const sheet = await read(await build({ rows: [] }));
    // SUM(G5:G4) is not a total, it is a broken formula.
    expect(sheet.rowCount).toBe(HEADER_ROW);
  });

  it("warns when the total adds unlike currencies", async () => {
    const sheet = await read(
      await build({ rows: [row(), row({ number: "WO1008", currency: "USD" })] }),
    );
    const note = String(sheet.getRow(sheet.rowCount).getCell(COL.consultant).value);
    expect(note).toMatch(/Mixed currencies \(PHP, USD\)/);
  });

  it("says nothing about currency when there is only one", async () => {
    const sheet = await read(await build({ rows: [row(), row({ number: "WO1008" })] }));
    expect(String(sheet.getRow(sheet.rowCount).getCell(COL.consultant).value)).toBe("Total");
  });

  it("freezes the header so a long list stays readable", async () => {
    const sheet = await read(await build());
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: HEADER_ROW });
  });
});

describe("workOrderFilterSummary", () => {
  it("says so plainly when nothing is filtered", () => {
    expect(workOrderFilterSummary({})).toBe("all work orders");
  });

  it("names every filter that is on", () => {
    expect(
      workOrderFilterSummary({
        status: "PARTIALLY_PAID",
        consultantName: "Jocel Malo",
        from: new Date(Date.UTC(2026, 7, 1)),
        to: new Date(Date.UTC(2026, 7, 31)),
      }),
    ).toBe("partially paid · Jocel Malo · 08/01/2026 to 08/31/2026");
  });

  it("handles a one-sided range", () => {
    expect(workOrderFilterSummary({ from: new Date(Date.UTC(2026, 7, 1)) })).toBe(
      "from 08/01/2026",
    );
    expect(workOrderFilterSummary({ to: new Date(Date.UTC(2026, 7, 31)) })).toBe(
      "up to 08/31/2026",
    );
  });

  it("treats ALL as no status filter", () => {
    expect(workOrderFilterSummary({ status: "ALL" })).toBe("all work orders");
  });
});

describe("workOrdersFilename", () => {
  it("names the file for the company and the day", () => {
    expect(workOrdersFilename("Bookkeeping Point", new Date(Date.UTC(2026, 7, 23)))).toBe(
      "Work-orders-Bookkeeping-Point-2026-08-23.xlsx",
    );
  });

  it("keeps the date ISO, because a slash is not a legal filename character", () => {
    const name = workOrdersFilename("A/B Trading", new Date(Date.UTC(2026, 7, 23)));
    expect(name).not.toContain("/");
    expect(name).toMatch(/^[\w.-]+$/);
  });
});
