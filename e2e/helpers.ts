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
