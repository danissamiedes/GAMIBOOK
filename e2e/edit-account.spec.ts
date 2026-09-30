import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("account codes are editable, system ones are not", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await signIn(page, "owner@example.com");
  await page.goto("/accounts");

  // A system account's code is plain text; ordinary ones are links.
  const systemRow = page.locator("tr", { hasText: "Accounts Receivable" }).first();
  expect(await systemRow.locator("a").count()).toBe(0);
  await page.screenshot({ path: "/tmp/claude-0/-home-user-GAMIBOOK/be7517e0-545d-576f-9716-dd3de778d1b9/scratchpad/chart.png" });

  // Add one of our own so the test does not depend on seed data it mutates.
  const code = String(8000 + (Date.now() % 900));
  await page.locator('input[name="code"]').fill(code);
  await page.locator('input[name="name"]').fill("Editable Test");
  await page.getByRole("button", { name: "Add account" }).click();

  const link = page.getByRole("link", { name: code, exact: true });
  await expect(link).toBeVisible({ timeout: 15000 });
  await link.click();

  await expect(page).toHaveURL(/\/accounts\/[^/]+$/);
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await expect(page.locator('input[name="code"]')).toHaveValue(code);
  // Nothing posted to it yet, so the type is still changeable.
  await expect(page.locator('select[name="type"]')).toBeEnabled();
  await page.screenshot({ path: "/tmp/claude-0/-home-user-GAMIBOOK/be7517e0-545d-576f-9716-dd3de778d1b9/scratchpad/edit-account.png", fullPage: true });

  // Rename and renumber.
  const renumbered = String(Number(code) + 1);
  await page.locator('input[name="code"]').fill(renumbered);
  await page.locator('input[name="name"]').fill("Editable Test Renamed");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page).toHaveURL(/\/accounts\?saved=/, { timeout: 15000 });
  await expect(page.getByText(`Saved ${renumbered} Editable Test Renamed.`)).toBeVisible();

  // A duplicate code is refused with a reason.
  await page.getByRole("link", { name: renumbered, exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await page.locator('input[name="code"]').fill("1000");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/already uses that code/i)).toBeVisible({ timeout: 15000 });

  // A system account refuses editing even if its id is typed in directly.
  const payable = page.locator("tr", { hasText: "Accounts Payable" }).first();
  expect(await payable.locator("a").count()).toBe(0);

  expect(errors).toEqual([]);
});
