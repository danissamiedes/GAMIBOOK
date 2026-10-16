import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { signIn } from "./helpers";

/**
 * A month of a client's own project spreadsheet, imported (SPEC §8.3).
 *
 * The journey that matters is the one in the middle: the sheet's categories
 * are not this company's accounts, and the preview is where that is settled
 * before anything posts.
 *
 * The categories and the file carry a stamp because the import deliberately
 * remembers a mapping and refuses a file it has already taken: a second run
 * against the same database must look like a new sheet, not a repeat.
 */
const stamp = Date.now().toString(36).toUpperCase();
const CATEGORIES = [`Materials ${stamp}`, `Tools ${stamp}`, `Labor ${stamp}`];
const ROWS = [
  ["202507- JUL", "7/5/2025", `027903-${stamp}`, `CARMEN COCO LUMBER ${stamp}`, `Coco lumber ${stamp}`, "10,580.00", CATEGORIES[0], "20250725_027903.jpeg"],
  ["202507- JUL", "7/7/2025", `070725-${stamp}`, `DALAGAN ${stamp}`, `Pala ${stamp}`, "1,050.00", CATEGORIES[1], ""],
  ["202507- JUL", "7/12/2025", `071225-${stamp}`, `LABOR ${stamp}`, `Salary- jun2, danny ${stamp}`, "14,350.00", CATEGORIES[2], ""],
];

async function sheetBytes(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("TRANSACTIONS LIST");
  sheet.addRow(["MONTH", "DATE", "NUM", "NAME", "DESCRIPTION", "AMOUNT", "ACCOUNT", "LINK TO FILE"]);
  for (const row of ROWS) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test("a spreadsheet of expenses is mapped once and imported", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");

  await page.goto("/expenses/import");
  await expect(page.getByRole("heading", { name: "Import expenses" })).toBeVisible();
  // The company this will land in is named before anything is uploaded.
  await expect(page.getByText(/will be recorded in/)).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: `KASAGAMI JULY ${stamp}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: await sheetBytes(),
  });
  await page.getByRole("button", { name: "Upload and check" }).click();

  // ---- The preview ----------------------------------------------------
  await expect(page).toHaveURL(/\/expenses\/import\/[a-z0-9]+$/, { timeout: 20000 });
  await expect(page.getByText(`Coco lumber ${stamp}`).first()).toBeVisible();
  // Three categories, none of them an account in this chart yet.
  await expect(page.getByText(CATEGORIES[0], { exact: true }).first()).toBeVisible();
  const importButton = page.getByRole("button", { name: /^Import \d+ expense/ });
  // The rows count as about-to-import, but nothing can post until the
  // categories have accounts and the money has a source.
  await expect(importButton).toHaveText(/^Import 3 expenses/);
  await expect(importButton).toBeDisabled();

  // Map each category, then say where the money came from.
  // Scoped to the page body: the header carries the company switcher.
  const selects = page.locator("main select");
  const count = await selects.count();
  for (let index = 0; index < count - 1; index++) {
    await selects.nth(index).selectOption({ label: "6100 — Supplies Expense" });
  }
  await selects.nth(count - 1).selectOption({ label: "1010 — Cash on Hand" });

  await expect(importButton).toBeEnabled();
  await importButton.click();

  // The panel's own progress gives way to the batch's standing state once the
  // page refreshes, so wait for the banner that stays.
  await expect(page.getByText(/3 expenses recorded/)).toBeVisible({ timeout: 60000 });

  // ---- And they are real expenses -------------------------------------
  await page.goto("/expenses?tab=direct");
  await expect(page.getByText(`Coco lumber ${stamp}`).first()).toBeVisible();
  await expect(page.getByText(`CARMEN COCO LUMBER ${stamp}`).first()).toBeVisible();
});
