import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (SPEC §13: "Playwright for a handful of end-to-end flows").
 *
 * Deliberately a handful. Vitest covers the ledger, the reports and the
 * services against a real database; what only a browser can answer is whether
 * a keystroke lands where the typist expects and whether a screen is usable on
 * a phone. Anything provable without a browser stays in Vitest, which is
 * faster and easier to debug.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  timeout: 60_000,
  use: {
    // localhost, not 127.0.0.1: `next dev` blocks its own client chunks as a
    // cross-origin request from the numeric host, so the page loads but never
    // hydrates and every interaction test quietly measures dead HTML.
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        // The image ships a Chromium that may not match the version this
        // Playwright release would download; point at the one that is here.
        launchOptions: {
          executablePath:
            process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
        },
      },
    },
    {
      name: "phone",
      use: {
        ...devices["Pixel 7"],
        launchOptions: {
          executablePath:
            process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
        },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    // AUTH_URL in .env points at the developer's own port; without overriding
    // it here, signing in redirects to that port instead of this one and every
    // test fails on a connection refused that looks nothing like its cause.
    env: { AUTH_URL: `http://localhost:${PORT}` },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
