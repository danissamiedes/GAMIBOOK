import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/** A 1×1 PNG. Enough to prove the pipe; the bytes are never inspected. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("a venue uploads a payment QR and a booker sees it", async ({ page }) => {
  test.setTimeout(180_000);

  // ---- Upload it ------------------------------------------------------
  await signIn(page, "owner@example.com");
  await page.goto("/dashboard");
  const switcher = page.getByLabel("Active company");
  await switcher.selectOption({ label: "THE PICKLE FARM (PHP)" });
  await page.waitForLoadState("networkidle");

  await page.goto("/bookings/settings");
  await expect(page.getByText("Payment QR")).toBeVisible();
  await page.locator('input[name="paymentQr"]').setInputFiles({
    name: "gcash-qr.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved.")).toBeVisible({ timeout: 20000 });

  // It comes back as a preview, served from the same public route the booker
  // uses — so a broken image here would be a broken image there.
  const preview = page.locator('img[alt="The payment QR shown to bookers"]');
  await expect(preview).toBeVisible();
  const previewSrc = await preview.getAttribute("src");
  expect(previewSrc).toBeTruthy();
  const previewStatus = await page.evaluate(
    async (src: string) => (await fetch(src)).status,
    previewSrc!,
  );
  expect(previewStatus).toBe(200);

  // ---- A booker sees it ------------------------------------------------
  await page.context().clearCookies();
  await page.goto("/book/the-pickle-farm");

  const grid = page.locator("table");
  await grid.locator("tbody tr").nth(2).locator("td").nth(1).locator("a").click();
  await expect(page.getByText("1 slot", { exact: true })).toBeVisible();
  await page.locator('input[name="customerName"]').fill("QR Tester");
  await page.locator('input[name="customerEmail"]').fill("qr@example.com");
  await page.getByRole("button", { name: "Hold this slot" }).click();

  await expect(page).toHaveURL(/\/book\/the-pickle-farm\/[A-Z0-9-]+$/, { timeout: 20000 });
  const qr = page.locator('img[alt="Scan this QR code to pay"]');
  await expect(qr).toBeVisible();
  await expect(page.getByText("Scan to pay")).toBeVisible();
  // The amount is on the pay panel too, so nobody has to scroll up for it.
  await expect(page.getByText("Amount to pay:")).toBeVisible();

  // The image really loads rather than rendering as a broken icon.
  expect(await qr.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

  await page.screenshot({ path: "/tmp/claude-0/-home-user-GAMIBOOK/be7517e0-545d-576f-9716-dd3de778d1b9/scratchpad/qr-booker.png", fullPage: true });
});

test("the QR is not served for an unpublished venue", async ({ page }) => {
  // An unpublished venue gives nothing away, including its payment details.
  const response = await page.request.get("/book/no-such-venue/qr");
  expect(response.status()).toBe(404);
});
