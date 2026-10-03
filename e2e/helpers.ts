import type { Page } from "@playwright/test";

export const SEED_PASSWORD = "ledger-dev-password";

/** Signs in through the real form, so the session is the one the app issues. */
export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(SEED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/**
 * Where the free cells are on a booking grid, as [row, column] pairs.
 *
 * Read off the rendered table rather than hard-coded, because these specs run
 * against a database earlier runs have already booked into: any particular cell
 * may read "Booked" or "Passed" the second time round, and a fixed position
 * turns a passing test into a timeout on a control that is no longer there.
 * A free slot is a button — picking happens in the browser — and column 0 is
 * the time label, so it is never offered.
 */
export async function freeCells(page: Page): Promise<[number, number][]> {
  return page.locator("table").evaluate((table) => {
    const out: [number, number][] = [];
    table.querySelectorAll("tbody tr").forEach((row, rowIndex) => {
      row.querySelectorAll("td").forEach((cell, columnIndex) => {
        if (columnIndex > 0 && cell.querySelector("button")) out.push([rowIndex, columnIndex]);
      });
    });
    return out;
  });
}

/**
 * Three free cells in the shape the venue asked for: two consecutive hours on
 * one unit, plus the later of those hours on a second unit.
 */
export async function multiSlotShape(page: Page): Promise<[number, number][] | null> {
  const free = await freeCells(page);
  const isFree = (row: number, column: number) =>
    free.some(([r, c]) => r === row && c === column);

  for (const [row, column] of free) {
    if (!isFree(row + 1, column)) continue;
    const across = free.find(([r, c]) => r === row + 1 && c !== column);
    if (across) return [[row, column], [row + 1, column], across];
  }
  return null;
}

/**
 * The link behind one of the day tabs on a booking page, by position.
 *
 * Only the day tabs carry `data-date`; the week arrows beside them and the
 * grid cells do not, so this cannot pick up either by accident.
 */
export async function dayHref(page: Page, index: number): Promise<string> {
  const tabs = page.locator("a[data-date]");
  const href = await tabs.nth(index).getAttribute("href");
  if (!href) throw new Error(`No day tab at position ${index}`);
  return href;
}

/** The day the strip is currently showing, as `YYYY-MM-DD`. */
export async function activeDay(page: Page): Promise<string> {
  const active = await page.locator('a[data-date][aria-current="date"]').getAttribute("data-date");
  if (!active) throw new Error("No day is marked active on the strip");
  return active;
}
