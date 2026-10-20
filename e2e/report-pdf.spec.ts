import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * The report PDFs (SPEC §12). Checked through the real route rather than the
 * renderer, because what breaks an export is usually the plumbing around it
 * — the scope, the query, the headers — and not the drawing.
 */
const REPORTS: [string, string][] = [
  ["/reports/profit-loss", "ProfitAndLoss"],
  ["/reports/profit-loss-monthly", "ProfitAndLossByMonth"],
  ["/reports/balance-sheet", "BalanceSheet"],
];

for (const [path, filename] of REPORTS) {
  test(`${path} exports a PDF`, async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, "owner@example.com");
    await page.goto(path);

    const link = page.getByRole("link", { name: "Export PDF" });
    await expect(link).toBeVisible();

    const response = await page.request.get((await link.getAttribute("href"))!);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/pdf");
    expect(response.headers()["content-disposition"]).toContain(filename);

    const body = await response.body();
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
  });
}

test("the monthly P&L is drawn sideways, because it is a column per month", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");
  await page.goto("/reports/profit-loss-monthly?period=year");

  const href = await page.getByRole("link", { name: "Export PDF" }).getAttribute("href");
  const body = await (await page.request.get(href!)).body();

  // A4 on its side: 841.89pt across by 595.28pt down. Upright, a year of
  // months runs off the edge of the paper.
  const box = /\/MediaBox\s*\[([^\]]*)\]/.exec(body.toString("latin1"));
  const [, , width, height] = box![1].trim().split(/\s+/).map(Number);
  expect(Math.round(width)).toBe(842);
  expect(Math.round(height)).toBe(595);
  expect(width).toBeGreaterThan(height);
});
