import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * The open-tasks tile (SPEC §12, §14). The figure is the point, and so is
 * the fact that you can press it: a count you cannot act on is decoration.
 */
test("the dashboard counts open tasks, and the number opens the list", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");

  await page.goto("/dashboard");
  const tile = page.locator("div").filter({ hasText: /^Open tasks/ }).last();
  await expect(tile).toBeVisible();

  // The count itself is a link, not just the label above it.
  const count = tile.getByRole("link").filter({ hasText: /^\d+$/ });
  await expect(count).toHaveCount(1);
  const shown = Number((await count.innerText()).trim());

  await count.click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

  // And it is the same number of rows the board shows, since the board
  // opens on the open ones.
  const rows = await page.locator("tbody tr").count();
  expect(rows).toBe(shown);
});
