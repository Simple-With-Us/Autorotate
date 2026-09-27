import { expect, test } from "@playwright/test";

/**
 * Smoke coverage for the public web surfaces: routes render, the auth guard
 * redirects, and the sign-in form validates client-side. No backend
 * dependencies beyond the dev server itself — assertions deliberately avoid
 * network-fetched or animated content.
 */
test.describe("public surfaces", () => {
  // The page loads Space Grotesk / Inter / JetBrains Mono from Google
  // Fonts. Block those requests so the suite never depends on the public
  // internet: layout is verified with fallback fonts, deterministically,
  // on every machine.
  test.beforeEach(async ({ page }) => {
    await page.route("**/fonts.googleapis.com/**", (route) => route.abort());
    await page.route("**/fonts.gstatic.com/**", (route) => route.abort());
  });

  test("landing page renders", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Autorotate/);
    await expect(page.locator("#root")).not.toBeEmpty();
  });

  test("sign-in page renders the token form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Admin token")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open the console" }),
    ).toBeVisible();
  });

  test("sign-in rejects an empty token without a server round-trip", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Open the console" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Enter your admin token.",
    );
  });

  test("console routes redirect unauthenticated visitors to /login", async ({
    page,
  }) => {
    // Stub the session endpoint as unauthenticated: this test covers the
    // route guard's redirect, not the API (which has its own vitest
    // suite). It also keeps the test independent of cold dev-server
    // transform latency on the tRPC round-trip.
    await page.route("**/api/trpc/auth.session**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '[{"result":{"data":{"json":{"authenticated":false}}}}]',
      }),
    );
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
