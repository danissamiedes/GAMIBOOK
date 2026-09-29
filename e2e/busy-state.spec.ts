import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * A server action leaves the page interactive while it runs, so a slow save
 * once looked exactly like a click that missed — and people pressed again. On a
 * form that posts to the ledger, pressing again is a duplicate entry.
 *
 * These check the three things that stop that: the button says it is working,
 * the pointer says it too, and a second press does nothing.
 */
test.describe("buttons show they are working", () => {
  test("a slow action spins the button, waits the cursor, and blocks a second press", async ({
    page,
  }) => {
    await signIn(page, "owner@example.com");
    await page.goto("/customers/new");
    await page.locator('input[name="name"]').fill(`Busy ${Date.now()}`);

    const save = page.getByRole("button", { name: "Add customer" });
    await expect(save).toBeEnabled();
    await expect(page.locator("html[data-busy]")).toHaveCount(0);
    expect(await save.evaluate((el) => getComputedStyle(el).cursor)).not.toBe("wait");

    // Hold the action open so the pending state can actually be observed.
    await page.route("**/customers/new", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });
    await save.click();

    await expect(page.locator("html[data-busy]")).toHaveCount(1, { timeout: 5000 });
    expect(await save.evaluate((el) => getComputedStyle(el).cursor)).toBe("wait");
    await expect(save).toHaveAttribute("aria-busy", "true");
    await expect(save).toBeDisabled();
    expect(await save.locator("svg.animate-spin").count()).toBe(1);

    await page.unroute("**/customers/new");
  });

  test("an idle screen carries no spinner and no busy cursor", async ({ page }) => {
    await signIn(page, "owner@example.com");
    await page.goto("/customers");
    await expect(page.getByRole("link", { name: "Add New" })).toBeVisible();
    await expect(page.locator("html[data-busy]")).toHaveCount(0);
    expect(await page.locator("svg.animate-spin").count()).toBe(0);
  });

  test("the busy cursor is released once the action finishes", async ({ page }) => {
    // The button usually unmounts mid-flight, because a successful save
    // redirects. If the cursor were only cleared on the way back, it would stay
    // spinning on whatever page replaced it.
    await signIn(page, "owner@example.com");
    await page.goto("/customers/new");
    await page.locator('input[name="name"]').fill(`Busy release ${Date.now()}`);
    await page.getByRole("button", { name: "Add customer" }).click();

    await expect(page).toHaveURL(/\/customers\/[^/]+$/, { timeout: 15000 });
    await expect(page.locator("html[data-busy]")).toHaveCount(0);
  });
});
