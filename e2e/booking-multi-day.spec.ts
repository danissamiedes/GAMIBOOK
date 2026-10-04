import { expect, test } from "@playwright/test";
import { activeDay, dayHref, freeCells } from "./helpers";

/**
 * One booking covering more than one day (SPEC §17).
 *
 * The thing being proved is that the selection survives moving along the date
 * strip — which is a real navigation, because only the server knows what is
 * free on a day it has not drawn — and that what comes out the other end is one
 * booking with one reference and one amount.
 */
test("a booker picks times on two days and pays for them once", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/book/the-pickle-farm");
  await page.goto(await dayHref(page, 9));

  const grid = page.locator("table");
  const pickFirstFree = async () => {
    const free = await freeCells(page);
    expect(free.length, "no free slot on this day").toBeGreaterThan(0);
    const [row, column] = free[0];
    await grid.locator("tbody tr").nth(row).locator("td").nth(column).locator("button").click();
  };

  await pickFirstFree();
  await expect(page.getByText("1 slot", { exact: true })).toBeVisible();

  // On to the next day, by clicking the tab rather than typing a URL: the tab's
  // own link is what has to carry the selection across the navigation.
  const current = await activeDay(page);
  const next = new Date(`${current}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDay = next.toISOString().slice(0, 10);
  await page.locator(`a[data-date="${nextDay}"]`).click();
  // Wait for that day to actually be the one on screen. Clicking a cell while
  // the previous day's grid is still up would toggle a slot on the old day.
  await expect(page.locator(`a[data-date="${nextDay}"]`)).toHaveAttribute("aria-current", "date");
  await expect(page.getByText("1 slot", { exact: true })).toBeVisible();
  await pickFirstFree();

  // Two slots, two days, one total.
  await expect(page.getByText("2 slots · 2 days")).toBeVisible();
  await page.locator('input[name="customerName"]').fill("Two Day Tester");
  await page.locator('input[name="customerEmail"]').fill("twoday@example.com");
  await page.getByRole("button", { name: "Hold these 2 slots" }).click();

  await expect(page).toHaveURL(/\/book\/the-pickle-farm\/[A-Z0-9-]+$/, { timeout: 20000 });
  // One reference, one amount, and the days listed separately.
  await expect(page.getByText("2 booked across 2 days")).toBeVisible();
  await expect(page.getByText("Held — we need your payment")).toBeVisible();

  const dayHeadings = page.locator("p.text-xs.uppercase");
  expect(await dayHeadings.count()).toBeGreaterThanOrEqual(2);

  await page.screenshot({
    path: "/tmp/claude-0/-home-user-GAMIBOOK/be7517e0-545d-576f-9716-dd3de778d1b9/scratchpad/multi-day-booking.png",
    fullPage: true,
  });
});

test("the date strip reaches days beyond the two weeks it shows", async ({ page }) => {
  await page.goto("/book/the-pickle-farm");

  // Fourteen tabs on screen, out of a horizon that is far longer.
  await expect(page.locator("a[data-date]")).toHaveCount(14);

  // The jump box reaches the rest of the horizon without scrolling to it.
  const jump = page.locator('input[type="date"]');
  const max = await jump.getAttribute("max");
  const today = new Date().toISOString().slice(0, 10);
  expect(max).toBeTruthy();
  const daysAhead = Math.round(
    (Date.parse(`${max}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  expect(daysAhead).toBeGreaterThan(14);
});

test("changing day swaps the grid without reloading the page", async ({ page }) => {
  await page.goto("/book/the-pickle-farm");

  // A mark that only survives if the document is never replaced.
  await page.evaluate(() => {
    (window as unknown as { marker?: string }).marker = "same-document";
  });

  const current = await activeDay(page);
  const next = new Date(`${current}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDay = next.toISOString().slice(0, 10);

  await page.locator(`a[data-date="${nextDay}"]`).click();
  await expect(page.locator(`a[data-date="${nextDay}"]`)).toHaveAttribute("aria-current", "date");

  // The day on screen changed...
  expect(await activeDay(page)).toBe(nextDay);
  // ...and the URL followed, so a refresh lands on the same day...
  await expect(page).toHaveURL(new RegExp(`date=${nextDay}`));
  // ...but the page itself was never reloaded.
  expect(
    await page.evaluate(() => (window as unknown as { marker?: string }).marker),
  ).toBe("same-document");
});
