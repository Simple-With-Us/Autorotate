/**
 * Sentry Node observability for Autorotate rotation jobs.
 *
 * Gated on SENTRY_DSN (falls back to VITE_SENTRY_DSN).  Inert when unset.
 * Infisical SOT: the server Sentry settings (SENTRY_DSN, SENTRY_ENV,
 * SENTRY_TRACES_SAMPLE_RATE) live in the Autorotate Infisical project and
 * are served from the settings cache — see INFISICAL.md at the repo root.
 * Crash + cron for the 60s scheduler.  Metrics: rotation.success / rotation.fail.
 * Never attach secret material.
 *
 * Release: tagged from VERCEL_GIT_COMMIT_SHA / SOURCE_COMMIT / GITHUB_SHA, see
 * resolveServerRelease() below — same project (autorotate-web) and the same
 * commit-SHA scheme vite.config.ts uses for the browser bundle, so a single
 * deploy's client and server events line up under one release in Sentry.
 */

import * as Sentry from "@sentry/node";
import {
  sentryDsnSetting,
  sentryEnvSetting,
  sentryTracesSampleRateSetting,
} from "../autorotate/appSettings";

let initialized = false;

function stripQuery(url: string | undefined): string | undefined {
  if (!url) return url;
  const cut = url.indexOf("?");
  return cut === -1 ? url : url.slice(0, cut);
}

type ScrubbableEvent = {
  extra?: unknown;
  request?: {
    url?: string;
    method?: string;
    data?: unknown;
    query_string?: unknown;
    cookies?: unknown;
    headers?: unknown;
  };
  breadcrumbs?: Sentry.Breadcrumb[];
};

export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  delete event.extra;
  if (event.request) {
    event.request.url = stripQuery(event.request.url);
    delete event.request.data;
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.headers;
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => ({
      timestamp: b.timestamp,
      category: b.category,
      type: b.type,
      level: b.level,
    }));
  }
  return event;
}

/**
 * Resolve a Sentry release for the running server process.  Precedence: an
 * explicit SENTRY_RELEASE override -> Vercel's VERCEL_GIT_COMMIT_SHA (a
 * System Environment Variable, present at both build and runtime) ->
 * Coolify-style SOURCE_COMMIT -> GitHub Actions' GITHUB_SHA.  Returns
 * undefined (no release tag) when none are set, e.g. plain local dev — the
 * production/CI-deployed paths above always set one of these.  Exported for
 * unit tests; never throws.
 */
export function resolveServerRelease(): string | undefined {
  const sha =
    process.env.SENTRY_RELEASE ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.SOURCE_COMMIT ||
    process.env.GITHUB_SHA;
  return sha ? `autorotate-web@${sha.slice(0, 12)}` : undefined;
}

export function scrubBreadcrumb(
  breadcrumb: Sentry.Breadcrumb,
): Sentry.Breadcrumb {
  return {
    timestamp: breadcrumb.timestamp,
    category: breadcrumb.category,
    type: breadcrumb.type,
    level: breadcrumb.level,
  };
}

export function initSentryServer(): void {
  if (initialized) return;

  // Infisical SOT: DSN, environment and sample rate come from the settings
  // cache (memory-only).  The DSN falls back to the build-time VITE_SENTRY_DSN
  // value when unset — see appSettings.sentryDsnSetting.
  const dsn = sentryDsnSetting();
  if (!dsn) return;

  const env = sentryEnvSetting();

  const tracesSampleRate = sentryTracesSampleRateSetting();

  Sentry.init({
    dsn,
    environment: env,
    release: resolveServerRelease(),
    sendDefaultPii: false,
    tracesSampleRate: Number.isFinite(tracesSampleRate)
      ? Math.min(Math.max(tracesSampleRate, 0), 1)
      : 0.2,
    enableLogs: true,
    beforeSend(event) {
      scrubEvent(event);
      return event;
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(breadcrumb);
    },
  });

  initialized = true;
}

export function sentryServerEnabled(): boolean {
  return initialized;
}

/** Count a finished live rotation.  Dry-runs are ignored.  Never throws. */
export function recordRotationOutcome(
  status: "committed" | "partial" | "failed",
): void {
  if (!initialized) return;
  try {
    if (status === "committed") {
      Sentry.metrics.count("rotation.success", 1);
    } else {
      Sentry.metrics.count("rotation.fail", 1, {
        attributes: { status },
      });
    }
  } catch {
    // Telemetry must never break a rotation.
  }
}

/** Wrap the 60s scheduler tick as a Sentry cron check-in. */
export async function withRotationMonitor<T>(
  fn: () => Promise<T>,
): Promise<T> {
  if (!initialized) return fn();
  return Sentry.withMonitor(
    "autorotate-rotation",
    fn,
    {
      schedule: { type: "interval", value: 1, unit: "minute" },
      checkinMargin: 5,
      maxRuntime: 10,
      timezone: "America/Chicago",
    },
  );
}

export const captureException = Sentry.captureException;
