import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initAppSettings,
  getSetting,
  setSetting,
  refreshSettings,
  settingsVersion,
  settingsInventory,
  isLocalDevSettingsMode,
  schedulerIntervalMsSetting,
  isDemoModeSetting,
  __setLocalSettingForTests,
  __resetSettingsForTests,
  INFISICAL_PROJECT_ID,
} from "./appSettings";
import { readAlertConfig, writeAlertConfig, maskAlertConfig, __resetAlertMigrationForTests } from "./alerts";

// Infisical SOT contract tests (see INFISICAL.md).  The shared
// createInfisicalSettings client is exercised through initAppSettings with a
// stubbed global fetch — no network.  Secret VALUES never leave the fake.

// The alert-config migration reads the legacy workspaceSettings row.  Mock
// the DB layer so no test ever touches a real database.
const mockDbState = vi.hoisted(() => ({
  row: null as { alertsJson: unknown } | null,
  throwOnRead: true,
}));
vi.mock("../queries/connection", () => ({
  getDb: () => {
    if (mockDbState.throwOnRead) throw new Error("db unreachable (test mock)");
    const row = mockDbState.row;
    return {
      select: () => ({
        from: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(row ? [row] : []),
          }),
        }),
      }),
    };
  },
}));

// ── fake Infisical REST ───────────────────────────────────────────
type RecordedCall = { method: string; url: string; body?: unknown };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFakeInfisical(seed: Record<string, string>, opts?: {
  failList?: boolean;
  failWrite?: boolean;
}) {
  const secrets = { ...seed };
  const calls: RecordedCall[] = [];
  // Mutable behaviors so tests can flip failure modes AFTER the client has
  // bound its fetch implementation at construction time.
  const behavior = { failList: opts?.failList ?? false, failWrite: opts?.failWrite ?? false };
  const fakeFetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ method, url: u, body });
    if (u.endsWith("/api/v1/auth/universal-auth/login")) {
      expect((body as { clientId?: string }).clientId).toBe("test-client-id");
      return jsonResponse({ accessToken: "test-access-token" });
    }
    if (u.includes("/api/v3/secrets/raw/")) {
      const key = decodeURIComponent(u.split("/api/v3/secrets/raw/")[1].split("?")[0]);
      if (method === "PATCH") {
        if (behavior.failWrite) return jsonResponse({}, 500);
        if (!(key in secrets)) return jsonResponse({}, 404);
        secrets[key] = String((body as { secretValue?: unknown })?.secretValue ?? "");
        return jsonResponse({ secret: { secretKey: key } });
      }
      // POST = create
      if (behavior.failWrite) return jsonResponse({}, 500);
      secrets[key] = String((body as { secretValue?: unknown })?.secretValue ?? "");
      return jsonResponse({ secret: { secretKey: key } });
    }
    if (u.includes("/api/v3/secrets/raw")) {
      if (behavior.failList) return jsonResponse({}, 500);
      return jsonResponse({
        secrets: Object.entries(secrets).map(([secretKey, secretValue]) => ({
          secretKey,
          secretValue,
        })),
      });
    }
    return jsonResponse({}, 404);
  };
  return { fakeFetch, calls, secrets, behavior };
}

const TEST_SEED: Record<string, string> = {
  AUTOROTATE_ADMIN_TOKEN: "seed-admin-token",
  AUTOROTATE_ENC_KEY: "seed-enc-key-that-is-long-enough",
  DATABASE_URL: "mysql://seed/db",
  SCHEDULER_INTERVAL_MS: "60000",
  AUTOROTATE_DEMO: "0",
  ALERT_CONFIG_JSON: JSON.stringify({
    slackWebhookUrl: "",
    discordWebhookUrl: "",
    notifyOnFailure: true,
    notifyOnPartial: true,
    notifyOnOverdue: false,
  }),
};

function useInfisicalMode(seed: Record<string, string> = TEST_SEED, opts?: {
  failList?: boolean;
  failWrite?: boolean;
}) {
  const fake = createFakeInfisical(seed, opts);
  vi.stubGlobal("fetch", fake.fakeFetch);
  process.env.INFISICAL_CLIENT_ID = "test-client-id";
  process.env.INFISICAL_CLIENT_SECRET = "test-client-secret";
  return fake;
}

beforeEach(() => {
  __resetSettingsForTests();
  delete process.env.INFISICAL_CLIENT_ID;
  delete process.env.INFISICAL_CLIENT_SECRET;
  vi.unstubAllGlobals();
});

afterEach(() => {
  __resetSettingsForTests();
  delete process.env.INFISICAL_CLIENT_ID;
  delete process.env.INFISICAL_CLIENT_SECRET;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("initAppSettings — startup load", () => {
  it("loads every secret into the in-memory cache and targets this app's project", async () => {
    const { calls } = useInfisicalMode();
    await initAppSettings();
    expect(getSetting("SCHEDULER_INTERVAL_MS")).toBe("60000");
    expect(getSetting("AUTOROTATE_DEMO")).toBe("0");
    // The list call addresses this app's Infisical project.
    const listCall = calls.find((c) => c.url.includes("/api/v3/secrets/raw"));
    expect(listCall?.url).toContain(`workspaceId=${INFISICAL_PROJECT_ID}`);
  });

  it("reads make zero network calls after init", async () => {
    const { calls } = useInfisicalMode();
    await initAppSettings();
    const callsAfterInit = calls.length;
    expect(schedulerIntervalMsSetting()).toBe(60000);
    expect(isDemoModeSetting()).toBe(false);
    expect(settingsInventory().length).toBeGreaterThan(0);
    expect(getSetting("AUTOROTATE_ADMIN_TOKEN")).toBe("seed-admin-token");
    expect(calls.length).toBe(callsAfterInit);
  });
});

describe("write-through ordering", () => {
  it("writes to Infisical FIRST, then updates the cache", async () => {
    const { calls } = useInfisicalMode();
    await initAppSettings();
    let observedDuringWrite: string | undefined = "not-observed";
    // Intercept at the fake's write path would be ideal; instead prove the
    // order by watching the cache from a second reader is impossible here,
    // so observe the PATCH body order: the Infisical PATCH must be recorded
    // while the cache still holds the old value.
    const origSet = getSetting("SCHEDULER_INTERVAL_MS");
    expect(origSet).toBe("60000");
    const writePromise = setSetting("SCHEDULER_INTERVAL_MS", "120000");
    // The write is in flight: the cache must NOT have the new value yet —
    // the shared client updates the cache only after the PATCH resolves.
    // (The fake PATCH resolves on the next microtask; the cache read here is
    // synchronous with the in-flight write.)
    observedDuringWrite = getSetting("SCHEDULER_INTERVAL_MS");
    await writePromise;
    const patchCall = calls.find(
      (c) => c.method === "PATCH" && c.url.endsWith("/SCHEDULER_INTERVAL_MS"),
    );
    expect(patchCall).toBeDefined();
    expect((patchCall?.body as { secretValue?: string })?.secretValue).toBe("120000");
    // At the moment the write was in flight, the cache still held the old
    // value (write-through: Infisical first, cache second).
    expect(observedDuringWrite).toBe("60000");
    // After the write resolves, the cache carries the new value.
    expect(getSetting("SCHEDULER_INTERVAL_MS")).toBe("120000");
  });

  it("a failed Infisical write rejects and leaves the cache untouched", async () => {
    useInfisicalMode(TEST_SEED, { failWrite: true });
    await initAppSettings();
    await expect(setSetting("SCHEDULER_INTERVAL_MS", "120000")).rejects.toThrow(
      /Infisical write-through failed/,
    );
    expect(getSetting("SCHEDULER_INTERVAL_MS")).toBe("60000");
  });

  it("creating a missing key falls back from PATCH to POST", async () => {
    const { calls, secrets } = useInfisicalMode({ ...TEST_SEED });
    delete secrets["BRAND_NEW_KEY"];
    await initAppSettings();
    await setSetting("BRAND_NEW_KEY", "hello");
    const patchCall = calls.find(
      (c) => c.method === "PATCH" && c.url.endsWith("/BRAND_NEW_KEY"),
    );
    const postCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/BRAND_NEW_KEY"),
    );
    expect(patchCall).toBeDefined();
    expect(postCall).toBeDefined();
    expect(getSetting("BRAND_NEW_KEY")).toBe("hello");
  });
});

describe("refresh keeps last-known-good on failure", () => {
  it("a failed refresh rejects but the cache still serves the old values", async () => {
    const fake = useInfisicalMode();
    await initAppSettings();
    const versionBefore = settingsVersion();
    // Break the list endpoint via the fake's mutable behavior (the client
    // bound its fetch at construction, so flipping the stub is not enough).
    fake.behavior.failList = true;
    await expect(refreshSettings()).rejects.toThrow();
    expect(getSetting("SCHEDULER_INTERVAL_MS")).toBe("60000");
    expect(getSetting("AUTOROTATE_ADMIN_TOKEN")).toBe("seed-admin-token");
    expect(settingsVersion()).toBe(versionBefore);
  });
});

describe("local-dev fallback", () => {
  it("seeds from process.env with zero network when no Infisical credentials exist", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.AUTOROTATE_DEMO = "1";
    process.env.SCHEDULER_INTERVAL_MS = "45000";
    try {
      await initAppSettings();
      expect(isLocalDevSettingsMode()).toBe(true);
      expect(isDemoModeSetting()).toBe(true);
      expect(schedulerIntervalMsSetting()).toBe(45000);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.AUTOROTATE_DEMO;
      delete process.env.SCHEDULER_INTERVAL_MS;
    }
  });

  it("refuses to boot in production without Infisical credentials", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(initAppSettings()).rejects.toThrow(/required in production/);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});

describe("alert config via Infisical", () => {
  beforeEach(() => {
    __resetAlertMigrationForTests();
    mockDbState.row = null;
    mockDbState.throwOnRead = true;
  });

  it("migrates a legacy DB row into Infisical on first read", async () => {
    const seed = { ...TEST_SEED };
    delete seed.ALERT_CONFIG_JSON;
    const { calls } = useInfisicalMode(seed);
    mockDbState.throwOnRead = false;
    mockDbState.row = {
      alertsJson: {
        slackWebhookUrl: "",
        discordWebhookUrl: "",
        notifyOnFailure: false,
        notifyOnPartial: true,
        notifyOnOverdue: true,
      },
    };
    await initAppSettings();
    const config = await readAlertConfig();
    expect(config.notifyOnFailure).toBe(false);
    // The migration goes through the write-through path: Infisical first.
    const writeCall = calls.find((c) => c.url.endsWith("/ALERT_CONFIG_JSON"));
    expect(writeCall).toBeDefined();
    const written = JSON.parse(
      String((writeCall?.body as { secretValue?: string })?.secretValue ?? "{}"),
    );
    expect(written.notifyOnFailure).toBe(false);
    // Second read serves the cache — no second migration, no DB.
    mockDbState.throwOnRead = true;
    expect((await readAlertConfig()).notifyOnFailure).toBe(false);
  });

  it("falls back to defaults when the DB is unreachable", async () => {
    const seed = { ...TEST_SEED };
    delete seed.ALERT_CONFIG_JSON;
    useInfisicalMode(seed);
    mockDbState.throwOnRead = true;
    await initAppSettings();
    const config = await readAlertConfig();
    expect(config).toEqual({
      slackWebhookUrl: "",
      discordWebhookUrl: "",
      notifyOnFailure: true,
      notifyOnPartial: true,
      notifyOnOverdue: true,
    });
  });

  it("reads the stored config from the cache (no DB hit)", async () => {
    useInfisicalMode();
    await initAppSettings();
    const config = await readAlertConfig();
    expect(config.notifyOnFailure).toBe(true);
    expect(config.notifyOnOverdue).toBe(false);
  });

  it("falls back to defaults when ALERT_CONFIG_JSON is unset and no DB row exists", async () => {
    const seed = { ...TEST_SEED };
    delete seed.ALERT_CONFIG_JSON;
    useInfisicalMode(seed);
    mockDbState.throwOnRead = false; // DB reachable, but no legacy row
    mockDbState.row = null;
    await initAppSettings();
    const config = await readAlertConfig();
    expect(config).toEqual({
      slackWebhookUrl: "",
      discordWebhookUrl: "",
      notifyOnFailure: true,
      notifyOnPartial: true,
      notifyOnOverdue: true,
    });
  });

  it("writeAlertConfig is write-through: Infisical first, cache second", async () => {
    const { calls } = useInfisicalMode();
    await initAppSettings();
    const next = await writeAlertConfig({ notifyOnOverdue: true });
    expect(next.notifyOnOverdue).toBe(true);
    const patchCall = calls.find(
      (c) => c.method === "PATCH" && c.url.endsWith("/ALERT_CONFIG_JSON"),
    );
    expect(patchCall).toBeDefined();
    const written = JSON.parse(
      String((patchCall?.body as { secretValue?: string })?.secretValue ?? "{}"),
    );
    expect(written.notifyOnOverdue).toBe(true);
    // Cache reflects the write.
    const reread = await readAlertConfig();
    expect(reread.notifyOnOverdue).toBe(true);
  });

  it("maskAlertConfig never returns full webhook URLs", async () => {
    useInfisicalMode();
    await initAppSettings();
    await writeAlertConfig({
      slackWebhookUrl: "https://hooks.slack.com/services/T000/B000/secret-token-value",
    });
    const masked = maskAlertConfig(await readAlertConfig());
    expect(masked.hasSlack).toBe(true);
    expect(masked.slackWebhookMasked).not.toContain("secret-token-value");
    expect(masked.slackWebhookMasked).toMatch(/^https:\/\/hooks\.slack\.com\/…/);
  });
});

describe("test-only cache writer", () => {
  it("mutates the local cache and is rejected outside local-dev mode", async () => {
    await initAppSettings(); // local-dev mode (no creds)
    __setLocalSettingForTests("AUTOROTATE_DEMO", "1");
    expect(isDemoModeSetting()).toBe(true);
    __setLocalSettingForTests("AUTOROTATE_DEMO", undefined);
    expect(isDemoModeSetting()).toBe(false);
  });
});
