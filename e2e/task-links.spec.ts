import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * The "About" column on the task board (SPEC §14).
 *
 * A task says what it is about, and that has to open the thing itself.
 * Landing somebody on the list of two hundred bills when they were asked to
 * look at one of them is not keeping the promise the link makes — and that
 * is exactly what the expense link used to do.
 */
const stamp = Date.now().toString(36).toUpperCase();

test("the About link opens the bill, not the list of bills", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");

  // ---- A bill, and a task hung on it -----------------------------------
  await page.goto("/expenses/new?tab=bill");
  const vendorSelect = page.locator("select[name='vendorId']");
  await vendorSelect.selectOption(
    (await vendorSelect.locator("option").nth(1).getAttribute("value"))!,
  );
  await page.locator("input[name='reference']").fill(`TASKREF-${stamp}`);
  await page.locator("input[name='amount']").fill("1234");
  await page.locator("input[name='description']").fill(`Advance payment ${stamp}`);
  await page.getByRole("button", { name: "Record it" }).click();
  // An id, not just any segment: /expenses/new matches a loose pattern and
  // would be read as the saved document before the form has submitted.
  await expect(page).toHaveURL(/\/expenses\/[a-z0-9]{20,}/);
  const billUrl = page.url().replace(/\?.*$/, "");

  await page.getByRole("button", { name: /Add a task|Follow this up/ }).first().click().catch(() => {});
  const subject = page.locator("input[name='subject']").first();
  await subject.fill(`Chase ${stamp}`);
  await page.getByRole("button", { name: /Save task|Add task|Save/ }).first().click();
  await expect(page).toHaveURL(/taskSaved=1/);

  // ---- The board links straight at it ----------------------------------
  await page.goto("/tasks");
  const row = page.locator("tbody tr").filter({ hasText: `Chase ${stamp}` });
  await expect(row).toHaveCount(1);

  const about = row.getByRole("link");
  await expect(about).toHaveText(new RegExp(`Advance payment ${stamp}`));
  await about.click();

  // The document, not the list it happens to be on.
  await expect(page).toHaveURL(billUrl);
  await expect(page.getByRole("heading", { name: `Bill TASKREF-${stamp}` })).toBeVisible();
});

test("every About link points at a document page, never a list", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");
  await page.goto("/tasks?status=ALL");

  const links = page.locator("tbody tr td:nth-child(3) a");
  const count = await links.count();
  test.skip(count === 0, "No tasks on file in this book");

  for (let index = 0; index < count; index++) {
    const href = await links.nth(index).getAttribute("href");
    // A document's address ends in its id, or in /edit for the two payment
    // screens. A bare list path with a query string is the bug.
    expect(href, `About link ${index}`).not.toMatch(/\?/);
    expect(href, `About link ${index}`).toMatch(/\/[^/]+\/[a-z0-9]{10,}(\/edit)?$/);
  }
});
