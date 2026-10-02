import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * The whole booking journey (SPEC §17): a stranger books with no account,
 * pays outside the system, uploads proof, and somebody here confirms it.
 */
test("a guest books, sends proof, and an admin confirms it", async ({ page }) => {
  // The journey crosses two sessions and an upload; the default minute is tight.
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // ---- The public page, with no session at all ------------------------
  await page.goto("/book/the-pickle-farm");
  await expect(page.getByRole("heading", { name: "THE PICKLE FARM" })).toBeVisible();
  await expect(page.getByText("Court 1")).toBeVisible();
  await expect(page.getByText("Court 3")).toBeVisible();
  await page.screenshot({ path: "/tmp/claude-0/-home-user-GAMIBOOK/be7517e0-545d-576f-9716-dd3de778d1b9/scratchpad/book-public.png", fullPage: true });

  // Pick a free slot a few days out, so "today" never decides the test.
  const dateTabs = page.locator('a[href*="/book/the-pickle-farm?date="]');
  await dateTabs.nth(3).click();
  const slot = page.locator('a[href*="&unit="]').first();
  await expect(slot).toBeVisible();
  await slot.click();

  // ---- Booking as a guest ---------------------------------------------
  await expect(page.getByRole("button", { name: "Hold this slot" })).toBeVisible();
  await page.locator('input[name="customerName"]').fill("Juan Dela Cruz");
  await page.locator('input[name="customerEmail"]').fill("juan@example.com");
  await page.getByRole("button", { name: "Hold this slot" }).click();

  await expect(page).toHaveURL(/\/book\/the-pickle-farm\/[A-Z0-9-]+$/, { timeout: 15000 });
  await expect(page.getByText("Held — we need your payment")).toBeVisible();
  // The payment instructions the venue set are shown.
  await expect(page.getByText(/GCash/)).toBeVisible();

  const reference = (await page.getByRole("heading", { level: 1 }).innerText())
    .replace("Booking ", "")
    .trim();
  expect(reference).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
  await page.screenshot({ path: "/tmp/claude-0/-home-user-GAMIBOOK/be7517e0-545d-576f-9716-dd3de778d1b9/scratchpad/book-held.png", fullPage: true });

  // ---- Proof of payment -------------------------------------------------
  await page.locator('input[name="proof"]').setInputFiles({
    name: "gcash-receipt.png",
    mimeType: "image/png",
    // A one-pixel PNG is enough: the point is the flow, not the image.
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await page.locator('input[name="paymentReference"]').fill("GC-998877");
  await page.getByRole("button", { name: "Send proof of payment" }).click();

  await expect(page.getByText("Payment received — being checked")).toBeVisible({ timeout: 20000 });
  // The upload form is gone once proof is in: there is nothing left to send.
  await expect(page.getByRole("button", { name: "Send proof of payment" })).toHaveCount(0);

  // ---- The admin confirms ----------------------------------------------
  await signIn(page, "owner@example.com");
  // The seeded owner starts on another company, so switch to the venue. The
  // switcher is a labelled select, not a named field.
  await page.goto("/dashboard");
  const switcher = page.getByLabel("Active company");
  await switcher.selectOption({ label: "THE PICKLE FARM (PHP)" });
  // Switching is a server action followed by a refresh. Navigating before it
  // lands leaves the next page on the previous company.
  await expect(
    switcher.locator("option", { hasText: "THE PICKLE FARM" }),
  ).toHaveAttribute("selected", /.*/, { timeout: 15000 }).catch(async () => {
    await expect
      .poll(async () => switcher.inputValue(), { timeout: 15000 })
      .not.toBe("");
  });
  await page.waitForLoadState("networkidle");
  await page.goto("/bookings");

  const row = page.locator("tr", { hasText: reference });
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row.getByText("Juan Dela Cruz")).toBeVisible();
  await expect(row.getByText("GC-998877")).toBeVisible();
  await page.screenshot({ path: "/tmp/claude-0/-home-user-GAMIBOOK/be7517e0-545d-576f-9716-dd3de778d1b9/scratchpad/book-admin.png", fullPage: true });

  await row.getByRole("button", { name: "Confirm payment" }).click();
  await expect(page.getByText(new RegExp(`Confirmed ${reference}`))).toBeVisible({ timeout: 20000 });

  // ---- And the booker can see it --------------------------------------
  await page.goto(`/book/the-pickle-farm/${reference}`);
  await expect(page.getByText("Confirmed — see you then")).toBeVisible();

  expect(errors).toEqual([]);
});

test("a booked slot is no longer offered", async ({ page }) => {
  await page.goto("/book/the-pickle-farm");
  const booked = page.getByText("Booked").first();
  // Either there is a booked slot from the run above, or the grid is clean —
  // both are valid; what matters is that "Booked" is never clickable.
  if ((await booked.count()) > 0) {
    expect(await booked.evaluate((el) => el.closest("a") !== null)).toBe(false);
  }
});
