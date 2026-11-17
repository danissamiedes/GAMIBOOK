import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  commitConsultantBillChunk,
  readConsultantBillSheet,
  stageConsultantBillImport,
  validateConsultantBillRows,
} from "@/lib/imports/consultant-bills";
import { apAging } from "@/lib/payables/aging";
import { trialBalance } from "@/lib/ledger/reports";
import { resetStorage } from "@/lib/storage";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

/**
 * Importing a month of consultant bills (SPEC §8.3).
 *
 * The expense import's shape, for a document that is owed rather than paid.
 * What these assert is the three places the two genuinely differ: a bill has
 * to say who is owed, it falls due on a date somebody has to decide, and
 * committing leaves money in accounts payable rather than taking it out of
 * the bank.
 */

/** DATE | NUM | CONSULTANT | DESCRIPTION | AMOUNT | ACCOUNT | DUE DATE | LINK TO FILE */
type SheetRow = [string, string, string, string, string | number, string, string, string];

async function workbook(
  rows: SheetRow[],
  options: { sheetName?: string; headers?: string[] } = {},
): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(options.sheetName ?? "CONSULTANT BILLS");
  sheet.addRow(
    options.headers ?? [
      "DATE",
      "NUM",
      "CONSULTANT",
      "DESCRIPTION",
      "AMOUNT",
      "ACCOUNT",
      "DUE DATE",
      "LINK TO FILE",
    ],
  );
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

const ROWS: SheetRow[] = [
  ["7/5/2025", "INV-2201", "DANNY", "Site supervision, July", "25,000.00", "Consultant Fees", "8/4/2025", "danny-jul.pdf"],
  ["7/12/2025", "INV-2202", "ABIGAIL BAUTISTA", "Drawings, revision C", "18,500.00", "Consultant Fees", "", ""],
  ["7/20/2025", "INV-2203", "DANNY", "Site supervision, late July", "12,000.00", "Labor", "", ""],
];

let fixture: Fixture;
let owner: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  await resetDatabase();
  resetStorage();
  fixture = await makeCompanyWithChart("KASAGAMI APARTMENTS");
  owner = await makeUser("OWNER", fixture.company.id);
});

const consultant = (name: string, paymentTermsDays = 30) =>
  prisma.vendor.create({
    data: {
      companyId: fixture.company.id,
      kind: "CONSULTANT",
      name,
      defaultCurrency: "PHP",
      paymentTermsDays,
    },
  });

/** The accounts this sheet's categories are mapped onto. */
const mapping = () => ({
  "Consultant Fees": fixture.code("5000").id,
  Labor: fixture.code("6300").id,
});

const stage = async (rows: SheetRow[] = ROWS) =>
  stageConsultantBillImport({
    companyId: fixture.company.id,
    fileName: "consultant-bills-july.xlsx",
    bytes: await workbook(rows),
    userId: owner.id,
  });

const commit = (batchId: string, over: Record<string, unknown> = {}) =>
  commitConsultantBillChunk({
    companyId: fixture.company.id,
    batchId,
    accountMap: mapping(),
    createConsultants: false,
    userId: owner.id,
    ...over,
  });

describe("reading the sheet", () => {
  it("labels the columns, whatever they are called", async () => {
    const sheet = await readConsultantBillSheet({
      bytes: await workbook(ROWS, {
        headers: [
          "Bill Date",
          "Invoice No",
          "Consultant Name",
          "Particulars",
          "Total",
          "Category",
          "Payable On",
          "Attachment",
        ],
      }),
      fileName: "x.xlsx",
    });

    expect(sheet.missingRequired).toEqual([]);
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows[0].values.num).toBe("INV-2201");
    expect(sheet.rows[0].values.consultant).toBe("DANNY");
  });

  it("refuses a sheet with no consultant column, at the upload", async () => {
    // A bill is a debt and has to say who is owed. Caught here rather than
    // row by row halfway through a commit that has already posted forty.
    const bytes = await workbook(ROWS, {
      headers: ["DATE", "NUM", "DESCRIPTION", "AMOUNT", "ACCOUNT", "DUE DATE", "LINK TO FILE", "X"],
    });
    await expect(
      stageConsultantBillImport({
        companyId: fixture.company.id,
        fileName: "x.xlsx",
        bytes,
      }),
    ).rejects.toThrow(/missing required columns: CONSULTANT/i);
  });
});

describe("what the preview makes of it", () => {
  it("holds back a name nobody has agreed to create, and says who", async () => {
    await consultant("DANNY");
    const staged = await stage();

    // Abigail is not on file. Her row waits rather than inventing her.
    expect(staged.validation.newConsultants).toEqual([{ name: "ABIGAIL BAUTISTA", rowCount: 1 }]);
    const hers = staged.validation.rows.find((row) => row.rowNumber === 3);
    expect(hers?.planned).toBeNull();
    expect(hers?.issues[0]).toMatchObject({ code: "unknownConsultant" });

    // But she is not damage: the row still counts towards what would import.
    expect(staged.validation.errorCount).toBe(0);
    expect(staged.validation.mappableCount).toBe(3);
  });

  it("plans her row once the box is ticked", async () => {
    await consultant("DANNY");
    const staged = await stage();
    const after = await validateConsultantBillRows({
      companyId: fixture.company.id,
      rows: staged.sheet.rows,
      accountMap: mapping(),
      createConsultants: true,
    });

    expect(after.validCount).toBe(3);
    const hers = after.rows.find((row) => row.rowNumber === 3);
    expect(hers?.planned).toMatchObject({ consultantIsNew: true, consultantName: "ABIGAIL BAUTISTA" });
  });

  it("matches a consultant by an alias the sheet spells differently", async () => {
    const danny = await consultant("DANNY");
    await prisma.vendor.update({
      where: { id: danny.id },
      data: { importAliases: ["DANILO R."] },
    });

    const validation = await validateConsultantBillRows({
      companyId: fixture.company.id,
      rows: (await readConsultantBillSheet({ bytes: await workbook([
        ["7/5/2025", "INV-1", "DANILO R.", "Supervision", "1000.00", "Consultant Fees", "", ""],
      ]), fileName: "x.xlsx" })).rows,
      accountMap: mapping(),
    });

    expect(validation.newConsultants).toEqual([]);
    expect(validation.rows[0].planned?.consultantId).toBe(danny.id);
  });

  it("refuses a row with no consultant at all", async () => {
    const validation = await validateConsultantBillRows({
      companyId: fixture.company.id,
      rows: (await readConsultantBillSheet({ bytes: await workbook([
        ["7/5/2025", "INV-1", "", "Supervision", "1000.00", "Consultant Fees", "", ""],
      ]), fileName: "x.xlsx" })).rows,
      accountMap: mapping(),
      createConsultants: true,
    });

    expect(validation.errorCount).toBe(1);
    expect(validation.rows[0].issues[0].message).toMatch(/has to say who is owed/i);
  });

  it("refuses a row with no reference, as the ledger does", async () => {
    const validation = await validateConsultantBillRows({
      companyId: fixture.company.id,
      rows: (await readConsultantBillSheet({ bytes: await workbook([
        ["7/5/2025", "", "DANNY", "Supervision", "1000.00", "Consultant Fees", "", ""],
      ]), fileName: "x.xlsx" })).rows,
      accountMap: mapping(),
      createConsultants: true,
    });
    expect(validation.rows[0].issues.some((issue) => issue.column === "num")).toBe(true);
  });
});

describe("when it falls due", () => {
  it("takes the date the sheet gives", async () => {
    await consultant("DANNY", 15);
    const validation = await validateConsultantBillRows({
      companyId: fixture.company.id,
      rows: (await readConsultantBillSheet({ bytes: await workbook([ROWS[0]]), fileName: "x.xlsx" }))
        .rows,
      accountMap: mapping(),
    });

    const planned = validation.rows[0].planned!;
    expect(planned.dueDate.toISOString().slice(0, 10)).toBe("2025-08-04");
    expect(planned.dueDateFromTerms).toBe(false);
  });

  it("works it out from the consultant's own terms when the sheet is blank", async () => {
    await consultant("DANNY", 15);
    const validation = await validateConsultantBillRows({
      companyId: fixture.company.id,
      rows: (await readConsultantBillSheet({ bytes: await workbook([ROWS[2]]), fileName: "x.xlsx" }))
        .rows,
      accountMap: mapping(),
    });

    // Billed 20 July, fifteen-day terms.
    const planned = validation.rows[0].planned!;
    expect(planned.dueDate.toISOString().slice(0, 10)).toBe("2025-08-04");
    expect(planned.dueDateFromTerms).toBe(true);
  });

  it("warns when due comes before billed, rather than refusing it", async () => {
    // A bill can genuinely arrive overdue — but far more often it is the two
    // columns typed the wrong way round, and the reader should look.
    await consultant("DANNY");
    const validation = await validateConsultantBillRows({
      companyId: fixture.company.id,
      rows: (await readConsultantBillSheet({ bytes: await workbook([
        ["7/20/2025", "INV-9", "DANNY", "Supervision", "1000.00", "Consultant Fees", "7/5/2025", ""],
      ]), fileName: "x.xlsx" })).rows,
      accountMap: mapping(),
    });

    expect(validation.rows[0].issues[0]).toMatchObject({ severity: "warning", column: "dueDate" });
    expect(validation.rows[0].planned).not.toBeNull();
    expect(validation.errorCount).toBe(0);
  });
});

describe("committing", () => {
  it("posts each row as a bill, owed rather than paid", async () => {
    await consultant("DANNY", 15);
    await consultant("ABIGAIL BAUTISTA", 30);
    const staged = await stage();

    const progress = await commit(staged.batchId);
    expect(progress).toMatchObject({ imported: 3, remaining: 0, done: true, failed: [] });

    const bills = await prisma.expense.findMany({ orderBy: { reference: "asc" } });
    expect(bills).toHaveLength(3);
    for (const bill of bills) {
      expect(bill.kind).toBe("BILL");
      // Owed, not paid: nothing has come out of the bank.
      expect(bill.paymentAccountId).toBeNull();
      expect(bill.balanceDue.toFixed(2)).toBe(bill.amount.toFixed(2));
      expect(bill.vendorId).not.toBeNull();
      expect(bill.dueDate).not.toBeNull();
    }
    expect(bills[0].reference).toBe("INV-2201");
    expect(bills[0].receiptUrl).toBe("danny-jul.pdf");

    // It is in accounts payable, and the books balance.
    const aging = await apAging({ companyId: fixture.company.id, asOf: new Date("2025-12-31") });
    expect(aging.totals.total.toFixed(2)).toBe("55500.00");
    const tb = await trialBalance({ companyId: fixture.company.id, asOf: new Date("2025-12-31") });
    expect(tb.totalDebit.toFixed(2)).toBe(tb.totalCredit.toFixed(2));
  });

  it("codes each row to the account its category was mapped to", async () => {
    await consultant("DANNY");
    await consultant("ABIGAIL BAUTISTA");
    const staged = await stage();
    await commit(staged.batchId);

    const labour = await prisma.expense.findFirstOrThrow({ where: { reference: "INV-2203" } });
    expect(labour.expenseAccountId).toBe(fixture.code("6300").id);
    const fees = await prisma.expense.findFirstOrThrow({ where: { reference: "INV-2201" } });
    expect(fees.expenseAccountId).toBe(fixture.code("5000").id);
  });

  it("leaves an unapproved name behind rather than inventing a consultant", async () => {
    await consultant("DANNY");
    const staged = await stage();

    const progress = await commit(staged.batchId);
    expect(progress.imported).toBe(2);
    expect(await prisma.vendor.count({ where: { kind: "CONSULTANT" } })).toBe(1);

    const row = await prisma.importRow.findFirstOrThrow({
      where: { importBatchId: staged.batchId, rowNumber: 3 },
    });
    expect(row.status).not.toBe("IMPORTED");
  });

  it("creates the consultant once when the box is ticked, however many rows name them", async () => {
    const staged = await stage([
      ROWS[1],
      ["7/22/2025", "INV-2299", "ABIGAIL BAUTISTA", "Drawings, revision D", "4,000.00", "Consultant Fees", "", ""],
    ]);

    await commit(staged.batchId, { createConsultants: true });

    const made = await prisma.vendor.findMany({ where: { kind: "CONSULTANT" } });
    expect(made).toHaveLength(1);
    expect(made[0].name).toBe("ABIGAIL BAUTISTA");
    expect(await prisma.expense.count()).toBe(2);
  });

  it("carries on past a row the ledger refuses, and says which", async () => {
    await consultant("DANNY");
    await consultant("ABIGAIL BAUTISTA");
    const staged = await stage();
    // July is closed; the first two rows are in it, the third is not.
    const { closeBooksThrough } = await import("@/lib/periods/close");
    await closeBooksThrough(
      { companyId: fixture.company.id, userId: owner.id, role: "OWNER" },
      new Date("2025-07-15"),
    );

    const progress = await commit(staged.batchId, { userId: owner.id, role: "BOOKKEEPER" });
    expect(progress.failed.length).toBeGreaterThan(0);
    expect(progress.failed[0].message).toMatch(/closed/i);
    // The rows that could post did.
    expect(await prisma.expense.count()).toBe(progress.imported);
  });

  it("continues where it left off rather than importing twice", async () => {
    await consultant("DANNY");
    await consultant("ABIGAIL BAUTISTA");
    const staged = await stage();

    const first = await commit(staged.batchId, { limit: 2 });
    expect(first).toMatchObject({ imported: 2, done: false });
    expect(first.remaining).toBe(1);

    const second = await commit(staged.batchId);
    expect(second).toMatchObject({ imported: 1, done: true });
    expect(await prisma.expense.count()).toBe(3);

    // And a third press changes nothing.
    await expect(commit(staged.batchId)).rejects.toThrow(/already been imported/i);
    expect(await prisma.expense.count()).toBe(3);
  });

  it("remembers the category mapping for next month's sheet", async () => {
    await consultant("DANNY");
    await consultant("ABIGAIL BAUTISTA");
    const staged = await stage();
    await commit(staged.batchId);

    const labour = await prisma.account.findUniqueOrThrow({
      where: { id: fixture.code("6300").id },
    });
    expect(labour.importAliases).toContain("Labor");

    // So the next upload needs no mapping at all.
    const next = await validateConsultantBillRows({
      companyId: fixture.company.id,
      rows: (await readConsultantBillSheet({ bytes: await workbook([ROWS[2]]), fileName: "x.xlsx" }))
        .rows,
    });
    expect(next.validCount).toBe(1);
  });

  it("warns that the same file has been imported before", async () => {
    await consultant("DANNY");
    await consultant("ABIGAIL BAUTISTA");
    const first = await stage();
    await commit(first.batchId);

    const again = await stage();
    expect(again.duplicateOf).toMatchObject({ id: first.batchId, createdCount: 3 });
  });

  it("will not touch another company's batch", async () => {
    await consultant("DANNY");
    const staged = await stage();
    const elsewhere = await makeCompanyWithChart("THE PICKLE FARM");

    await expect(
      commitConsultantBillChunk({
        companyId: elsewhere.company.id,
        batchId: staged.batchId,
        accountMap: {},
        createConsultants: false,
      }),
    ).rejects.toThrow(/not found in this company/i);
  });
});
