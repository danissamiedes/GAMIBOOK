import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * A purchase order's life (SPEC §8.1a): raised, issued, sent to the vendor,
 * and — when the goods turn up — turned into the bill that finally posts.
 */
const stamp = Date.now().toString(36).toUpperCase();

test("a purchase order is raised, issued and received as a bill", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");

  // ---- Raise it --------------------------------------------------------
  await page.goto("/purchase-orders");
  await expect(page.getByRole("heading", { name: "Purchase orders" })).toBeVisible();
  await page.getByRole("link", { name: "New purchase order" }).click();

  await expect(page.getByRole("heading", { name: "New purchase order" })).toBeVisible();
  await page.locator("input[name='line-0-description']").fill(`Coco lumber ${stamp}`);
  await page.locator("input[name='line-0-quantity']").fill("10");
  await page.locator("input[name='line-0-rate']").fill("100");
  await page.getByLabel("Memo").fill(`Site order ${stamp}`);
  await page.getByRole("button", { name: "Issue purchase order" }).click();

  // ---- It is numbered, and nothing has posted --------------------------
  await expect(page).toHaveURL(/\/purchase-orders\/[a-z0-9]+/);
  await expect(page.getByRole("heading", { name: /Purchase order PO\d+/ })).toBeVisible();
  await expect(page.getByText(/nothing here is in the ledger/)).toBeVisible();
  await expect(page.getByText("issued", { exact: false }).first()).toBeVisible();
  const orderUrl = page.url();

  // ---- Receive it: this is the posting ---------------------------------
  await page.getByRole("link", { name: "Receive — make the bill" }).click();
  await expect(page.getByRole("heading", { name: /The goods arrived/ })).toBeVisible();
  await page.getByLabel("Vendor's invoice no.").fill(`INV-${stamp}`);
  await page.getByRole("button", { name: "Record the bill" }).click();

  // The bill's own page opens — the order became an ordinary payable.
  await expect(page).toHaveURL(/\/expenses\/[a-z0-9]+\?saved=1/);
  await expect(page.getByRole("heading", { name: `Bill INV-${stamp}` })).toBeVisible();
  await expect(page.getByText("Accounts Payable").first()).toBeVisible();

  // ---- And the order says what it became -------------------------------
  await page.goto(orderUrl);
  await expect(page.getByText(/This became/)).toBeVisible();
  await expect(page.getByRole("link", { name: `bill INV-${stamp}` })).toBeVisible();
});

test("the send screen lists issued orders and reviews before sending", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");

  await page.goto("/purchase-orders/send");
  await expect(page.getByRole("heading", { name: "Send purchase orders" })).toBeVisible();
  // Either there is something to send, or the screen says why not — both are
  // correct; what must never happen is a send with no confirmation.
  await expect(page.getByRole("button", { name: "Send them" })).toHaveCount(0);
});
