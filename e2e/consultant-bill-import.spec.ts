import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { signIn } from "./helpers";

/**
 * A month of consultant bills, imported (SPEC §8.3).
 *
 * The expense import's journey, with the two differences this screen exists
 * for: there is no account the money came out of, because nothing is paid,
 * and a name the books have never seen is held back until somebody ticks the
 * box that creates them.
 *
 * The categories, names and the file carry a stamp because the import
 * deliberately remembers a mapping and warns about a file it has already
 * taken: a second run against the same database must look like a new sheet.
 */
const stamp = Date.now().toString(36).toUpperCase();
const CATEGORIES = [`Design fees ${stamp}`, `Site survey ${stamp}`];
const CONSULTANT = `ARCHITECT PABLO ${stamp}`;
const ROWS = [
  [
    "8/4/2025",
    `CB-001-${stamp}`,
    CONSULTANT,
    `Schematic drawings ${stamp}`,
    "24,000.00",
    CATEGORIES[0],
    "9/3/2025",
    "",
  ],
  [
    "8/18/2025",
    `CB-002-${stamp}`,
    CONSULTANT,
    `Lot survey ${stamp}`,
    "6,500.00",
    CATEGORIES[1],
    "",
    "",
  ],
];

async function sheetBytes(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("BILLS");
  sheet.addRow([
    "DATE",
    "NUM",
    "CONSULTANT",
    "DESCRIPTION",
    "AMOUNT",
    "ACCOUNT",
    "DUE DATE",
    "LINK TO FILE",
  ]);
  for (const row of ROWS) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test("a spreadsheet of consultant bills is mapped once and imported as payables", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");

  await page.goto("/consultant-bills/import");
  await expect(page.getByRole("heading", { name: "Import consultant bills" })).toBeVisible();
  // The company this will land in is named before anything is uploaded.
  await expect(page.getByText(/will be recorded in/)).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: `CONSULTANTS AUGUST ${stamp}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: await sheetBytes(),
  });
  await page.getByRole("button", { name: "Upload and check" }).click();

  // ---- The preview ----------------------------------------------------
  await expect(page).toHaveURL(/\/consultant-bills\/import\/[a-z0-9]{20,}$/, { timeout: 20000 });
  await expect(page.getByText(`Schematic drawings ${stamp}`).first()).toBeVisible();
  await expect(page.getByText(CATEGORIES[0], { exact: true }).first()).toBeVisible();

  // Both rows count as about-to-import, but nothing posts until the
  // categories have accounts and the unfamiliar name has been agreed to.
  const importButton = page.getByRole("button", { name: /^Import \d+ bill/ });
  await expect(importButton).toHaveText(/^Import 2 bills/);
  await expect(importButton).toBeDisabled();
  await expect(page.getByText(`${CONSULTANT} (2)`)).toBeVisible();

  // Map each category. Scoped to the page body: the header carries the
  // company switcher, and this screen asks nothing about payment.
  const selects = page.locator("main select");
  const count = await selects.count();
  expect(count).toBe(CATEGORIES.length);
  for (let index = 0; index < count; index++) {
    await selects.nth(index).selectOption({ label: "6100 — Supplies Expense" });
  }
  // Still refused: a bill has to say who is owed.
  await expect(importButton).toBeDisabled();
  await expect(page.getByText(/Tick the box above to create the consultants/)).toBeVisible();

  await page.locator('main input[type="checkbox"]').check();
  await expect(importButton).toBeEnabled();
  await importButton.click();

  // The panel's own progress gives way to the batch's standing state once the
  // page refreshes, so wait for the banner that stays.
  await expect(page.getByText(/2 bills recorded/)).toBeVisible({ timeout: 60000 });

  // ---- And they are real bills, owed and not paid ----------------------
  await page.goto("/consultant-bills");
  const billRow = page.getByRole("row", { name: new RegExp(`Schematic drawings ${stamp}`) });
  await expect(billRow).toBeVisible();
  // The due date the sheet gave, kept as given.
  await expect(billRow).toContainText("09/03/2025");
  // Nothing paid: the balance still equals the amount.
  await expect(billRow).toContainText("24,000.00");

  // The consultant the sheet named exists now, created once for both rows.
  await page.goto("/consultants");
  await expect(page.getByText(CONSULTANT).first()).toBeVisible();
});
