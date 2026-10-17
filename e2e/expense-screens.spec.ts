import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Recording, reading and correcting an expense are three screens (SPEC §8.2).
 *
 * The form used to sit in a column beside the list, which meant "open this
 * transaction" put a hundred other rows on the same screen. Each of the three
 * now has its own address, and this walks all of them.
 */
const stamp = Date.now().toString(36).toUpperCase();

test("an expense is recorded, read and corrected on screens of its own", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");

  // ---- The list has no form on it -------------------------------------
  await page.goto("/expenses?tab=direct");
  await expect(page.getByRole("heading", { name: "Expenses and bills" })).toBeVisible();
  await expect(page.getByLabel("Amount")).toHaveCount(0);

  // ---- Recording is a screen ------------------------------------------
  await page.getByRole("link", { name: "Record an expense" }).click();
  await expect(page).toHaveURL(/\/expenses\/new\?tab=direct/);
  await expect(page.getByRole("heading", { name: "Record a direct expense" })).toBeVisible();

  await page.getByLabel("Description").fill(`Screens ${stamp}`);
  await page.getByLabel("Amount").fill("250.00");
  await page.getByLabel("Reference").fill(`SCR-${stamp}`);
  await page.getByRole("button", { name: "Record it" }).click();

  // ---- …and it lands on the document, not back on the list ------------
  await expect(page).toHaveURL(/\/expenses\/[a-z0-9]+\?saved=1/);
  await expect(page.getByRole("heading", { name: `Expense SCR-${stamp}` })).toBeVisible();
  await expect(page.getByText("How it posted")).toBeVisible();

  // ---- Correcting is a screen too -------------------------------------
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(/\/expenses\/[a-z0-9]+\/edit/);
  await expect(page.getByRole("heading", { name: `Edit expense SCR-${stamp}` })).toBeVisible();
  await page.getByLabel("Description").fill(`Screens ${stamp} corrected`);
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page).toHaveURL(/\/expenses\/[a-z0-9]+\?saved=1/);
  await expect(page.getByText(`Screens ${stamp} corrected`).first()).toBeVisible();

  // ---- And it can be voided from the same screen ----------------------
  await page.getByRole("link", { name: "Void" }).click();
  await expect(page.getByRole("heading", { name: /Void this expense/ })).toBeVisible();
  await page.getByRole("button", { name: "Void it" }).click();

  await expect(page.getByText(/Voided\./)).toBeVisible({ timeout: 30000 });
  // The document stays, marked, and offers no second void.
  await expect(page.getByText(/was voided/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Void" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
});

test("a consultant bill is recorded on a screen of its own", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");

  await page.goto("/consultant-bills");
  await expect(page.getByLabel("Amount")).toHaveCount(0);
  await page.getByRole("link", { name: "Record a consultant bill" }).click();
  await expect(page.getByRole("heading", { name: "Record a consultant bill" })).toBeVisible();
  await expect(page.locator("select[name='vendorId']")).toBeVisible();
});
