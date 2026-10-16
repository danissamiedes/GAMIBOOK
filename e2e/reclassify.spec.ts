import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * An expense coded to the wrong account, found and moved (SPEC §18).
 *
 * The expense is recorded through the real form first, so what the reclassify
 * screen finds is an ordinary posting rather than a fixture — and the stamp on
 * its description is what lets this run against a database earlier runs have
 * already posted into.
 */
const stamp = Date.now().toString(36).toUpperCase();
const DESCRIPTION = `Diesel ${stamp}`;

test("a miscoded expense is found, moved, and can be moved back", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");

  // ---- A posting in the wrong account ---------------------------------
  await page.goto("/expenses?tab=direct");
  const form = page.locator("form").filter({ has: page.getByLabel("Amount") }).first();
  await form.getByLabel("Description").fill(DESCRIPTION);
  await form.getByLabel("Amount").fill("10000.00");
  await form.getByLabel("Reference").fill(`REF-${stamp}`);
  const expenseAccount = form.getByLabel("Expense account");
  const wrong = (await expenseAccount.locator("option").first().textContent())?.trim() ?? "";
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(DESCRIPTION).first()).toBeVisible();

  // ---- Find it ---------------------------------------------------------
  await page.goto("/reclassify");
  await expect(page.getByRole("heading", { name: "Reclassify transactions" })).toBeVisible();
  const filters = page.locator("main form").first();
  await filters.getByLabel("From account").selectOption({ label: wrong });
  await filters.getByLabel("Description contains").fill(DESCRIPTION);
  await filters.getByRole("button", { name: "Search" }).click();

  const row = page.getByRole("row").filter({ hasText: DESCRIPTION });
  await expect(row).toBeVisible();
  await expect(page.getByText(`REF-${stamp}`)).toBeVisible();

  // ---- Move it ---------------------------------------------------------
  // Nothing posts until the summary has been seen and confirmed.
  await row.getByRole("checkbox").check();
  await expect(page.getByText(/1 of \d+ selected/)).toBeVisible();

  const target = page.locator("main").getByLabel("Move to account");
  const options = await target.locator("option").allTextContents();
  const destination = options.filter((option) => option && option !== wrong && !/Select/.test(option))[0];
  await target.selectOption({ label: destination });
  await page.getByLabel("Reason").fill(`Miscoded ${stamp}`);

  await page.getByRole("button", { name: /^Reclassify 1 transaction/ }).click();
  await expect(page.getByText("About to post 1 reclassification entries")).toBeVisible();
  await page.getByRole("button", { name: /Confirm and post/ }).click();

  await expect(page.getByText(/1 transaction reclassified/)).toBeVisible({ timeout: 30000 });
  // The posting is still listed where it was written, now marked as moved.
  await expect(page.getByText(/Already moved to/).first()).toBeVisible();

  // ---- And it can be undone -------------------------------------------
  await page.goto("/reclassify/history");
  await page.getByRole("row").filter({ hasText: `Miscoded ${stamp}` }).getByRole("link").click();
  await expect(page.getByText(/postings moved/i).first()).toBeVisible();
  await page.getByRole("button", { name: /Reverse this reclassification/ }).click();
  await expect(page.getByText(/^Reversed on/)).toBeVisible({ timeout: 30000 });
});
