import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { initSentryServer } from "./lib/sentry";
import { adminToken } from "./auth";
import { startScheduler } from "./autorotate/scheduler";
import {
  initAppSettings,
  refreshSettings,
  schedulerEnabledSetting,
  schedulerIntervalMsSetting,
  rateLimitWindowMsSetting,
  rateLimitMaxSetting,
} from "./autorotate/appSettings";

// Infisical SOT: load every app-level setting into the in-memory cache before
// anything else reads it.  In production this fails fast when required keys
// are missing or the Infisical bootstrap credentials are absent.
await initAppSettings();

// On-demand settings refresh: `kill -SIGHUP <pid>`.
process.on("SIGHUP", () => {
  void refreshSettings().catch((err) => {
    console.error("[app-settings] SIGHUP refresh failed:", (err as Error).message);
  });
});

initSentryServer();

// Mint (and print) the development admin token at boot rather than on the
// first login attempt, so it is in the same log block as the startup banner.
adminToken();

// AR-19: the scheduler rotates live credentials.  Under `vite dev` it used to
// start at import time, so a developer pointed at a shared database rotated
// production secrets from their laptop.  Opt in explicitly outside production.
if (schedulerEnabledSetting()) {
  startScheduler(schedulerIntervalMsSetting());
} else {
  console.log(
    "[autorotate scheduler] disabled outside production — set AUTOROTATE_SCHEDULER=1 in Infisical to enable",
  );
}

const app = new Hono<{ Bindings: HttpBindings }>();

// ── Security headers (AR-21) ────────────────────────────────────
// vercel.json sets four of these at the Vercel edge, which does not cover the
// Hono/Node server that serves /api/trpc/* under `npm start`.  These apply to
// every response this process emits, API and static site alike.
//
// CSP notes: index.html carries no inline script, so script-src stays
// 'self'.  'unsafe-inline' is required for style-src because the design
// system (and framer-motion/gsap) set inline style attributes.  The two
// Google Fonts hosts are allowed because index.html links a Google Fonts
// stylesheet, which in turn pulls font files from fonts.gstatic.com — those
// are the only external stylesheet/font origins the frontend uses.  Sentry
// ingest hosts are allowed on connect-src when VITE_SENTRY_DSN is set.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self'",
  "connect-src 'self' https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.sentry.io",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Content-Security-Policy", CSP);
  if (env.isProduction) {
    c.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
});

// ── Request limits (AR-21) ──────────────────────────────────────
// 1 MB is generous for a tRPC payload; the previous 50 MB global limit paired
// with an unauthenticated full-table audit scan was a plain DoS path.
app.use("/api/*", bodyLimit({ maxSize: 1024 * 1024 }));

// In-memory, per-process fixed-window rate limiter.  Deliberately simple: it
// blunts scripted abuse of a single replica.  A multi-replica deployment
// wanting a global budget needs a shared store or an edge rule.  Window and
// max are tunable via Infisical (RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX).
const rateLimitWindowMs = rateLimitWindowMsSetting();
const rateLimitMax = rateLimitMaxSetting();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Best-effort client IP: x-forwarded-for first hop (later hops are
 * attacker-controlled), else the Node socket remote address, else "unknown".
 * Feeds both the per-IP API rate limiter and the per-IP login throttle (F3).
 */
function clientIpOf(c: { req: { header: (name: string) => string | undefined }; env: unknown }): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (c.env as HttpBindings | undefined)?.incoming?.socket?.remoteAddress ?? "unknown";
}

app.use("/api/*", async (c, next) => {
  const now = Date.now();
  const key = clientIpOf(c);
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
  } else if (bucket.count >= rateLimitMax) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: "Too Many Requests" }, 429);
  } else {
    bucket.count++;
  }
  // Bounded cleanup so the map cannot grow without limit.
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) {
      if (v.resetAt <= now) rateBuckets.delete(k);
    }
  }
  return next();
});

// No CORS middleware, deliberately (AR-21): the console is same-origin with
// its API, and the SameSite=Strict session cookie is only safe against CSRF
// while that stays true.  Adding CORS means adding CSRF tokens first.
app.use("/api/trpc/*", async (c) => {
  const clientIp = clientIpOf(c);
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: (opts) => createContext(opts, clientIp),
  });
});
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
