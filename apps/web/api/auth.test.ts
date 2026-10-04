import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  SESSION_COOKIE,
  sessionTtlMs,
  createSession,
  verifySession,
  verifyAdminToken,
  readSessionCookie,
  sessionCookie,
  clearedSessionCookie,
} from "./auth";
import {
  initAppSettings,
  __setLocalSettingForTests,
  __resetSettingsForTests,
} from "./autorotate/appSettings";

// AR-01 regression tests. The console had no authentication of any kind, so
// these assert the primitives the session cookie rests on.
//
// Infisical SOT: the admin token now comes from the settings cache.  Tests
// run in local-dev mode (no INFISICAL credentials) and seed the token via
// the test-only cache writer — never via process.env.

const TEST_TOKEN = "test-admin-token-3f9c2a";

beforeAll(async () => {
  delete process.env.INFISICAL_CLIENT_ID;
  delete process.env.INFISICAL_CLIENT_SECRET;
  await initAppSettings();
  __setLocalSettingForTests("AUTOROTATE_ADMIN_TOKEN", TEST_TOKEN);
});

afterAll(() => {
  __resetSettingsForTests();
});

describe("session round-trip", () => {
  it("accepts a session it just minted", () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 0);
    expect(verifySession(createSession(now), now + 1000)).toBe(true);
  });

  it("rejects an expired session", () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 0);
    const session = createSession(now);
    expect(verifySession(session, now + sessionTtlMs() - 1)).toBe(true);
    expect(verifySession(session, now + sessionTtlMs() + 1)).toBe(false);
  });

  it("rejects a tampered expiry, a tampered signature, and junk", () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 0);
    const session = createSession(now);
    const [exp, sig] = session.split(".");

    // Extending the expiry without the key must not validate.
    expect(verifySession(`${Number(exp) + 60_000}.${sig}`, now)).toBe(false);
    // Flipping one signature character must not validate.
    const flipped = sig[0] === "a" ? `b${sig.slice(1)}` : `a${sig.slice(1)}`;
    expect(verifySession(`${exp}.${flipped}`, now)).toBe(false);

    expect(verifySession("", now)).toBe(false);
    expect(verifySession(null, now)).toBe(false);
    expect(verifySession("not-a-session", now)).toBe(false);
    expect(verifySession(`${exp}.`, now)).toBe(false);
    expect(verifySession(`.${sig}`, now)).toBe(false);
  });

  it("does not validate a session minted under a different admin token", () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 0);
    const session = createSession(now);
    __setLocalSettingForTests("AUTOROTATE_ADMIN_TOKEN", "a-different-admin-token");
    try {
      expect(verifySession(session, now)).toBe(false);
    } finally {
      __setLocalSettingForTests("AUTOROTATE_ADMIN_TOKEN", TEST_TOKEN);
    }
  });
});

describe("verifyAdminToken", () => {
  it("accepts only the exact configured token", () => {
    expect(verifyAdminToken(TEST_TOKEN)).toBe(true);
    expect(verifyAdminToken(`${TEST_TOKEN} `)).toBe(false);
    expect(verifyAdminToken(TEST_TOKEN.slice(0, -1))).toBe(false);
    expect(verifyAdminToken("")).toBe(false);
  });
});

describe("cookie plumbing", () => {
  it("emits an HttpOnly, SameSite=Strict, path-scoped cookie", () => {
    const cookie = sessionCookie(createSession());
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${sessionTtlMs() / 1000}`);
  });

  it("clears with Max-Age=0", () => {
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });

  it("reads the session out of a multi-cookie header", () => {
    expect(readSessionCookie(`theme=dark; ${SESSION_COOKIE}=abc.def; other=1`)).toBe("abc.def");
    expect(readSessionCookie("theme=dark")).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
  });
});
