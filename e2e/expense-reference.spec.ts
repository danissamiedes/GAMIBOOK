import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * No expense without a reference (SPEC §7.1).
 *
 * Two refusals, because one of them is only a convenience: the browser stops
 * the blank form, and the ledger stops anything that gets past it. This test
 * can only see the first, so the library tests carry the second.
 */
const stamp = Date.now().toString(36).toUpperCase();

test("an expense cannot be recorded without a reference", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");

  // Recording is its own screen now.
  await page.goto("/expenses/new?tab=direct");
  const form = page.locator("form").filter({ has: page.getByLabel("Amount") }).first();
  await form.getByLabel("Description").fill(`Unreferenced ${stamp}`);
  await form.getByLabel("Amount").fill("100.00");
  await form.getByRole("button", { name: "Record it" }).click();

  // Nothing is submitted, and the cursor is put where the problem is.
  await expect(form.getByLabel("Reference")).toBeFocused();
  // Nothing navigated: what was typed is still in the form.
  await expect(form.getByLabel("Description")).toHaveValue(`Unreferenced ${stamp}`);

  // With one, it records and the number is what opens it afterwards.
  await form.getByLabel("Reference").fill(`OR-${stamp}`);
  await form.getByRole("button", { name: "Record it" }).click();
  // Recording lands on the document itself, named by its reference.
  await expect(page).toHaveURL(/\/expenses\/[a-z0-9]+/);
  await expect(page.getByRole("heading", { name: `Expense OR-${stamp}` })).toBeVisible();
});
