# INFISICAL.md — Sole Source of Truth for Autorotate App-Level Settings

Owner directive (2026-10-03): **Infisical is the sole source of truth** for this app.
"Truth" means secrets AND env variables AND tunable settings knobs — everything
Autorotate's behavior depends on that is not code.  Per-user settings stay in the
app's own store and never go in Infisical.

- **Infisical project:** `Autorotate` (`de442a10-adc1-47c1-88a2-fbc980f8a8df`), environments `dev` / `staging` / `prod`.
- **Server implementation:** `apps/web/api/autorotate/appSettings.ts`, built on the fleet-shared `createInfisicalSettings` module from `@jaywedgeworth22/congress-trading-shared` (`github:Simple-With-Us/congress-trading-shared#semver:^2.7.1`, validated in pilot PR Simple-With-Us/congress-trading-shared#329).
- **Bootstrap:** `NODE_ENV` maps to the Infisical environment (`production`→`prod`, `staging`→`staging`, else `dev`).  The universal-auth credentials `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET` are deployment bootstrap injected by the host (Coolify/Infisical agent) — the one thing that cannot itself come from Infisical.  Production refuses to boot without them; non-production without them runs a local-dev in-memory store seeded from `process.env` (loudly logged, never for production).

## Key inventory

| Key | Kind | Notes |
|---|---|---|
| `AUTOROTATE_ADMIN_TOKEN` | app-level secret | Operator credential for the web console.  Dev: ephemeral token minted at boot when unset. |
| `AUTOROTATE_ENC_KEY` | app-level secret | AES-256-GCM key protecting stored connector admin credentials at rest.  Rotation takes effect without restart (derived-key cache is version-pinned). |
| `DATABASE_URL` | env config (secret-bearing) | MySQL connection string. |
| `APP_ID`, `APP_SECRET` | env config | Platform identifiers. |
| `SENTRY_DSN` | env config (secret) | Server-side Sentry DSN.  Falls back to build-time `VITE_SENTRY_DSN`. |
| `SENTRY_ENV`, `SENTRY_TRACES_SAMPLE_RATE` | env config | Server observability tuning. |
| `AUTOROTATE_FILE_ROOT` | env config | File-target sandbox root.  Empty = platform default (`$HOME/app-engine/autorotate-files/`). |
| `AUTOROTATE_PUBLIC_BASE_URL` | env config | Pairing payload base URL.  Empty = derived from the incoming request. |
| `AUTOROTATE_DEMO` | tunable flag | `"1"`/`"true"` = simulation mode; anything else = real rotations (fail-closed). |
| `AUTOROTATE_SCHEDULER` | tunable flag | Run the rotation scheduler outside production. |
| `SCHEDULER_INTERVAL_MS` | tunable knob | Rotation tick interval (default 60000). |
| `SESSION_TTL_MS` | tunable knob | Console session lifetime (default 43200000 = 12h). |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` | tunable knobs | Per-IP API rate limit (default 60s / 300). |
| `ALERT_TIMEOUT_MS` | tunable knob | Alert webhook POST timeout (default 10000). |
| `OVERDUE_DIGEST_INTERVAL_MS` | tunable knob | Overdue-digest throttle (default 21600000 = 6h). |
| `SETTINGS_REFRESH_INTERVAL_MS` | tunable knob | Background settings refresh cadence (default 300000 = 5min). |
| `ALERT_CONFIG_JSON` | app-level structured config | Workspace alert routing (Slack/Discord webhooks are secret-bearing).  Written as JSON. |

Secret keys are created empty in `dev` and are **to be filled by an admin**; `staging`/`prod` values are set by the admin in the Infisical dashboard, never in code.  No secret values appear in this repo, in logs, or in PR bodies — names and metadata only.

## The runtime contract

1. **Load at startup.**  `initAppSettings()` runs first in `apps/web/api/boot.ts`, loading the full key set into an in-memory cache.  Production boot fails fast naming the missing key and pointing here.
2. **Never fetch per-request.**  Every runtime read (`api/autorotate/demo.ts`, `files.ts`, `crypto.ts`, `auth.ts`, `api/autorotate/alerts.ts`, `api/lib/sentry.ts`, `api/routers/autorotate.ts`, `api/queries/connection.ts` via `api/lib/env.ts`) is a memory-only cache read.  Moving alert config from MySQL to the cache also removed a DB read from every completed rotation run.
3. **Background refresh.**  Every `SETTINGS_REFRESH_INTERVAL_MS` (default 5 minutes) and on demand: `kill -SIGHUP <pid>`, or the admin "Reload Settings" button in the console (Workspace Alert Webhooks modal → `workspace.reloadSettings`).  A failed refresh logs loudly and keeps serving last-known-good — staleness is safer than an outage.
4. **Write-through on admin save.**  Admin changes (`workspace.updateAlerts`, `workspace.setAppSetting`) write to Infisical FIRST, then update the cache; a failed Infisical write fails the save.  `setAppSetting` accepts tunable knobs only — secrets are deliberately excluded and rotate in the Infisical dashboard.

## Admin gating

The console's only credential is the admin token; every procedure in `api/routers/autorotate.ts` (including the settings surface) is a `protectedProcedure` — unauthenticated requests get 403 and the UI is unreachable without a console session.  The settings inventory endpoint (`workspace.settingsInventory`) returns key names + configured/unset only — never values.  Audit entries are appended for alert changes, setting changes (key name only, never the value), and settings reloads.

## Per-user boundary (explicitly out of scope)

The following never go in Infisical — they live in the app's own store:

- **Managed secrets and their rotation policies** (MySQL): the actual credentials Autorotate rotates, per-secret intervals, targets, run history.
- **Connector admin credentials** (MySQL, AES-256-GCM encrypted at rest with `AUTOROTATE_ENC_KEY`): operator-entered credentials for Stripe/Cloudflare/OpenAI/etc.  `AUTOROTATE_ENC_KEY` itself is app-level config (in Infisical); the credentials it protects are per-workspace data (never in Infisical).
- **Infisical rotation-target configs** (MySQL, encrypted): per-target client IDs and client secrets the operator configures for rotation *delivery* — these are managed credentials, not app config.
- **Apple companion apps** (iOS/macOS): per-device settings (Infisical target workspace connection, keychain options, notification prefs, biometrics) stay in UserDefaults/Keychain.  The companion apps hold no universal-auth client secret for this app's settings project; they fetch pairing/console state from the console backend.  Their Sentry DSN is injected at build time from Infisical by CI (see `apple/*/SentryTelemetry.swift`), which is build-time config, not runtime settings.
- **Browser bundle `VITE_*` values**: baked at build time.  The values deployed come from the CI/CD environment (synced from Infisical by the release pipeline); they are not read from Infisical at runtime.
- **Local dev overrides**: documented in `apps/web/.env.example`; never commit real values.

## Rotation notes

- **Rotating a setting value:** change it in the Infisical dashboard — the background refresh picks it up within `SETTINGS_REFRESH_INTERVAL_MS`, or force it with "Reload Settings" / SIGHUP.  `AUTOROTATE_ENC_KEY` rotation takes effect without a restart (the derived-key cache re-derives on the new settings version); previously encrypted rows remain decryptable only under the old key — rotating the encryption key without re-encrypting stored rows makes them unreadable, so treat it as a migration, not a flip.
- **Rotating the admin token** invalidates all outstanding console sessions for free (session keys derive from the token); operators sign in again.
- **Bootstrap credential rotation** (`INFISICAL_CLIENT_ID`/`SECRET`) happens in the host (Coolify/Infisical agent) and needs a process restart to take effect — it is read once at boot.

## Local development

Without `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET` the server starts in local-dev mode: settings seed from `process.env` (see `apps/web/.env.example`), no network calls, admin saves update memory only (warned in logs).  Production with missing bootstrap credentials refuses to boot with a clear error.  Tests run in local-dev mode with a mocked fetch — see `apps/web/api/autorotate/appSettings.test.ts`.
