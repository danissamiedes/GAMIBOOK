import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * The period dropdown (SPEC §12), which every filtered screen now shares.
 *
 * What these guard is that the control and the dates agree. A dropdown
 * saying one thing while the report below it covers another is worse than
 * no dropdown, and that is the failure a preset link row could never have.
 */
test("a report opens on the year to date and says so", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");

  await page.goto("/reports/profit-loss");
  const period = page.locator("select[name='period']");
  await expect(period).toHaveValue("ytd");

  // The dropdown sits before the dates, which is the order the question is
  // asked in: name a period, or type your own.
  const order = await page
    // The controls form, not the header's company switcher.
    .locator("form:has(select[name='period'])")
    .evaluate((form) =>
      [...form.querySelectorAll("select[name='period'], input[name='from'], input[name='to']")].map(
        (element) => element.getAttribute("name"),
      ),
    );
  expect(order).toEqual(["period", "from", "to"]);

  // And the dates below it are the ones that period resolved to.
  const year = new Date().getUTCFullYear();
  await expect(page.locator("input[name='from']")).toHaveValue(`${year}-01-01`);
});

test("picking a period submits on its own and fills in its dates", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");
  await page.goto("/reports/profit-loss");

  await page.locator("select[name='period']").selectOption("lastMonth");
  await expect(page).toHaveURL(/period=lastMonth/);

  // The choice survives the trip, and the boxes now hold last month.
  await expect(page.locator("select[name='period']")).toHaveValue("lastMonth");
  const from = await page.locator("input[name='from']").inputValue();
  const to = await page.locator("input[name='to']").inputValue();
  expect(from.slice(-2)).toBe("01");
  expect(new Date(from) < new Date(to)).toBe(true);
  // The heading says the same dates the boxes do.
  const human = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8)}/${iso.slice(0, 4)}`;
  await expect(page.getByText(`${human(from)} to ${human(to)}`).first()).toBeVisible();
});

test("typing a date moves the dropdown to Custom", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");
  await page.goto("/reports/profit-loss?period=lastMonth");
  await expect(page.locator("select[name='period']")).toHaveValue("lastMonth");

  // Otherwise the typed date would be read and then silently ignored,
  // because the named period wins.
  await page.locator("input[name='from']").fill("2026-02-01");
  await expect(page.locator("select[name='period']")).toHaveValue("custom");

  await page.getByRole("button", { name: "Update" }).click();
  await expect(page).toHaveURL(/from=2026-02-01/);
  await expect(page.locator("input[name='from']")).toHaveValue("2026-02-01");
});

test("every one of the eleven options is offered, in order", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");
  await page.goto("/reports/profit-loss");

  const labels = await page.locator("select[name='period'] option").allInnerTexts();
  expect(labels.map((label) => label.trim())).toEqual([
    "All",
    "Today",
    "Yesterday",
    "This Week",
    "This Month",
    "This Year",
    "This Year-to-Date",
    "Last Week",
    "Last Month",
    "Last Year",
    "Last Year-to-Date",
    "Custom dates",
  ]);
});

test("the balance sheet takes the end of the period as its moment", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");
  await page.goto("/reports/balance-sheet");

  // One date, not two: a balance sheet has no start.
  await expect(page.locator("input[name='asOf']")).toBeVisible();
  await expect(page.locator("input[name='from']")).toHaveCount(0);

  await page.locator("select[name='period']").selectOption("lastMonth");
  await expect(page).toHaveURL(/period=lastMonth/);
  const asOf = await page.locator("input[name='asOf']").inputValue();
  // The last day of last month, whatever month that is.
  const nextDay = new Date(`${asOf}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  expect(nextDay.getUTCDate()).toBe(1);
  await expect(page.getByText(`as at ${asOf.slice(5, 7)}/${asOf.slice(8)}/${asOf.slice(0, 4)}`)).toBeVisible();
});

test("a list screen filters by the same dropdown", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");
  await page.goto("/work-orders");

  await expect(page.locator("select[name='period']")).toHaveValue("all");
  await page.locator("select[name='period']").selectOption("lastYear");
  await expect(page).toHaveURL(/period=lastYear/);
  // The other filter on the form came along rather than being cleared.
  await expect(page.locator("select[name='status']")).toBeVisible();
});
