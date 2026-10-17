import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * The work order workflow (SPEC §8.1b): raised, approved, converted to a
 * bill, and only then paid. What this spec is really guarding is the gap
 * between approval and the bill — approving must put nothing in accounts
 * payable, and the bill must be where the money is handled.
 */
const stamp = Date.now().toString(36).toUpperCase();

test("an approved work order becomes a bill, and the bill is what is paid", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");

  // ---- Raise and approve it -------------------------------------------
  await page.goto("/work-orders/new");
  await expect(page.getByRole("heading", { name: "New work order" })).toBeVisible();
  await page.locator("input[name='line-0-description']").fill(`Site supervision ${stamp}`);
  await page.locator("input[name='line-0-quantity']").fill("1");
  await page.locator("input[name='line-0-rate']").fill("18000");
  await page.locator("input[name='memo']").fill(`Supervision ${stamp}`);
  await page.getByRole("button", { name: "Approve work order" }).click();

  await expect(page).toHaveURL(/\/work-orders\/[a-z0-9]+/);
  await expect(page.getByRole("heading", { name: /Work order WO\d+/ })).toBeVisible();
  const orderUrl = page.url();

  // ---- Approving posts nothing -----------------------------------------
  await expect(page.getByText(/nothing is in accounts payable yet/i)).toBeVisible();
  // There is no payment form on an unbilled work order: nothing is owed.
  await expect(page.getByRole("heading", { name: "Record a payment" })).toHaveCount(0);

  // ---- Convert it ------------------------------------------------------
  await page.getByRole("button", { name: "Convert to bill" }).click();
  await expect(page).toHaveURL(/\/expenses\/[a-z0-9]+\?billed=1/);
  await expect(page.getByRole("heading", { name: /^Bill WO\d+$/ })).toBeVisible();
  await expect(page.getByText("Accounts Payable").first()).toBeVisible();

  // ---- And the work order says what it became --------------------------
  await page.goto(orderUrl);
  await expect(page.getByText(/^Billed as/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Convert to bill" })).toHaveCount(0);
});

test("the list offers bulk conversion and lands the bills in consultant bills", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");

  await page.goto("/work-orders/new");
  await page.locator("input[name='line-0-description']").fill(`Bulk line ${stamp}`);
  await page.locator("input[name='line-0-quantity']").fill("1");
  await page.locator("input[name='line-0-rate']").fill("2500");
  await page.getByRole("button", { name: "Approve work order" }).click();
  await expect(page).toHaveURL(/\/work-orders\/[a-z0-9]+/);
  const number = (await page
    .getByRole("heading", { name: /Work order WO\d+/ })
    .innerText()).replace("Work order ", "");

  await page.goto("/work-orders?status=APPROVED");
  await page.getByRole("checkbox", { name: `Select ${number}` }).check();
  await page.getByRole("button", { name: "Convert selected to bills" }).click();

  await expect(page).toHaveURL(/\/consultant-bills\?billed=\d+/);
  await expect(page.getByText(/converted to bills/)).toBeVisible();
  await expect(page.getByRole("link", { name: number }).first()).toBeVisible();
});
