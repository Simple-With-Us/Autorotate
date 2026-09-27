import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright end-to-end suite for the Autorotate web console.
 *
 * Screenshots in e2e/visual.spec.ts are baseline snapshots committed to
 * e2e/visual.spec.ts-snapshots/ — regenerate them deliberately with
 * `npm run e2e -- --update-snapshots` after an intentional UI change, then
 * re-run without the flag to confirm the new baselines hold.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // The marketing landing page runs gsap / lenis / typewriter effects on
    // mount. Freezing CSS-driven animation keeps captures deterministic;
    // the visual spec avoids JS-animated surfaces entirely.
    animations: "disabled",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Run the full Chromium build instead of the headless-shell
        // variant: it is what `npx playwright install chromium` provides
        // in CI, and screenshots must come from the same binary both
        // places.
        launchOptions: { channel: "chromium" },
      },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
