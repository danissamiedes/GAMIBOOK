import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  commitExpenseChunk,
  parseSheetAmount,
  stageExpenseImport,
  validateExpenseRows,
} from "@/lib/imports/expenses";
import { readExpenseSheet } from "@/lib/imports/expenses";
import { trialBalance } from "@/lib/ledger/reports";
import { resetStorage } from "@/lib/storage";
import { makeCompanyWithChart, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

/**
 * Rows shaped exactly like the client's real sheet (supplied 2026-10-16):
 * MONTH | DATE | NUM | NAME | DESCRIPTION | AMOUNT | ACCOUNT | LINK TO FILE.
 */
type SheetRow = [string, string, string, string, string, string | number, string, string];

async function workbook(rows: SheetRow[], sheetName = "TRANSACTIONS LIST"): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(sheetName);
  sheet.addRow(["MONTH", "DATE", "NUM", "NAME", "DESCRIPTION", "AMOUNT", "ACCOUNT", "LINK TO FILE"]);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

const REAL_ROWS: SheetRow[] = [
  ["202507- JUL", "7/5/2025", "027903", "CARMEN COCO LUMBER", "Coco lumber", "10,580.00", "Materials", "20250725_027903_NO NAME.jpeg"],
  ["202507- JUL", "7/7/2025", "070725", "DALAGAN", "Pala", "1,050.00", "Tools & Equipments", "20250707_070725_NO NAME.jpgg"],
  ["202507- JUL", "7/7/2025", "070725", "BOHOLANO", "Bara", "1,100.00", "Tools & Equipments", "20250707_070725_NO NAME.jpgg"],
  ["202507- JUL", "7/12/2025", "071225", "LABOR", "Salary- jun2, danny, rodring", "14,350.00", "Labor", "20250712_071225_NO NAME.jpg"],
  ["202507- JUL", "7/17/2025", "071725", "ROSE BAKESHOP", "Painit - 150 per day x 12 days", "1,800.00", "Food", ""],
];

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetStorage();
  fixture = await makeCompanyWithChart("KASAGAMI APARTMENTS");
});

/** The accounts a project sheet's categories are mapped onto. */
async function mapping() {
  const materials = fixture.code("6100");
  const tools = fixture.code("6200");
  const labour = fixture.code("6300");
  const food = fixture.code("6400");
  return {
    Materials: materials.id,
    "Tools & Equipments": tools.id,
    Labor: labour.id,
    Food: food.id,
  };
}

describe("reading the client's expense sheet (SPEC §8.3)", () => {
  it("finds the columns whatever the sheet calls the tab", async () => {
    const sheet = await readExpenseSheet({
      bytes: await workbook(REAL_ROWS),
      fileName: "KASAGAMI 2025.xlsx",
    });

    expect(sheet.missingRequired).toEqual([]);
    expect(sheet.rows).toHaveLength(5);
    // MONTH is not a column this import wants, and saying so is the point:
    // the date is the only thing that decides when something happened.
    expect(sheet.unmatchedHeaders).toContain("MONTH");
    expect(sheet.rows[0].values.description).toBe("Coco lumber");
    expect(sheet.rows[0].values.account).toBe("Materials");
  });

  it("reads amounts written the way people write them", () => {
    expect(parseSheetAmount("10,580.00")?.toFixed(2)).toBe("10580.00");
    expect(parseSheetAmount("₱1,050")?.toFixed(2)).toBe("1050.00");
    expect(parseSheetAmount(16000)?.toFixed(2)).toBe("16000.00");
    expect(parseSheetAmount("(500.00)")?.toFixed(2)).toBe("-500.00");
    expect(parseSheetAmount("")).toBeNull();
    expect(parseSheetAmount("n/a")).toBeNull();
  });

  it("refuses a sheet that is missing a column it cannot do without", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("x");
    sheet.addRow(["DATE", "NAME", "DESCRIPTION"]);
    sheet.addRow(["7/5/2025", "CARMEN", "Coco lumber"]);

    await expect(
      stageExpenseImport({
        companyId: fixture.company.id,
        fileName: "short.xlsx",
        bytes: Buffer.from(await book.xlsx.writeBuffer()),
      }),
    ).rejects.toThrow(/AMOUNT|ACCOUNT/);
  });
});

describe("what the preview says before anything is recorded (SPEC §8.3)", () => {
  it("lists each category once, and the payees it would create", async () => {
    const staged = await stageExpenseImport({
      companyId: fixture.company.id,
      fileName: "KASAGAMI 2025.xlsx",
      bytes: await workbook(REAL_ROWS),
    });

    // Nothing is recorded by uploading.
    expect(await prisma.expense.count()).toBe(0);
    expect(staged.validation.categories.map((entry) => entry.category).sort()).toEqual([
      "Food",
      "Labor",
      "Materials",
      "Tools & Equipments",
    ]);
    expect(staged.validation.categories.find((c) => c.category === "Tools & Equipments")?.rowCount).toBe(2);
    expect(staged.validation.newVendors).toContain("CARMEN COCO LUMBER");
    // A category nobody has mapped yet is a question, not a fault: the rows
    // are counted as about-to-import, but none of them is ready to post until
    // somebody says what "Materials" means here.
    expect(staged.validation.errorCount).toBe(0);
    expect(staged.validation.validCount).toBe(0);
    expect(staged.validation.mappableCount).toBe(5);
    // …and the file's own total is shown all the same.
    expect(staged.validation.total.toFixed(2)).toBe("28880.00");
  });

  it("maps categories to real accounts when told to", async () => {
    const sheet = await readExpenseSheet({
      bytes: await workbook(REAL_ROWS),
      fileName: "x.xlsx",
    });
    const validation = await validateExpenseRows({
      companyId: fixture.company.id,
      rows: sheet.rows,
      accountMap: await mapping(),
    });

    expect(validation.errorCount).toBe(0);
    expect(validation.validCount).toBe(5);
    expect(validation.total.toFixed(2)).toBe("28880.00");
    expect(validation.rows[0].planned?.reference).toBe("027903");
    expect(validation.rows[0].planned?.receiptUrl).toBe("20250725_027903_NO NAME.jpeg");
  });

  it("rejects a row rather than guessing at it", async () => {
    const rows: SheetRow[] = [
      ["202507- JUL", "", "1", "A", "No date", "100.00", "Materials", ""],
      ["202507- JUL", "7/5/2025", "2", "B", "", "100.00", "Materials", ""],
      ["202507- JUL", "7/5/2025", "3", "C", "Not a number", "abc", "Materials", ""],
      ["202507- JUL", "7/5/2025", "4", "D", "Zero", "0", "Materials", ""],
      ["202507- JUL", "7/5/2025", "5", "E", "Unknown category", "100.00", "Pamalit", ""],
    ];
    const sheet = await readExpenseSheet({ bytes: await workbook(rows), fileName: "x.xlsx" });
    const validation = await validateExpenseRows({
      companyId: fixture.company.id,
      rows: sheet.rows,
      accountMap: await mapping(),
    });

    expect(validation.validCount).toBe(0);
    const messages = validation.rows.flatMap((row) => row.issues.map((issue) => issue.message));
    expect(messages.some((message) => /No date/.test(message))).toBe(true);
    expect(messages.some((message) => /No description/.test(message))).toBe(true);
    expect(messages.some((message) => /not a number/i.test(message))).toBe(true);
    expect(messages.some((message) => /more than zero/.test(message))).toBe(true);
    expect(messages.some((message) => /No account matches "Pamalit"/.test(message))).toBe(true);
  });
});

describe("committing the import (SPEC §8.3)", () => {
  it("records each row as a paid expense, and the books still balance", async () => {
    const cash = fixture.code("1010");
    const staged = await stageExpenseImport({
      companyId: fixture.company.id,
      fileName: "KASAGAMI 2025.xlsx",
      bytes: await workbook(REAL_ROWS),
    });

    const progress = await commitExpenseChunk({
      companyId: fixture.company.id,
      batchId: staged.batchId,
      accountMap: await mapping(),
      paymentAccountId: cash.id,
      createVendors: true,
    });

    expect(progress.done).toBe(true);
    expect(progress.failed).toEqual([]);
    expect(progress.imported).toBe(5);

    const expenses = await prisma.expense.findMany({
      where: { companyId: fixture.company.id },
      include: { vendor: true },
      orderBy: { date: "asc" },
    });
    expect(expenses).toHaveLength(5);
    // Paid, not owed: nothing lands in accounts payable.
    expect(expenses.every((expense) => expense.kind === "DIRECT")).toBe(true);
    expect(expenses.every((expense) => expense.status === "PAID")).toBe(true);
    expect(expenses.every((expense) => expense.paymentAccountId === cash.id)).toBe(true);
    expect(expenses[0].vendor?.name).toBe("CARMEN COCO LUMBER");
    expect(expenses[0].reference).toBe("027903");

    // Five payees, five vendors — one each, not one per row.
    expect(await prisma.vendor.count({ where: { companyId: fixture.company.id } })).toBe(5);

    const balance = await trialBalance({ companyId: fixture.company.id, asOf: new Date("2025-12-31") });
    expect(balance.totalDebit.toFixed(2)).toBe(balance.totalCredit.toFixed(2));

    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: staged.batchId } });
    expect(batch.status).toBe("COMMITTED");
    expect(batch.createdCount).toBe(5);
  });

  it("remembers the mapping, so the next sheet needs none", async () => {
    const cash = fixture.code("1010");
    const first = await stageExpenseImport({
      companyId: fixture.company.id,
      fileName: "july.xlsx",
      bytes: await workbook(REAL_ROWS),
    });
    await commitExpenseChunk({
      companyId: fixture.company.id,
      batchId: first.batchId,
      accountMap: await mapping(),
      paymentAccountId: cash.id,
      createVendors: true,
    });

    // A different file, the same vocabulary, and no mapping supplied.
    const second = await stageExpenseImport({
      companyId: fixture.company.id,
      fileName: "august.xlsx",
      bytes: await workbook([
        ["202508- AUG", "8/4/2025", "0881", "KIM HING HARDWARE", "Cement", "3,680.00", "Materials", ""],
      ]),
    });
    expect(second.validation.errorCount).toBe(0);
    expect(second.validation.rows[0].planned?.accountLabel).toContain("6100");
  });

  it("continues where it left off rather than importing twice", async () => {
    const cash = fixture.code("1010");
    const staged = await stageExpenseImport({
      companyId: fixture.company.id,
      fileName: "KASAGAMI 2025.xlsx",
      bytes: await workbook(REAL_ROWS),
    });
    const options = {
      companyId: fixture.company.id,
      batchId: staged.batchId,
      accountMap: await mapping(),
      paymentAccountId: cash.id,
      createVendors: true,
    };

    // Two rows at a time, the way the page calls it for a long file.
    const one = await commitExpenseChunk({ ...options, limit: 2 });
    expect(one).toMatchObject({ imported: 2, done: false });
    expect(one.remaining).toBe(3);

    const two = await commitExpenseChunk({ ...options, limit: 2 });
    expect(two.imported).toBe(2);

    const three = await commitExpenseChunk({ ...options, limit: 2 });
    expect(three.done).toBe(true);

    // Five rows, five expenses — no row recorded twice by the repeated calls.
    expect(await prisma.expense.count({ where: { companyId: fixture.company.id } })).toBe(5);

    // And a call after the batch is finished is refused rather than doubling.
    await expect(commitExpenseChunk(options)).rejects.toThrow(/already been imported/);
  });

  it("leaves the payee off rather than inventing a vendor when told not to", async () => {
    const cash = fixture.code("1010");
    const staged = await stageExpenseImport({
      companyId: fixture.company.id,
      fileName: "x.xlsx",
      bytes: await workbook([REAL_ROWS[0]]),
    });
    await commitExpenseChunk({
      companyId: fixture.company.id,
      batchId: staged.batchId,
      accountMap: await mapping(),
      paymentAccountId: cash.id,
      createVendors: false,
    });

    const expense = await prisma.expense.findFirstOrThrow({
      where: { companyId: fixture.company.id },
    });
    expect(expense.vendorId).toBeNull();
    expect(await prisma.vendor.count({ where: { companyId: fixture.company.id } })).toBe(0);
  });

  it("will not post into another company's books", async () => {
    const other = await makeCompanyWithChart("THE PICKLE FARM");
    const staged = await stageExpenseImport({
      companyId: fixture.company.id,
      fileName: "x.xlsx",
      bytes: await workbook([REAL_ROWS[0]]),
    });

    await expect(
      commitExpenseChunk({
        companyId: other.company.id,
        batchId: staged.batchId,
        accountMap: await mapping(),
        paymentAccountId: other.code("1010").id,
        createVendors: true,
      }),
    ).rejects.toThrow(/not found in this company/);
  });
});
