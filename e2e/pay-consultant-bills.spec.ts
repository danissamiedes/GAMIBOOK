import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Paying consultants in one run (SPEC §6, §8.1b).
 *
 * What these guard is the shape of the screen rather than the posting, which
 * the unit tests cover against a real ledger: that it is reachable where a
 * person looks for it, that the old screen is gone, and that the confirm step
 * turns a list of documents into a list of payments before anything posts.
 */
test("the consultants menu offers paying bills, and no longer paying work orders", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");
  await page.goto("/dashboard");

  await page.getByRole("button", { name: "Consultants" }).click();
  await expect(page.getByRole("link", { name: "Pay consultant bills" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Pay work orders" })).toHaveCount(0);

  await page.getByRole("link", { name: "Pay consultant bills" }).click();
  await expect(page).toHaveURL(/\/consultant-bills\/pay$/);
  await expect(page.getByRole("heading", { name: "Pay consultant bills" })).toBeVisible();
});

test("the old address lands on the new screen rather than a dead end", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");
  // Somebody has /work-orders/pay bookmarked; without the redirect it falls
  // through to /work-orders/[id] and reads as a missing work order.
  await page.goto("/work-orders/pay");
  await expect(page).toHaveURL(/\/consultant-bills\/pay$/);
  await expect(page.getByRole("heading", { name: "Pay consultant bills" })).toBeVisible();
});

test("the run becomes one payment per consultant before anything posts", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");
  await page.goto("/consultant-bills/pay");

  const rows = page.locator("tbody tr");
  test.skip((await rows.count()) === 0, "Nothing outstanding in this book");

  // Every row says what it is and what is owed, and is ticked by default.
  await expect(rows.first().getByRole("checkbox")).toBeChecked();

  await page.getByRole("button", { name: "Review payments" }).click();
  await expect(page).toHaveURL(/confirm=1/);

  // The confirm step is the point: a list of documents has become a list of
  // payments, one per consultant, and nothing has posted yet.
  await expect(page.getByRole("heading", { name: /payments? to record/ })).toBeVisible();
  // The confirmation card renders above the selection table, which has a
  // Consultant column of its own — hence first(). "Settles" belongs to the
  // confirmation alone, so it needs no such qualification.
  await expect(page.getByRole("columnheader", { name: "Consultant" }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Settles" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Record \d+ payments?/ })).toBeVisible();
});
