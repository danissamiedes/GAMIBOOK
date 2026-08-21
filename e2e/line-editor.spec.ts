import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * SPEC §8.1 asks for a line editor that is "keyboard-navigable, add-row on Tab
 * from the last field, running total visible". Only a browser can answer
 * whether the keystroke actually lands where the typist expects, which is why
 * this is one of the handful of end-to-end tests.
 */
test.describe("invoice line editor keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, "owner@example.com");
    await page.goto("/invoices/new");
  });

  const rows = (page: import("@playwright/test").Page) =>
    page.locator("tbody tr");

  test("Tab from the last field adds a line and lands in it", async ({
    page,
  }) => {
    await expect(rows(page)).toHaveCount(1);

    await page.locator('[name="line-0-description"]').fill("Consulting");
    // The account select is the last field in the row.
    await page.locator('[name="line-0-accountId"]').focus();
    await page.keyboard.press("Tab");

    await expect(rows(page)).toHaveCount(2);
    // The row was useless if the typist still has to reach for the mouse.
    await expect(page.locator('[name="line-1-description"]')).toBeFocused();
  });

  test("Enter moves down the rows instead of submitting the invoice", async ({
    page,
  }) => {
    await page.locator('[name="line-0-description"]').fill("First");
    await page.locator('[name="line-0-description"]').press("Enter");

    // Still on the form: a half-typed invoice must not post itself.
    await expect(page).toHaveURL(/\/invoices\/new/);
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('[name="line-1-description"]')).toBeFocused();

    await page.keyboard.type("Second");
    await page.locator('[name="line-0-description"]').press("Enter");
    // Enter from a row that is not the last moves down rather than adding.
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('[name="line-1-description"]')).toBeFocused();
  });

  test("Ctrl+Backspace removes the line under the cursor", async ({ page }) => {
    await page.locator('[name="line-0-description"]').fill("Keep");
    await page.locator('[name="line-0-description"]').press("Enter");
    await page.keyboard.type("Drop");
    await expect(rows(page)).toHaveCount(2);

    await page
      .locator('[name="line-1-description"]')
      .press("Control+Backspace");
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator('[name="line-0-description"]')).toHaveValue(
      "Keep",
    );
    await expect(page.locator('[name="line-0-description"]')).toBeFocused();
  });

  test("the running total follows what is typed", async ({ page }) => {
    await page.locator('[name="line-0-description"]').fill("Consulting");
    await page.locator('[name="line-0-quantity"]').fill("3");
    await page.locator('[name="line-0-rate"]').fill("2500");

    await expect(page.locator("tfoot")).toContainText("7,500.00");
  });
});

test.describe("journal line editor keyboard", () => {
  test("keeps the two lines a balanced entry needs", async ({ page }) => {
    await signIn(page, "owner@example.com");
    await page.goto("/journal/new");

    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(2);

    // An entry cannot balance on one line, so the floor holds even from the
    // keyboard (SPEC §4.2).
    await page
      .locator('[name="line-1-description"]')
      .press("Control+Backspace");
    await expect(rows).toHaveCount(2);
  });

  test("shows the difference before the server would reject it", async ({
    page,
  }) => {
    await signIn(page, "owner@example.com");
    await page.goto("/journal/new");

    await page.locator('[name="line-0-debit"]').fill("1000");
    await page.locator('[name="line-1-credit"]').fill("900");
    await expect(page.locator("tfoot")).toContainText("100.00");
  });
});
