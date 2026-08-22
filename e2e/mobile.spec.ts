import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * SPEC §3: no mobile apps, but "the web UI MUST be usable on a phone browser".
 * The time clock is the screen that promise is really about — it is the only
 * screen a consultant ever opens, and they open it standing up.
 *
 * Rather than eyeballing a narrow window, these assert the two failures that
 * make a page unusable on a phone: the body scrolling sideways, and tap
 * targets too small to hit reliably. 44px is Apple's minimum and the one most
 * accessibility guidance settles on.
 */
const MIN_TAP = 44;

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
  });
}

async function smallTargets(page: Page) {
  return page.evaluate((min) => {
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(
        "button, a[href], input:not([type='hidden']), select",
      ),
    );
    return targets
      .filter((element) => {
        const box = element.getBoundingClientRect();
        // Only what is actually on screen and visible.
        if (box.width === 0 && box.height === 0) return false;
        return box.height < min;
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? "").trim().slice(0, 40),
        height: Math.round(element.getBoundingClientRect().height),
      }));
  }, MIN_TAP);
}

test.describe("phone", () => {
  test.skip(({ isMobile }) => !isMobile, "phone viewport only");

  test("the time clock fits the screen and its controls are thumb-sized", async ({
    page,
  }) => {
    await signIn(page, "abigail@example.com");
    // Asserted on the content, not the path: signing in lands on "/", where
    // Next follows the server-side redirect to the time clock internally and
    // leaves the URL alone. What matters is that the consultant sees the clock.
    await expect(page.getByRole("button", { name: /clock (in|out)/i })).toBeVisible();

    const { scrollWidth, clientWidth } = await horizontalOverflow(page);
    expect(scrollWidth, "page scrolls sideways on a phone").toBeLessThanOrEqual(
      clientWidth + 1,
    );

    // The clock in/out button is the whole point of the screen.
    const primary = page
      .getByRole("button", { name: /clock (in|out)/i })
      .first();
    const box = await primary.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TAP);

    expect(await smallTargets(page)).toEqual([]);
  });

  test("the app shell and dashboard do not scroll sideways", async ({
    page,
  }) => {
    await signIn(page, "owner@example.com");
    // Every screen with a table, because that is what overflows. A new screen
    // added without a scroll container should fail here rather than on a phone.
    for (const path of [
      "/dashboard",
      "/invoices",
      "/invoices/recurring",
      "/work-orders",
      "/consultant-bills",
      "/customers",
      "/consultants",
      "/vendors",
      "/expenses",
      "/payments",
      "/sales-orders",
      "/accounts",
      "/items",
      "/journal",
      "/banking",
      "/banking/match",
      "/timesheets",
      "/email-log",
      "/opening-balances",
      "/bill-payments",
      "/work-orders/send",
      "/work-orders/import",
      "/reports/profit-loss",
      "/reports/balance-sheet",
      "/reports/trial-balance",
      "/reports/general-ledger",
      "/reports/ar-aging",
      "/reports/ap-aging",
      "/reports/sales-by-customer",
      "/settings/company",
      "/settings/email",
      "/settings/users",
    ]) {
      await page.goto(path);
      const { scrollWidth, clientWidth } = await horizontalOverflow(page);
      expect(
        scrollWidth,
        `${path} scrolls sideways on a phone`,
      ).toBeLessThanOrEqual(clientWidth + 1);
    }
  });

  test("the nav is reachable without a desktop-width header", async ({
    page,
  }) => {
    await signIn(page, "owner@example.com");
    await page.goto("/dashboard");

    // The nav is grouped, so Invoices lives one tap in rather than on the
    // surface. Reachable is the requirement, not visible-at-rest.
    const invoices = page.getByRole("link", { name: "Invoices", exact: true });
    await expect(invoices).toBeHidden();

    await page.getByRole("button", { name: "Customers" }).tap();
    await expect(invoices).toBeVisible();
    await invoices.tap();
    await expect(page).toHaveURL(/\/invoices$/);

    // And it closes behind you rather than covering the page you asked for.
    await expect(invoices).toBeHidden();
  });
});
