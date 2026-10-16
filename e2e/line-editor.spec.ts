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

  test("rows can be dragged into a new order, and moved with the keyboard", async ({
    page,
  }) => {
    // Three lines, so a move has somewhere to go in both directions.
    await page.locator('[name="line-0-description"]').fill("First");
    await page.locator('[name="line-0-accountId"]').focus();
    await page.keyboard.press("Tab");
    await page.locator('[name="line-1-description"]').fill("Second");
    await page.locator('[name="line-1-accountId"]').focus();
    await page.keyboard.press("Tab");
    await page.locator('[name="line-2-description"]').fill("Third");
    await expect(rows(page)).toHaveCount(3);

    // ---- Drag the first row to the bottom -----------------------------
    const grip = page.getByRole("button", { name: /reorder line 1/i });
    const target = rows(page).nth(2);
    // At phone width the table scrolls sideways and the grip starts off
    // screen, where a synthetic pointer would land on nothing.
    await grip.scrollIntoViewIfNeeded();
    const from = (await grip.boundingBox())!;
    const to = (await target.boundingBox())!;

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Moved in steps: the row reorders as the pointer passes each midpoint,
    // and one jump would skip the rows in between.
    await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator('[name="line-0-description"]')).toHaveValue("Second");
    await expect(page.locator('[name="line-1-description"]')).toHaveValue("Third");
    await expect(page.locator('[name="line-2-description"]')).toHaveValue("First");

    // ---- And the keyboard still moves a row, keeping its place ---------
    const second = page.locator('[name="line-1-description"]');
    await second.click();
    await second.press("Alt+ArrowUp");
    await expect(page.locator('[name="line-0-description"]')).toHaveValue("Third");
    await expect(page.locator('[name="line-0-description"]')).toBeFocused();

    // The order on screen is the order the form will send.
    await expect(page.locator('[name="line-1-description"]')).toHaveValue("Second");
    await expect(page.locator('[name="line-2-description"]')).toHaveValue("First");
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
