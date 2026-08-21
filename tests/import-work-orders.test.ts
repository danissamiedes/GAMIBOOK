import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  buildRejectWorkbook,
  buildTemplateWorkbook,
  commitImport,
  rollbackImport,
  stageImport,
} from "@/lib/imports/work-orders";
import { parseSheetDate } from "@/lib/imports/validate";
import { approveWorkOrder } from "@/lib/payables/work-orders";
import { trialBalance } from "@/lib/ledger/reports";
import { resetStorage } from "@/lib/storage";
import { makeCompanyWithChart, makeVendor, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;
type SheetRow = [string, string, number | string, string, string, number | string, number | string, (number | string)?];

/** Build a workbook shaped exactly like the user's real sheet. */
async function workbook(rows: SheetRow[]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Sheet1");
  sheet.addRow([
    "Work Order Date",
    "Consultant Name",
    "Line No.",
    "Description",
    "Account",
    "Quantity",
    "Rate",
    "Amount",
  ]);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** The four rows from the user's screenshot, plus Chareze's second line. */
const REAL_SHEET: SheetRow[] = [
  ["8/15/2026", "Abigail Bautista", 1, "Consultation for period 072626-081026", "Consultant Fees", 0.5, 100000, 50000],
  ["8/15/2026", "John Rex Meraveles", 1, "Consultation for period 072626-081026", "Consultant Fees", 0.5, 16000, 8000],
  ["8/15/2026", "John Rex Meraveles", 2, "Cash Advances", "Advances to Consultants", 1, -3000, -3000],
  ["8/15/2026", "Chareze Valencia", 1, "Consultation for period 072626-081026", "Consultant Fees", 0.5, 50000, 25000],
  ["8/15/2026", "Chareze Valencia", 2, "Reimburse supplies", "Supplies Expense", 1, 1500, 1500],
];

describe("work order import (SPEC §8.3)", () => {
  let fixture: Fixture;
  let root: string;

  beforeEach(async () => {
    await resetDatabase();
    root = mkdtempSync(path.join(tmpdir(), "ledger-import-"));
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_PATH = root;
    resetStorage();

    fixture = await makeCompanyWithChart("Import Co", "PHP");
    for (const name of ["Abigail Bautista", "John Rex Meraveles", "Chareze Valencia"]) {
      await makeVendor(fixture.company.id, "CONSULTANT", { name });
    }
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    await resetDatabase();
    await prisma.$disconnect();
  });

  const stage = async (rows: SheetRow[], fileName = "work-orders.xlsx") =>
    stageImport({
      companyId: fixture.company.id,
      fileName,
      bytes: await workbook(rows),
    });

  it("groups a Line No. run into one multi-line work order", async () => {
    const staged = await stage(REAL_SHEET);

    expect(staged.validation.counts.error).toBe(0);
    // Five rows, three work orders: John Rex and Chareze each have two lines.
    expect(staged.validation.workOrders).toHaveLength(3);

    const johnRex = staged.validation.workOrders.find((w) => w.consultantName === "John Rex Meraveles")!;
    expect(johnRex.lines).toHaveLength(2);
    expect(johnRex.total.toFixed(2)).toBe("5000.00");

    const chareze = staged.validation.workOrders.find((w) => w.consultantName === "Chareze Valencia")!;
    expect(chareze.lines.map((line) => line.description)).toEqual([
      "Consultation for period 072626-081026",
      "Reimburse supplies",
    ]);
  });

  it("creates DRAFT work orders and posts nothing", async () => {
    const staged = await stage(REAL_SHEET);
    const result = await commitImport({ companyId: fixture.company.id, batchId: staged.batchId });

    expect(result.workOrderCount).toBe(3);

    const workOrders = await prisma.workOrder.findMany({
      where: { companyId: fixture.company.id },
      include: { lines: true, vendor: true },
    });
    expect(workOrders).toHaveLength(3);
    for (const workOrder of workOrders) {
      expect(workOrder.status).toBe("DRAFT");
      expect(workOrder.workOrderNumber).toBeNull();
      expect(workOrder.importBatchId).toBe(staged.batchId);
    }

    // Nothing has touched the ledger.
    expect(await prisma.journalEntry.count({ where: { companyId: fixture.company.id } })).toBe(0);

    // Each line kept the account its row named.
    const johnRex = workOrders.find((w) => w.vendor.name === "John Rex Meraveles")!;
    const advance = johnRex.lines.find((line) => line.description === "Cash Advances")!;
    expect(advance.accountId).toBe(fixture.code("1200").id);
    expect(advance.amount.toFixed(2)).toBe("-3000.00");
  });

  it("numbers from WO1001 only when the imported drafts are approved", async () => {
    const staged = await stage(REAL_SHEET);
    await commitImport({ companyId: fixture.company.id, batchId: staged.batchId });

    const drafts = await prisma.workOrder.findMany({
      where: { companyId: fixture.company.id },
      orderBy: { createdAt: "asc" },
    });
    const approved = [];
    for (const draft of drafts) {
      const result = await approveWorkOrder({
        companyId: fixture.company.id,
        workOrderId: draft.id,
      });
      approved.push(result.workOrder.workOrderNumber);
    }

    expect(approved).toEqual(["WO1001", "WO1002", "WO1003"]);
    const tb = await trialBalance({
      companyId: fixture.company.id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(tb.balanced).toBe(true);
  });

  it("reports bad rows without blocking the good ones", async () => {
    const staged = await stage([
      ...REAL_SHEET,
      ["8/15/2026", "Nobody At All", 1, "Work", "Consultant Fees", 1, 1000, 1000],
      ["8/15/2026", "Abigail Bautista", 1, "Work", "No Such Account", 1, 1000, 1000],
      ["not a date", "Abigail Bautista", 1, "Work", "Consultant Fees", 1, 1000, 1000],
      ["8/15/2026", "Abigail Bautista", 1, "Work", "Consultant Fees", "many", 1000, 1000],
    ]);

    expect(staged.validation.counts.error).toBe(4);
    expect(staged.validation.counts.valid).toBe(5);

    const messages = staged.validation.rows.flatMap((row) => row.issues.map((issue) => issue.message));
    expect(messages.some((message) => /No consultant matches "Nobody At All"/.test(message))).toBe(true);
    expect(messages.some((message) => /No account matches "No Such Account"/.test(message))).toBe(true);
    expect(messages.some((message) => /Date could not be read/.test(message))).toBe(true);
    expect(messages.some((message) => /Quantity is not a number/.test(message))).toBe(true);

    const result = await commitImport({ companyId: fixture.company.id, batchId: staged.batchId });
    expect(result.workOrderCount).toBe(3);
  });

  it("rejects a stray continuation line", async () => {
    const staged = await stage([
      ["8/15/2026", "Abigail Bautista", 2, "Orphan line", "Consultant Fees", 1, 1000, 1000],
    ]);
    const messages = staged.validation.rows.flatMap((row) => row.issues.map((issue) => issue.message));
    expect(messages.some((message) => /no line 1 before it/.test(message))).toBe(true);
    expect(staged.validation.workOrders).toHaveLength(0);
  });

  it("rejects a duplicated line number, and a group that nets to nothing", async () => {
    const duplicated = await stage([
      ["8/15/2026", "Abigail Bautista", 1, "A", "Consultant Fees", 1, 1000, 1000],
      ["8/15/2026", "Abigail Bautista", 2, "B", "Consultant Fees", 1, 1000, 1000],
      ["8/15/2026", "Abigail Bautista", 2, "C", "Consultant Fees", 1, 1000, 1000],
    ]);
    expect(
      duplicated.validation.rows
        .flatMap((row) => row.issues.map((issue) => issue.message))
        .some((message) => /appears twice/.test(message)),
    ).toBe(true);

    const swallowed = await stage([
      ["8/15/2026", "Abigail Bautista", 1, "Work", "Consultant Fees", 1, 1000, 1000],
      ["8/15/2026", "Abigail Bautista", 2, "Cash Advances", "Advances to Consultants", 1, -1500, -1500],
    ]);
    expect(
      swallowed.validation.rows
        .flatMap((row) => row.issues.map((issue) => issue.message))
        .some((message) => /nets to -500.00/.test(message)),
    ).toBe(true);
  });

  it("checks a stated Amount rather than trusting it", async () => {
    const staged = await stage([
      ["8/15/2026", "Abigail Bautista", 1, "Work", "Consultant Fees", 2, 1000, 9999],
    ]);
    expect(
      staged.validation.rows[0].issues.some((issue) => /does not match quantity × rate/.test(issue.message)),
    ).toBe(true);
  });

  it("notices a deduction coded to an expense account", async () => {
    // Legitimate, but it reduces reported expense — worth saying out loud.
    const staged = await stage([
      ["8/15/2026", "Abigail Bautista", 1, "Work", "Consultant Fees", 1, 16000, 16000],
      ["8/15/2026", "Abigail Bautista", 2, "Cash Advances", "Consultant Fees", 1, -3000, -3000],
    ]);
    const notices = staged.validation.rows.flatMap((row) =>
      row.issues.filter((issue) => issue.severity === "notice"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toMatch(/advances account/);
    // A notice does not block the row.
    expect(staged.validation.counts.error).toBe(0);
  });

  it("maps an unknown spelling once and remembers it", async () => {
    const staged = await stage([
      ["8/15/2026", "A. Bautista", 1, "Work", "Consultant Fees", 1, 1000, 1000],
    ]);
    expect(staged.validation.counts.error).toBe(1);

    const abigail = await prisma.vendor.findFirstOrThrow({
      where: { companyId: fixture.company.id, name: "Abigail Bautista" },
    });
    await commitImport({
      companyId: fixture.company.id,
      batchId: staged.batchId,
      consultantOverrides: { "a. bautista": abigail.id },
    });

    const refreshed = await prisma.vendor.findUniqueOrThrow({ where: { id: abigail.id } });
    expect(refreshed.importAliases).toContain("a. bautista");

    // The next sheet with that spelling matches without being mapped again.
    const second = await stage([
      ["8/16/2026", "A. Bautista", 1, "More work", "Consultant Fees", 1, 2000, 2000],
    ]);
    expect(second.validation.counts.error).toBe(0);
  });

  it("warns when the same file is imported twice", async () => {
    const bytes = await workbook(REAL_SHEET);
    const first = await stageImport({
      companyId: fixture.company.id,
      fileName: "august.xlsx",
      bytes,
    });
    expect(first.duplicateOf).toBeNull();
    await commitImport({ companyId: fixture.company.id, batchId: first.batchId });

    const second = await stageImport({
      companyId: fixture.company.id,
      fileName: "august.xlsx",
      bytes,
    });
    expect(second.duplicateOf).not.toBeNull();
    expect(second.duplicateOf?.createdCount).toBe(3);
    // Warned, not blocked: a corrected re-run is legitimate.
    const result = await commitImport({ companyId: fixture.company.id, batchId: second.batchId });
    expect(result.workOrderCount).toBe(3);
  });

  it("rolls a batch back while its drafts are untouched, and refuses afterwards", async () => {
    const staged = await stage(REAL_SHEET);
    await commitImport({ companyId: fixture.company.id, batchId: staged.batchId });
    expect(await prisma.workOrder.count()).toBe(3);

    const rolledBack = await rollbackImport({
      companyId: fixture.company.id,
      batchId: staged.batchId,
    });
    expect(rolledBack.removed).toBe(3);
    expect(await prisma.workOrder.count()).toBe(0);

    // Import again and approve one: rollback must now refuse.
    const again = await stage(REAL_SHEET, "again.xlsx");
    await commitImport({ companyId: fixture.company.id, batchId: again.batchId });
    const first = await prisma.workOrder.findFirstOrThrow({
      where: { companyId: fixture.company.id },
    });
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: first.id });

    await expect(
      rollbackImport({ companyId: fixture.company.id, batchId: again.batchId }),
    ).rejects.toThrow(/approved or emailed/);
  });

  it("refuses a sheet missing a required column", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Sheet1");
    sheet.addRow(["Work Order Date", "Consultant Name", "Description", "Quantity", "Rate"]);
    sheet.addRow(["8/15/2026", "Abigail Bautista", "Work", 1, 100]);

    await expect(
      stageImport({
        companyId: fixture.company.id,
        fileName: "bad.xlsx",
        bytes: Buffer.from(await book.xlsx.writeBuffer()),
      }),
    ).rejects.toThrow(/missing required columns: Line No\., Account/);
  });

  it("refuses the old .xls format with an actionable message", async () => {
    await expect(
      stageImport({
        companyId: fixture.company.id,
        fileName: "old.xls",
        bytes: Buffer.from("nonsense"),
      }),
    ).rejects.toThrow(/save as \.xlsx/);
  });

  it("reads a CSV as well as a workbook", async () => {
    const csv = [
      "Work Order Date,Consultant Name,Line No.,Description,Account,Quantity,Rate,Amount",
      "8/15/2026,Abigail Bautista,1,Consultation,Consultant Fees,0.5,100000,50000",
    ].join("\n");

    const staged = await stageImport({
      companyId: fixture.company.id,
      fileName: "sheet.csv",
      bytes: Buffer.from(csv, "utf8"),
    });
    expect(staged.validation.counts.error).toBe(0);
    expect(staged.validation.workOrders[0].total.toFixed(2)).toBe("50000.00");
  });

  it("produces an annotated reject file", async () => {
    const staged = await stage([
      ...REAL_SHEET,
      ["8/15/2026", "Nobody At All", 1, "Work", "Consultant Fees", 1, 1000, 1000],
    ]);
    await commitImport({ companyId: fixture.company.id, batchId: staged.batchId });

    const bytes = await buildRejectWorkbook(fixture.company.id, staged.batchId);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as unknown as ArrayBuffer);
    const sheet = book.getWorksheet("Rejected rows")!;

    // Header plus exactly the rejected row.
    expect(sheet.rowCount).toBe(2);
    const reason = String(sheet.getRow(2).getCell(sheet.columnCount).value);
    expect(reason).toMatch(/No consultant matches "Nobody At All"/);
  });

  it("produces a template that imports cleanly against itself", async () => {
    const accounts = await prisma.account.findMany({
      where: { companyId: fixture.company.id },
      select: { code: true, name: true },
    });
    const bytes = await buildTemplateWorkbook({
      consultants: [{ name: "Abigail Bautista", externalRef: "C-001" }],
      accounts,
    });

    const staged = await stageImport({
      companyId: fixture.company.id,
      fileName: "template.xlsx",
      bytes,
    });
    // The example rows are a real, valid work order: one line plus a deduction.
    expect(staged.validation.counts.error).toBe(0);
    expect(staged.validation.workOrders).toHaveLength(1);
    expect(staged.validation.workOrders[0].total.toFixed(2)).toBe("47000.00");
  });

  it("keeps one company's import out of another's", async () => {
    const other = await makeCompanyWithChart("Elsewhere", "PHP");
    const staged = await stage(REAL_SHEET);
    await expect(
      commitImport({ companyId: other.company.id, batchId: staged.batchId }),
    ).rejects.toThrow(/not found in this company/);
  });
});

describe("sheet dates", () => {
  it("reads the user's M/D/YYYY format", () => {
    expect(parseSheetDate("8/15/2026")?.toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("reads D/M/YYYY when told to", () => {
    expect(parseSheetDate("8/9/2026", "DMY")?.toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(parseSheetDate("8/9/2026", "MDY")?.toISOString().slice(0, 10)).toBe("2026-08-09");
  });

  it("reads a real Date from the workbook and an Excel serial", () => {
    expect(parseSheetDate(new Date(Date.UTC(2026, 7, 15)))?.toISOString().slice(0, 10)).toBe("2026-08-15");
    // 46249 is 15 August 2026 in Excel's 1900 system.
    expect(parseSheetDate(46249)?.toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("returns null rather than guessing at nonsense", () => {
    expect(parseSheetDate("next Tuesday")).toBeNull();
    expect(parseSheetDate("")).toBeNull();
    expect(parseSheetDate(null)).toBeNull();
  });
});
