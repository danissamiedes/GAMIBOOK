import { beforeEach, describe, expect, it } from "vitest";
import { recordExpense, updateExpense } from "@/lib/payables/expenses";
import { generateBillOccurrence } from "@/lib/payables/recurring-bills";
import { readExpenseSheet, stageExpenseImport } from "@/lib/imports/expenses";
import ExcelJS from "exceljs";
import { makeCompanyWithChart, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

let fixture: Fixture;

const JULY = new Date("2025-07-10");

beforeEach(async () => {
  await resetDatabase();
  fixture = await makeCompanyWithChart("KASAGAMI APARTMENTS");
});

const spend = (reference: string | null | undefined) =>
  recordExpense({
    companyId: fixture.company.id,
    kind: "DIRECT",
    date: JULY,
    currency: "PHP",
    amount: "1000.00",
    expenseAccountId: fixture.code("6100").id,
    paymentAccountId: fixture.code("1010").id,
    description: "Diesel",
    reference,
  });

describe("every expense carries a reference (SPEC §7.1)", () => {
  it("refuses one with no reference, and one with only spaces", async () => {
    await expect(spend(null)).rejects.toThrow(/reference number is required/i);
    await expect(spend("   ")).rejects.toThrow(/reference number is required/i);
    await expect(spend(undefined)).rejects.toThrow(/reference number is required/i);

    // Refused means nothing was written, not written and rolled back later.
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.journalEntry.count()).toBe(0);
  });

  it("keeps the reference it was given, trimmed", async () => {
    const { expense } = await spend("  000045 ");
    expect(expense.reference).toBe("000045");
  });

  it("refuses to edit the reference away", async () => {
    const { expense } = await spend("000045");
    await expect(
      updateExpense({
        companyId: fixture.company.id,
        expenseId: expense.id,
        date: JULY,
        currency: "PHP",
        amount: "1000.00",
        expenseAccountId: fixture.code("6100").id,
        paymentAccountId: fixture.code("1010").id,
        description: "Diesel",
        reference: "",
      }),
    ).rejects.toThrow(/reference number is required/i);

    const after = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(after.reference).toBe("000045");
  });

  it("gives a recurring bill a reference of its own when the template has none", async () => {
    const vendor = await prisma.vendor.create({
      data: {
        companyId: fixture.company.id,
        kind: "REGULAR",
        name: "DAVAO LIGHT",
        defaultCurrency: "PHP",
      },
    });
    const template = await prisma.recurringBillTemplate.create({
      data: {
        companyId: fixture.company.id,
        name: "Monthly electricity",
        kind: "BILL",
        vendorId: vendor.id,
        currency: "PHP",
        amount: "3000.00",
        expenseAccountId: fixture.code("6100").id,
        description: "Electricity",
        frequency: "MONTHLY",
        dayOfMonth: 1,
        startDate: new Date("2025-07-01"),
        nextRunDate: new Date("2025-07-01"),
        paymentTermsDays: 30,
      },
    });

    const run = await generateBillOccurrence({
      templateId: template.id,
      scheduledDate: new Date("2025-07-01"),
    });
    expect(run.status).toBe("RECORDED");

    const expense = await prisma.expense.findFirstOrThrow({
      where: { companyId: fixture.company.id },
    });
    // Traceable to the template and the month it ran for.
    expect(expense.reference).toMatch(/^REC-202507-[A-Z0-9]{6}$/);
  });
});

describe("a sheet with no reference column, or none on a row (SPEC §8.3)", () => {
  const headers = ["MONTH", "DATE", "NUM", "NAME", "DESCRIPTION", "AMOUNT", "ACCOUNT", "LINK TO FILE"];

  async function workbook(rows: (string | number)[][], columns = headers): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("TRANSACTIONS LIST");
    sheet.addRow(columns);
    for (const row of rows) sheet.addRow(row);
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  it("refuses the whole sheet when the NUM column is missing", async () => {
    const withoutNum = headers.filter((header) => header !== "NUM");
    const sheet = await readExpenseSheet({
      bytes: await workbook([["202507- JUL", "7/5/2025", "DALAGAN", "Pala", "1,050.00", "Tools", ""]], withoutNum),
      fileName: "no-num.xlsx",
    });
    expect(sheet.missingRequired).toContain("num");

    await expect(
      stageExpenseImport({
        companyId: fixture.company.id,
        fileName: "no-num.xlsx",
        bytes: await workbook(
          [["202507- JUL", "7/5/2025", "DALAGAN", "Pala", "1,050.00", "Tools", ""]],
          withoutNum,
        ),
      }),
    ).rejects.toThrow(/missing required columns/i);
  });

  it("rejects the rows that have no NUM, and keeps the ones that do", async () => {
    const staged = await stageExpenseImport({
      companyId: fixture.company.id,
      fileName: "july.xlsx",
      bytes: await workbook([
        ["202507- JUL", "7/5/2025", "027903", "CARMEN COCO LUMBER", "Coco lumber", "10,580.00", "Materials", ""],
        ["202507- JUL", "7/7/2025", "", "DALAGAN", "Pala", "1,050.00", "Materials", ""],
      ]),
    });

    const broken = staged.validation.rows.find((row) => !row.values.num);
    expect(broken?.issues.map((issue) => issue.message)).toContain(
      "No reference number — fill in NUM and upload again",
    );
    // One row is only waiting on a mapping; the other cannot be imported at all.
    expect(staged.validation.errorCount).toBe(1);
    expect(staged.validation.mappableCount).toBe(1);
  });
});
