import { expect, test } from "@playwright/test";

/**
 * Visual regression coverage. Only fully deterministic, non-animated
 * surfaces are captured here — no typewriter regions, clocks, or
 * network-fetched content. Baselines live in e2e/visual.spec.ts-snapshots/
 * and are regenerated deliberately with `npm run e2e -- --update-snapshots`
 * after an intentional UI change.
 *
 * Deliberately excluded: the marketing landing page (gsap / lenis /
 * typewriter animation on mount) and authenticated console screens
 * (require a live admin session plus seeded data). The sign-in page is the
 * most stable public surface and the first thing every operator sees.
 */
test.describe("visual regression", () => {
  test.beforeEach(async ({ page }) => {
    // Same font-blocking as the smoke spec: Google Fonts must never make
    // a capture depend on the public internet or its latency.
    await page.route("**/fonts.googleapis.com/**", (route) => route.abort());
    await page.route("**/fonts.gstatic.com/**", (route) => route.abort());
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    // Never focus the token field before capturing — a blinking caret would
    // break pixel determinism.
  });

  test("sign-in page", async ({ page }) => {
    await expect(page).toHaveScreenshot("login.png", { fullPage: true });
  });

  test("sign-in page with empty-token validation error", async ({ page }) => {
    await page.getByRole("button", { name: "Open the console" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveScreenshot("login-validation-error.png", {
      fullPage: true,
    });
  });
});
