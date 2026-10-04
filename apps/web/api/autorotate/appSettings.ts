import "dotenv/config";
import {
  createInfisicalSettings,
  type InfisicalSettings,
} from "@jaywedgeworth22/congress-trading-shared";

// ── Autorotate app-level settings: Infisical sole source of truth ───
// Fleet directive (2026-10-03): Infisical is the sole source of truth for
// app-level configuration — secrets, env config, and tunable settings knobs.
// Per-user settings (managed secrets, connector admin credentials entered by
// the operator, per-secret rotation policies, device pairing state) stay in
// the app's own store (MySQL / Keychain / UserDefaults) and are explicitly
// out of scope here.
//
// The runtime contract (see INFISICAL.md at the repo root):
//   1. initAppSettings() runs once at server boot, loading every key below
//      into an in-memory cache.  Production boot fails fast on missing keys.
//   2. Runtime reads are memory-only — never a network call in a request,
//      tick, or rotation path.
//   3. The cache refreshes on a background interval (tunable via Infisical
//      itself: SETTINGS_REFRESH_INTERVAL_MS) and on demand (SIGHUP handler in
//      boot.ts, admin "Reload settings" tRPC mutation).  A failed refresh
//      logs loudly and keeps serving last-known-good.
//   4. Admin saves are write-through: Infisical FIRST, then the cache; a
//      failed Infisical write fails the save.
//
// Bootstrap note: the universal-auth client credentials (INFISICAL_CLIENT_ID /
// INFISICAL_CLIENT_SECRET) are deployment bootstrap injected by the host
// (Coolify/Infisical agent) — they are the one thing that cannot itself come
// from Infisical.  Without them, production refuses to boot; non-production
// falls back to a local in-memory store seeded from process.env so `npm run
// dev` and CI work with no Infisical access (loudly logged as non-SOT mode).
//
// Sensitivity: this module moves CONFIGURATION only (intervals, policies,
// endpoints, the operator credential, the connector-encryption key).  The
// actual managed credentials Autorotate rotates (connector admin secrets,
// managed secret values, target credentials) are never read into, logged
// from, or written by this module.

/** Infisical project holding Autorotate's app-level configuration. */
export const INFISICAL_PROJECT_ID = "de442a10-adc1-47c1-88a2-fbc980f8a8df";

/**
 * The full key inventory for this app.  Every app-level setting the server
 * reads must be listed here and documented in INFISICAL.md.
 */
export const SETTING_KEYS = [
  // ── app-level secrets ──
  "AUTOROTATE_ADMIN_TOKEN", // operator credential for the web console
  "AUTOROTATE_ENC_KEY", // AES-256-GCM key protecting stored connector credentials
  "DATABASE_URL", // MySQL connection string
  "APP_ID",
  "APP_SECRET",
  "SENTRY_DSN", // server-side Sentry DSN
  // ── env config ──
  "AUTOROTATE_FILE_ROOT", // file-target sandbox root (empty = platform default)
  "AUTOROTATE_PUBLIC_BASE_URL", // pairing payload base URL (empty = request-derived)
  "SENTRY_ENV",
  "SENTRY_TRACES_SAMPLE_RATE",
  // ── tunable flags ──
  "AUTOROTATE_DEMO", // "1"/"true" = simulation mode
  "AUTOROTATE_SCHEDULER", // "1"/"true" = run scheduler outside production
  // ── tunable knobs (intervals in ms unless noted) ──
  "SCHEDULER_INTERVAL_MS",
  "SESSION_TTL_MS",
  "RATE_LIMIT_WINDOW_MS",
  "RATE_LIMIT_MAX", // max requests per window per IP
  "ALERT_TIMEOUT_MS",
  "OVERDUE_DIGEST_INTERVAL_MS",
  "SETTINGS_REFRESH_INTERVAL_MS", // background settings refresh cadence
  // ── app-level structured config (JSON) ──
  "ALERT_CONFIG_JSON", // workspace alert routing; webhook URLs are secrets
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const DEFAULT_REFRESH_INTERVAL_MS = 300_000; // 5 minutes, per the fleet pattern.
const DEFAULT_SCHEDULER_INTERVAL_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 300;
const DEFAULT_ALERT_TIMEOUT_MS = 10_000;
const DEFAULT_OVERDUE_DIGEST_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function infisicalEnvironment(): string {
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === "production") return "prod";
  if (nodeEnv === "staging") return "staging";
  return "dev";
}

function truthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Local-dev settings store: same interface as the Infisical-backed client,
 * seeded from process.env, no network.  Used when no universal-auth
 * credentials are configured outside production.  set() updates memory only
 * and warns — it does not persist to Infisical.
 */
class LocalDevSettings implements InfisicalSettings {
  private cache = new Map<string, string>();

  constructor(seed: Record<string, string | undefined>) {
    for (const [key, value] of Object.entries(seed)) {
      if (value !== undefined) this.cache.set(key, value);
    }
  }

  async init(): Promise<void> {
    /* nothing to load */
  }

  get(key: string): string | undefined {
    return this.cache.get(key);
  }

  getRequired(key: string): string {
    const value = this.cache.get(key);
    if (value === undefined) {
      throw new Error(
        `Missing required app setting "${key}" — see INFISICAL.md.`,
      );
    }
    return value;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(this.cache);
  }

  async set(key: string, value: string): Promise<void> {
    this.cache.set(key, value);
    console.warn(
      `[app-settings] local-dev mode: "${key}" updated in memory only — not persisted to Infisical.`,
    );
  }

  async refresh(): Promise<void> {
    /* nothing to refresh from */
  }

  stop(): void {
    /* no timer */
  }

  /** Test-only escape hatch: mutate the in-memory cache directly. */
  setLocal(key: string, value: string | undefined): void {
    if (value === undefined) this.cache.delete(key);
    else this.cache.set(key, value);
  }
}

let store: InfisicalSettings | LocalDevSettings | null = null;
let localDevMode = false;
let initialized = false;
let version = 0;
const refreshListeners = new Set<() => void>();

function raw(): InfisicalSettings | LocalDevSettings {
  if (!store) {
    throw new Error(
      "appSettings accessed before initAppSettings() — call initAppSettings() at server boot (see INFISICAL.md).",
    );
  }
  return store;
}

/** Call once at server boot.  Idempotent. */
export async function initAppSettings(): Promise<void> {
  if (initialized) return;
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    if (isProduction()) {
      throw new Error(
        "Infisical universal-auth credentials are required in production — set INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET. See INFISICAL.md.",
      );
    }
    const seed: Record<string, string | undefined> = {};
    for (const key of SETTING_KEYS) seed[key] = process.env[key];
    store = new LocalDevSettings(seed);
    localDevMode = true;
    initialized = true;
    version += 1;
    console.warn(
      "[app-settings] INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET not set — local-dev settings mode (seeded from process.env, no Infisical). Not for production.",
    );
    return;
  }
  const options = {
    projectId: INFISICAL_PROJECT_ID,
    environment: infisicalEnvironment(),
    clientId,
    clientSecret,
    ...(process.env.INFISICAL_URL
      ? { infisicalUrl: process.env.INFISICAL_URL }
      : {}),
  };
  let client = createInfisicalSettings(options);
  await client.init();
  // The refresh cadence is itself a tunable knob in Infisical.
  const refreshMs = parsePositiveInt(
    client.get("SETTINGS_REFRESH_INTERVAL_MS"),
    DEFAULT_REFRESH_INTERVAL_MS,
  );
  if (refreshMs !== DEFAULT_REFRESH_INTERVAL_MS) {
    client.stop();
    client = createInfisicalSettings({
      ...options,
      refreshIntervalMs: refreshMs,
    });
    await client.init();
    console.log(
      `[app-settings] background refresh interval set to ${refreshMs}ms from Infisical.`,
    );
  }
  store = client;
  initialized = true;
  version += 1;
  console.log(
    `[app-settings] loaded from Infisical (project ${INFISICAL_PROJECT_ID}, environment "${infisicalEnvironment()}").`,
  );
}

/** True when running on the local-dev in-memory store (never in production). */
export function isLocalDevSettingsMode(): boolean {
  return localDevMode;
}

/**
 * Test-only: write directly into the in-memory cache.  Requires local-dev
 * mode (initAppSettings() with no INFISICAL credentials).  Throws otherwise
 * so tests can never silently mutate production-backed settings.
 */
export function __setLocalSettingForTests(
  key: string,
  value: string | undefined,
): void {
  if (!localDevMode || !(store instanceof LocalDevSettings)) {
    throw new Error(
      "__setLocalSettingForTests requires local-dev settings mode — call initAppSettings() without INFISICAL credentials first.",
    );
  }
  store.setLocal(key, value);
}

/** Test-only: drop module state so a test file can re-initialize. */
export function __resetSettingsForTests(): void {
  store?.stop();
  store = null;
  localDevMode = false;
  initialized = false;
  version = 0;
  refreshListeners.clear();
}

/**
 * Monotonic generation counter, bumped on init, every refresh, and every
 * write-through.  Derived caches (e.g. the scrypt-derived connector
 * encryption key) pin the version they were built from and re-derive when
 * it changes — so a rotated setting takes effect without a restart.
 */
export function settingsVersion(): number {
  return version;
}

/**
 * Register a callback fired after every successful refresh (and after init).
 * Used to invalidate derived caches (e.g. the scrypt-derived connector
 * encryption key) when a rotated value arrives.
 */
export function onSettingsRefresh(listener: () => void): () => void {
  refreshListeners.add(listener);
  return () => {
    refreshListeners.delete(listener);
  };
}

/**
 * On-demand refresh (SIGHUP handler, admin "Reload settings" action).
 * Throws on failure but keeps the last-known-good cache — the shared client
 * handles that internally for background refreshes; here we surface the
 * error so the admin sees it.
 */
export async function refreshSettings(): Promise<void> {
  await raw().refresh();
  version += 1;
  for (const listener of refreshListeners) {
    try {
      listener();
    } catch (err) {
      console.error(
        "[app-settings] refresh listener threw:",
        (err as Error).message,
      );
    }
  }
}

/** Clear the background refresh timer.  Call on shutdown. */
export function stopSettings(): void {
  store?.stop();
}

/** Raw memory-only read.  Never hits the network. */
export function getSetting(key: SettingKey | string): string | undefined {
  return raw().get(key);
}

/** Raw memory-only presence check.  Never hits the network. */
export function hasSetting(key: SettingKey | string): boolean {
  return raw().has(key);
}

/**
 * Required-setting read with the production fail-fast contract: in
 * production a missing/empty value throws naming the key and INFISICAL.md;
 * outside production it returns "" so dev fallbacks (ephemeral admin token,
 * dev passphrase) keep working.
 */
export function requireSetting(key: SettingKey | string): string {
  const value = raw().get(key);
  if (isProduction() && (value === undefined || value === "")) {
    throw new Error(
      `Missing required app setting "${key}" in production (Infisical project ${INFISICAL_PROJECT_ID}). Add it and restart — see INFISICAL.md.`,
    );
  }
  return value ?? "";
}

// ── typed facade ────────────────────────────────────────────────
// Every getter reads the in-memory cache only.  Safe in hot request/tick
// paths.

/** Operator credential for the web console.  "" in dev → ephemeral token. */
export function adminTokenSetting(): string {
  return requireSetting("AUTOROTATE_ADMIN_TOKEN");
}

/** Key protecting stored connector credentials.  "" in dev → dev passphrase. */
export function encryptionKeySetting(): string {
  return requireSetting("AUTOROTATE_ENC_KEY");
}

export function databaseUrlSetting(): string {
  return requireSetting("DATABASE_URL");
}

export function appIdSetting(): string {
  return requireSetting("APP_ID");
}

export function appSecretSetting(): string {
  return requireSetting("APP_SECRET");
}

/** Server Sentry DSN.  Falls back to the build-time VITE_SENTRY_DSN value. */
export function sentryDsnSetting(): string {
  return (
    getSetting("SENTRY_DSN")?.trim() ||
    process.env.VITE_SENTRY_DSN?.trim() ||
    ""
  );
}

export function sentryEnvSetting(): string {
  return (
    getSetting("SENTRY_ENV")?.trim() ||
    process.env.VITE_SENTRY_ENV?.trim() ||
    process.env.NODE_ENV?.trim() ||
    "production"
  );
}

export function sentryTracesSampleRateSetting(): number {
  const rawValue = getSetting("SENTRY_TRACES_SAMPLE_RATE")?.trim() ?? "0.2";
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : 0.2;
}

export function isDemoModeSetting(): boolean {
  return truthyFlag(getSetting("AUTOROTATE_DEMO"));
}

/** File-target sandbox root.  "" → platform default ($HOME/app-engine/…). */
export function fileRootSetting(): string {
  return getSetting("AUTOROTATE_FILE_ROOT")?.trim() ?? "";
}

/** Pairing payload base URL.  "" → derived from the incoming request. */
export function publicBaseUrlSetting(): string {
  return getSetting("AUTOROTATE_PUBLIC_BASE_URL")?.trim() ?? "";
}

export function schedulerEnabledSetting(): boolean {
  return isProduction() || truthyFlag(getSetting("AUTOROTATE_SCHEDULER"));
}

export function schedulerIntervalMsSetting(): number {
  return parsePositiveInt(
    getSetting("SCHEDULER_INTERVAL_MS"),
    DEFAULT_SCHEDULER_INTERVAL_MS,
  );
}

export function sessionTtlMsSetting(): number {
  return parsePositiveInt(getSetting("SESSION_TTL_MS"), DEFAULT_SESSION_TTL_MS);
}

export function rateLimitWindowMsSetting(): number {
  return parsePositiveInt(
    getSetting("RATE_LIMIT_WINDOW_MS"),
    DEFAULT_RATE_LIMIT_WINDOW_MS,
  );
}

export function rateLimitMaxSetting(): number {
  return parsePositiveInt(getSetting("RATE_LIMIT_MAX"), DEFAULT_RATE_LIMIT_MAX);
}

export function alertTimeoutMsSetting(): number {
  return parsePositiveInt(
    getSetting("ALERT_TIMEOUT_MS"),
    DEFAULT_ALERT_TIMEOUT_MS,
  );
}

export function overdueDigestIntervalMsSetting(): number {
  return parsePositiveInt(
    getSetting("OVERDUE_DIGEST_INTERVAL_MS"),
    DEFAULT_OVERDUE_DIGEST_INTERVAL_MS,
  );
}

/** Workspace alert routing config as stored JSON.  "" → defaults. */
export function alertConfigJsonSetting(): string {
  return getSetting("ALERT_CONFIG_JSON") ?? "";
}

/**
 * Write-through save for admin-driven changes: persists to Infisical FIRST,
 * then updates the cache.  Rejects (cache untouched) when the Infisical
 * write fails.
 */
export async function setSetting(
  key: SettingKey | string,
  value: string,
): Promise<void> {
  await raw().set(key, value);
  version += 1;
  for (const listener of refreshListeners) {
    try {
      listener();
    } catch (err) {
      console.error(
        "[app-settings] refresh listener threw:",
        (err as Error).message,
      );
    }
  }
}

/** Non-secret inventory snapshot for the admin surface: names + presence only. */
export function settingsInventory(): { key: string; configured: boolean }[] {
  return SETTING_KEYS.map((key) => ({
    key,
    configured: (raw().get(key) ?? "") !== "",
  }));
}
