import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Credit notes (SPEC §8.5), in both sections. Recording posts; applying does
 * not. The spec checks the two steps stay separate on screen, because the
 * accounting only reads correctly if they do.
 */
const stamp = Date.now().toString(36).toUpperCase();

test("a vendor credit is recorded, applied to a bill, taken off and voided", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");

  // ---- A bill for it to answer -----------------------------------------
  await page.goto("/expenses/new?tab=bill");
  await expect(page.getByRole("heading", { name: "Record a bill" })).toBeVisible();
  const vendorSelect = page.locator("select[name='vendorId']");
  // Whichever vendor the seed happens to put first: the credit has to be
  // raised against the same one, so it is read off rather than assumed.
  const vendorId = await vendorSelect.locator("option").nth(1).getAttribute("value");
  await vendorSelect.selectOption(vendorId!);
  await page.locator("input[name='reference']").fill(`BILL-${stamp}`);
  await page.locator("input[name='amount']").fill("10000");
  await page.locator("input[name='description']").fill(`Lumber ${stamp}`);
  await page.getByRole("button", { name: "Record it" }).click();
  await expect(page).toHaveURL(/\/expenses\/[a-z0-9]+/);
  const billUrl = page.url();

  // ---- Record the credit -----------------------------------------------
  await page.goto(`/vendor-credits/new?party=vendor&vendor=${vendorId}`);
  await expect(page.getByRole("heading", { name: /credit note$/i })).toBeVisible();
  await page.locator("input[name='reference']").fill(`CN-${stamp}`);
  await page.locator("input[name='amount']").fill("2500");
  await page.getByRole("button", { name: "Record credit note" }).click();

  await expect(page).toHaveURL(/\/vendor-credits\/[a-z0-9]+\?saved=1/);
  await expect(page.getByRole("heading", { name: `Credit note CN-${stamp}` })).toBeVisible();
  // Recording is the posting; it says so, and it names the entry.
  await expect(page.getByText(/Accounts payable is down by/)).toBeVisible();
  await expect(page.getByText(/^Posted as/)).toBeVisible();
  const creditUrl = page.url();

  // ---- Apply it: still nothing posted ----------------------------------
  await page.getByRole("textbox", { name: `Apply to BILL-${stamp}` }).fill("2500");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("Applied. Nothing was posted.")).toBeVisible();

  // The bill now says what settled it, and it is not a payment.
  await page.goto(billUrl);
  await expect(page.getByRole("link", { name: `CN-${stamp}` })).toBeVisible();

  // ---- Take it back off, then void it ----------------------------------
  await page.goto(creditUrl);
  await page.getByRole("button", { name: "Take off" }).first().click();
  await expect(page.getByText(/Not set against anything yet/)).toBeVisible();
  await page.getByRole("button", { name: "Void credit note" }).click();
  await expect(page.getByText("This credit note is void.")).toBeVisible();
});

test("the consultants section has its own credit notes", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");

  await page.goto("/vendor-credits?party=consultant");
  await expect(page.getByRole("heading", { name: "Consultant credit notes" })).toBeVisible();
  // The tabs move between the two without losing the section. Scoped to the
  // tab strip: the main nav has a "Vendors" link of its own.
  await page.locator("a[href='/vendor-credits?party=vendor']").click();
  await expect(page.getByRole("heading", { name: "Vendor credit notes" })).toBeVisible();
});
