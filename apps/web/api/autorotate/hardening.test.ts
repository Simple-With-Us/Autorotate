import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { isDemoMode } from "./demo";
import {
  initAppSettings,
  __setLocalSettingForTests,
  __resetSettingsForTests,
} from "./appSettings";
import { getConnector } from "./connectors";
import {
  canMintForTargets,
  computeEntryHash,
  verifyChainLink,
  infisicalDeliveryMode,
  maskTargetConfig,
  mergePreservedTargetSecrets,
  sanitizeStepMessage,
  assertPushWebhooksReady,
  TARGET_SECRET_MASK,
  NO_TARGET_REFUSAL,
  RUN_STEP_MESSAGE_CAP,
} from "./engine";
import {
  isForbiddenAddress,
  expandIPv6,
  assertSafeWebhookUrl,
  safeFetch,
  BlockedUrlError,
} from "./netguard";
import { maskWebhookUrl, maskAlertConfig, runOutcomeMessage } from "./alerts";
import { testConnection } from "./connectors";

// Regression tests for the findings in docs/AUDIT-2026-08-26.md. Everything
// here is a pure decision helper or a mocked lookup — no live database.

// node:dns is mocked for the whole file so no test can reach a resolver.
const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({
  lookup: dnsLookup,
  default: { lookup: dnsLookup },
}));

// Infisical SOT: the demo flag comes from the settings cache (memory-only).
// Tests run in local-dev mode and seed it via the test-only cache writer.
beforeAll(async () => {
  delete process.env.INFISICAL_CLIENT_ID;
  delete process.env.INFISICAL_CLIENT_SECRET;
  await initAppSettings();
});

afterAll(() => {
  __resetSettingsForTests();
});

beforeEach(() => {
  __setLocalSettingForTests("AUTOROTATE_DEMO", undefined);
  dnsLookup.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AR-02 — a connector with no credentials must not mint anything", () => {
  it("rejects rotate(null) in real mode instead of returning a fake sk_live_ key", async () => {
    const stripe = getConnector("stripe");
    expect(stripe).toBeDefined();
    await expect(stripe!.rotate(null)).rejects.toThrow(
      /no stored admin credential — connect the platform before rotating/,
    );
  });

  it("applies to every platform, not just the programmatic ones", async () => {
    for (const platform of ["cloudflare", "openai", "twilio", "generic_secret"]) {
      await expect(getConnector(platform)!.rotate(null)).rejects.toThrow(
        /no stored admin credential/,
      );
    }
  });

  it("still simulates when demo mode is explicitly on", async () => {
    __setLocalSettingForTests("AUTOROTATE_DEMO", "1");
    const result = await getConnector("stripe")!.rotate(null);
    expect(result.demo).toBe(true);
    expect(result.value).toMatch(/^sk_live_/);
  });
});

describe("AR-03 — demo mode is opt-in", () => {
  it("is off when the variable is unset, empty, or falsy", () => {
    expect(isDemoMode()).toBe(false);
    for (const value of ["", " ", "0", "false", "no", "off", "yes"]) {
      __setLocalSettingForTests("AUTOROTATE_DEMO", value);
      expect(isDemoMode()).toBe(false);
    }
  });

  it("is on only for an explicit 1/true", () => {
    for (const value of ["1", "true", "TRUE", " true "]) {
      __setLocalSettingForTests("AUTOROTATE_DEMO", value);
      expect(isDemoMode()).toBe(true);
    }
  });
});

describe("AR-06 + AR31-01 — refuse to mint with nowhere to deliver", () => {
  it("refuses a real rotation with zero enabled targets", () => {
    expect(canMintForTargets([], false, "programmatic")).toBe(false);
  });

  it("refuses a real rotation when only a keychain target is enabled", () => {
    // AR31-01: web-side keychain is delegated to the companion app and
    // cannot be verified by the engine — a programmatic connector would
    // still revoke the provider credential and discard the new value.
    expect(
      canMintForTargets(
        [{ kind: "keychain", enabled: true }],
        false,
        "programmatic",
      ),
    ).toBe(false);
  });

  it("refuses a real rotation when every enabled target is keychain", () => {
    expect(
      canMintForTargets(
        [
          { kind: "keychain", enabled: true },
          { kind: "keychain", enabled: true },
        ],
        false,
        "programmatic",
      ),
    ).toBe(false);
  });

  it("allows a real rotation when an infisical target is enabled", () => {
    expect(
      canMintForTargets(
        [
          { kind: "keychain", enabled: true },
          { kind: "infisical", enabled: true },
        ],
        false,
        "programmatic",
      ),
    ).toBe(true);
  });

  it("allows a real rotation when a webhook target is enabled", () => {
    expect(
      canMintForTargets(
        [{ kind: "webhook", enabled: true }],
        false,
        "programmatic",
      ),
    ).toBe(true);
  });

  it("ignores disabled keychain-only targets", () => {
    expect(
      canMintForTargets(
        [{ kind: "keychain", enabled: false }],
        false,
        "programmatic",
      ),
    ).toBe(false);
  });

  it("allows update_only connectors through regardless of targets", () => {
    // update_only never mints — the operator imports the new value, so
    // there is no revocation to worry about.
    expect(canMintForTargets([], false, "update_only")).toBe(true);
    expect(
      canMintForTargets(
        [{ kind: "keychain", enabled: true }],
        false,
        "update_only",
      ),
    ).toBe(true);
  });

  it("allows a dry-run with zero targets — it never mints", () => {
    expect(canMintForTargets([], true)).toBe(true);
  });

  it("keeps the AutorotateCore refusal wording", () => {
    expect(NO_TARGET_REFUSAL).toBe(
      "No enabled target to receive the new value; refusing to rotate.",
    );
  });
});

describe("AR-07 — audit hashes are full width, legacy entries still verify", () => {
  const canonical = {
    ts: "2026-01-01T00:00:00.000Z",
    actor: "web-user",
    action: "rotation.committed",
    secretId: 7,
    detail: { runId: 3 },
  };
  const GENESIS_64 = "0".repeat(64);
  const GENESIS_16 = "0".repeat(16);

  it("computes a 64-character sha256 hex", () => {
    const hash = computeEntryHash(GENESIS_64, canonical);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEntryHash(GENESIS_64, canonical)).toBe(hash);
    expect(computeEntryHash("1".repeat(64), canonical)).not.toBe(hash);
  });

  it("verifies a legacy 16-char genesis entry", () => {
    const legacyHash = computeEntryHash(GENESIS_16, canonical).slice(0, 16);
    expect(
      verifyChainLink({ prevHash: GENESIS_16, entryHash: legacyHash }, canonical, null),
    ).toBe(true);
    expect(
      verifyChainLink({ prevHash: GENESIS_16, entryHash: "deadbeefdeadbeef" }, canonical, null),
    ).toBe(false);
  });

  it("verifies a full-width entry chained onto a legacy predecessor", () => {
    const legacyHash = computeEntryHash(GENESIS_16, canonical).slice(0, 16);
    const nextCanonical = { ...canonical, action: "rotation.partial" };
    const fullHash = computeEntryHash(legacyHash, nextCanonical);
    expect(fullHash).toHaveLength(64);
    expect(
      verifyChainLink(
        { prevHash: legacyHash, entryHash: fullHash },
        nextCanonical,
        legacyHash,
      ),
    ).toBe(true);
  });

  it("rejects a full-width entry whose prevHash does not match its predecessor", () => {
    const first = computeEntryHash(GENESIS_64, canonical);
    const second = computeEntryHash(first, canonical);
    expect(
      verifyChainLink({ prevHash: "0".repeat(64), entryHash: second }, canonical, first),
    ).toBe(false);
  });
});

describe("AR-09 — outbound address guard", () => {
  it("blocks loopback, RFC1918, link-local, CGNAT and unspecified v4", () => {
    for (const ip of [
      "127.0.0.1",
      "127.10.20.30",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.127.255.255",
      "0.0.0.0",
      "255.255.255.255",
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it("blocks the special-purpose v4 blocks added in F14", () => {
    for (const ip of [
      "192.0.0.1", // 192.0.0.0/24 IETF protocol assignments
      "192.0.2.1", // 192.0.2.0/24 TEST-NET-1
      "198.18.0.1", // 198.18.0.0/15 benchmarking
      "198.19.255.255", // 198.18.0.0/15 upper half
      "198.51.100.1", // 198.51.100.0/24 TEST-NET-2
      "203.0.113.1", // 203.0.113.0/24 TEST-NET-3
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it("blocks loopback, link-local and unique-local v6", () => {
    for (const ip of ["::1", "::", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1"]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it("blocks IPv6 transition wrappers around a private v4 (F14)", () => {
    for (const ip of [
      "64:ff9b::10.0.0.1", // NAT64 → 10.0.0.1
      "64:ff9b::a00:1", // same, hex tail
      "64:ff9b:1::10.0.0.1", // 64:ff9b:1::/48 local-use NAT64
      "2002:0a00:0001::", // 6to4 → 10.0.0.1
      "2002:c0a8:0001::", // 6to4 → 192.168.0.1
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it("still allows transition wrappers around a genuinely public v4 (F14)", () => {
    // NAT64 / 6to4 around a public v4 must NOT be over-blocked.
    expect(isForbiddenAddress("64:ff9b::8.8.8.8")).toBe(false); // 8.8.8.8
    expect(isForbiddenAddress("2002:0808:0808::")).toBe(false); // 6to4 → 8.8.8.8
  });

  it("allows public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.63.255.255", "192.169.0.1"]) {
      expect(isForbiddenAddress(ip), ip).toBe(false);
    }
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
      expect(isForbiddenAddress(ip), ip).toBe(false);
    }
  });

  it("treats unparseable input as forbidden", () => {
    expect(isForbiddenAddress("not-an-ip")).toBe(true);
    expect(isForbiddenAddress("")).toBe(true);
  });

  it("expands compressed and IPv4-embedded v6 forms", () => {
    expect(expandIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(expandIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6("2606:4700:4700::1111")).toEqual([
      0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111,
    ]);
    expect(expandIPv6("::ffff:192.168.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0001]);
    expect(expandIPv6("fe80::1%en0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6("1.2.3.4")).toBeNull();
    expect(expandIPv6("gggg::1")).toBeNull();
  });
});

describe("AR-09 — webhook URL validation", () => {
  it("rejects any non-https scheme before touching DNS", async () => {
    await expect(assertSafeWebhookUrl("http://example.com/hook")).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(assertSafeWebhookUrl("ftp://example.com/hook")).rejects.toThrow(/https/);
    await expect(assertSafeWebhookUrl("file:///etc/passwd")).rejects.toThrow(/https/);
    await expect(assertSafeWebhookUrl("not a url")).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("rejects embedded credentials", async () => {
    await expect(
      assertSafeWebhookUrl("https://user:pass@example.com/hook"),
    ).rejects.toThrow(/userinfo/);
  });

  it("rejects private IP literals without a lookup", async () => {
    await expect(assertSafeWebhookUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /private, loopback or link-local/,
    );
    await expect(assertSafeWebhookUrl("https://[::1]:8443/hook")).rejects.toThrow(
      /private, loopback or link-local/,
    );
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname that resolves into a private range", async () => {
    dnsLookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    await expect(assertSafeWebhookUrl("https://internal.example.com/hook")).rejects.toThrow(
      /resolves to a private, loopback or link-local address/,
    );
  });

  it("rejects localhost by resolution rather than by name", async () => {
    dnsLookup.mockResolvedValue([
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(assertSafeWebhookUrl("https://localhost/hook")).rejects.toThrow(
      /resolves to a private, loopback or link-local address/,
    );
  });

  it("rejects a host with one public and one private answer", async () => {
    dnsLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.5", family: 4 },
    ]);
    await expect(assertSafeWebhookUrl("https://rebind.example.com/hook")).rejects.toThrow(
      /resolves to a private, loopback or link-local address/,
    );
  });

  it("accepts a hostname that resolves to a public address", async () => {
    dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = await assertSafeWebhookUrl("https://hooks.example.com/services/abc");
    expect(url.hostname).toBe("hooks.example.com");
  });

  it("rejects a hostname that does not resolve at all", async () => {
    dnsLookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertSafeWebhookUrl("https://nope.example.com/hook")).rejects.toThrow(
      /could not be resolved/,
    );
  });
});

describe("AR-09 / AR-16 — alert config is masked and payloads carry no secret material", () => {
  it("masks a stored webhook to scheme, host and last four characters", () => {
    expect(maskWebhookUrl("https://hooks.slack.com/services/T000/B000/XyZ9")).toBe(
      "https://hooks.slack.com/…XyZ9",
    );
    expect(maskWebhookUrl("")).toBeNull();
    expect(maskWebhookUrl(null)).toBeNull();
    expect(maskWebhookUrl("not-a-url")).toBeNull();
  });

  it("returns the masked shape and never the raw URLs", () => {
    const masked = maskAlertConfig({
      slackWebhookUrl: "https://hooks.slack.com/services/T000/B000/XyZ9",
      discordWebhookUrl: "",
      notifyOnFailure: true,
      notifyOnPartial: false,
      notifyOnOverdue: true,
    });
    expect(masked).toEqual({
      hasSlack: true,
      hasDiscord: false,
      slackWebhookMasked: "https://hooks.slack.com/…XyZ9",
      discordWebhookMasked: null,
      notifyOnFailure: true,
      notifyOnPartial: false,
      notifyOnOverdue: true,
    });
    expect(JSON.stringify(masked)).not.toContain("T000/B000");
  });

  it("builds an alert message from name, status, run id and time only", () => {
    const message = runOutcomeMessage({
      runId: 142,
      secretName: "STRIPE_SECRET_KEY",
      status: "failed",
      at: new Date("2026-08-26T10:11:12.000Z"),
    });
    expect(message).toBe(
      "[Autorotate] Rotation failed: STRIPE_SECRET_KEY — run #142 at 2026-08-26T10:11:12.000Z",
    );
    expect(message).not.toMatch(/sk_|fingerprint/i);
  });
});

describe("AR-10 — AWS IAM is registered honestly", () => {
  it("is update_only, not programmatic", () => {
    expect(getConnector("aws_iam")?.capability).toBe("update_only");
  });

  it("throws MANUAL_ROTATION_REQUIRED instead of inventing an AKIA key", async () => {
    await expect(getConnector("aws_iam")!.rotate({ userName: "svc" })).rejects.toThrow(
      /MANUAL_ROTATION_REQUIRED/,
    );
  });
});

describe("F1 — safeFetch refuses redirects to internal hosts", () => {
  it("rejects a 3xx response instead of following it", async () => {
    dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(null, {
          status: 307,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
      );
    await expect(
      safeFetch("https://hooks.example.com/x", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/refused to follow redirect/);
    // The redirect was NOT followed — fetch was called exactly once, for the
    // original (validated) URL, with redirect handling forced to manual.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("returns a non-redirect response unchanged", async () => {
    dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await safeFetch("https://hooks.example.com/x");
    expect(res.status).toBe(200);
  });

  it("rejects a private destination before any fetch happens", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(safeFetch("https://169.254.169.254/")).rejects.toBeInstanceOf(BlockedUrlError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("F4 — real-mode Infisical delivery requires complete credentials", () => {
  it("rejects an empty or partial config when demo mode is off", () => {
    expect(infisicalDeliveryMode({})).toBe("reject");
    expect(infisicalDeliveryMode(null)).toBe("reject");
    expect(infisicalDeliveryMode({ clientId: "a" })).toBe("reject");
    expect(infisicalDeliveryMode({ clientId: "a", clientSecret: "b" })).toBe("reject");
  });

  it("delivers only when clientId, clientSecret and workspaceId are all present", () => {
    expect(
      infisicalDeliveryMode({ clientId: "a", clientSecret: "b", workspaceId: "c" }),
    ).toBe("deliver");
  });

  it("simulates only when AUTOROTATE_DEMO is explicitly on", () => {
    __setLocalSettingForTests("AUTOROTATE_DEMO", "1");
    expect(infisicalDeliveryMode({})).toBe("simulate");
    expect(
      infisicalDeliveryMode({ clientId: "a", clientSecret: "b", workspaceId: "c" }),
    ).toBe("simulate");
  });
});

describe("F9 — maskTargetConfig redacts secrets, keeps display fields", () => {
  it("redacts clientSecret/password/token and every header value", () => {
    const masked = maskTargetConfig({
      clientId: "id-123",
      clientSecret: "super-secret",
      workspaceId: "ws-9",
      environment: "prod",
      secretPath: "/",
      secretName: "API_KEY",
      password: "pw",
      token: "tok",
      url: "https://hooks.example.com/x",
      headers: { Authorization: "Bearer abc123", "X-Trace": "on" },
      service: "svc",
      account: "acct",
    })!;
    // Display fields survive.
    expect(masked.clientId).toBe("id-123");
    expect(masked.environment).toBe("prod");
    expect(masked.secretName).toBe("API_KEY");
    expect(masked.url).toBe("https://hooks.example.com/x");
    expect(masked.service).toBe("svc");
    expect(masked.account).toBe("acct");
    // Secret fields are redacted.
    expect(masked.clientSecret).not.toBe("super-secret");
    expect(masked.password).not.toBe("pw");
    expect(masked.token).not.toBe("tok");
    // Header names survive, values are redacted.
    const headers = masked.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(["Authorization", "X-Trace"]);
    expect(headers.Authorization).not.toBe("Bearer abc123");
    // Nothing sensitive survives serialization.
    const json = JSON.stringify(masked);
    expect(json).not.toContain("super-secret");
    expect(json).not.toContain("Bearer abc123");
    expect(json).not.toContain('"pw"');
  });

  it("leaves empty/unset secret fields untouched so the UI shows 'not set'", () => {
    const masked = maskTargetConfig({ clientSecret: "", token: undefined, path: "x/.env" })!;
    expect(masked.clientSecret).toBe("");
    expect(masked.token).toBeUndefined();
    expect(masked.path).toBe("x/.env");
  });

  it("returns null for a null/undefined config", () => {
    expect(maskTargetConfig(null)).toBeNull();
    expect(maskTargetConfig(undefined)).toBeNull();
  });
});

describe("mergePreservedTargetSecrets — edit must not wipe stored creds", () => {
  it("restores clientSecret when the wizard omits it", () => {
    const existing = {
      clientId: "id",
      clientSecret: "super-secret",
      workspaceId: "ws",
      environment: "prod",
      secretPath: "/",
    };
    const incoming = {
      clientId: "id",
      workspaceId: "ws",
      environment: "prod",
      secretPath: "/apps",
    };
    expect(mergePreservedTargetSecrets(existing, incoming)).toEqual({
      ...incoming,
      clientSecret: "super-secret",
    });
  });

  it("does not persist the mask as the live clientSecret", () => {
    const existing = { clientId: "id", clientSecret: "super-secret", workspaceId: "ws" };
    const incoming = { clientId: "id", clientSecret: TARGET_SECRET_MASK, workspaceId: "ws" };
    expect(mergePreservedTargetSecrets(existing, incoming).clientSecret).toBe("super-secret");
  });

  it("lets an explicit replacement overwrite the stored secret", () => {
    const existing = { clientSecret: "old-secret" };
    const incoming = { clientSecret: "new-secret" };
    expect(mergePreservedTargetSecrets(existing, incoming).clientSecret).toBe("new-secret");
  });

  it("keeps webhook Authorization headers when the form omits them", () => {
    const existing = {
      url: "https://hooks.example.com/x",
      method: "POST",
      headers: { Authorization: "Bearer live-token" },
      includeValue: false,
    };
    const incoming = {
      url: "https://hooks.example.com/y",
      method: "PUT",
      includeValue: true,
    };
    expect(mergePreservedTargetSecrets(existing, incoming)).toEqual({
      ...incoming,
      headers: { Authorization: "Bearer live-token" },
    });
  });

  it("keeps headers when every incoming value is the mask", () => {
    const existing = { headers: { Authorization: "Bearer live-token" } };
    const incoming = { headers: { Authorization: TARGET_SECRET_MASK } };
    expect(mergePreservedTargetSecrets(existing, incoming).headers).toEqual({
      Authorization: "Bearer live-token",
    });
  });
});

// ── AR31-29 — testConnection fail-closed on missing config ───────
describe("AR31-29 — testConnection fail-closed", () => {
  beforeEach(() => {
    __setLocalSettingForTests("AUTOROTATE_DEMO", "0");
  });

  it("throws when config is missing in real mode", async () => {
    await expect(testConnection("stripe", undefined as never)).rejects.toThrow(
      /no configuration saved/i,
    );
  });

  it("throws when a required field is empty in real mode", async () => {
    await expect(testConnection("stripe", { adminKey: "" })).rejects.toThrow(
      /adminKey/i,
    );
    await expect(testConnection("twilio", { accountSid: "AC123" })).rejects.toThrow(
      /authToken/i,
    );
  });

  it("throws when ALL required fields are empty", async () => {
    await expect(
      testConnection("infisical", {
        clientId: "",
        clientSecret: "",
        workspaceId: "",
      }),
    ).rejects.toThrow(/missing required fields/i);
  });

  it("does NOT short-circuit to demo success in real mode", async () => {
    // The previous code returned `[demo] verified (simulated)` whenever
    // `config` was falsy — even in real mode.  A misconfigured connector
    // then showed up as `connected`.
    await expect(testConnection("cloudflare", null as never)).rejects.toThrow(
      /no configuration/i,
    );
  });

  it("still allows the simulated pass in demo mode regardless of fields", async () => {
    __setLocalSettingForTests("AUTOROTATE_DEMO", "1");
    await expect(testConnection("stripe", {})).resolves.toMatch(/simulated/);
    await expect(testConnection("cloudflare", undefined as never)).resolves.toMatch(
      /simulated/,
    );
  });

  it("lets update_only platforms through without required-field validation", async () => {
    // update_only connectors have no remote check to perform — the operator
    // imports the new value by hand.  Empty config is fine; required-field
    // map intentionally omits them.
    const res = await testConnection("kubernetes", {});
    expect(res).toMatch(/no lightweight test available/);
  });
});

// ── AR31-30 — webhook empty URL fail-closed in real mode ────────
describe("AR31-30 — webhook target push in real mode", () => {
  // The engine-level push is exercised end-to-end in autorotate.test.ts; here
  // we pin the fail-closed rule at the helper boundary so a future refactor
  // cannot quietly reintroduce the silent fallback.
  it("real mode refuses an empty-URL webhook configuration", () => {
    __setLocalSettingForTests("AUTOROTATE_DEMO", "0");
    expect(() =>
      assertPushWebhooksReady([{ enabled: true, url: "" }]),
    ).toThrow(/has no URL/i);
  });

  it("real mode accepts a configured webhook URL", () => {
    expect(() =>
      assertPushWebhooksReady([{ enabled: true, url: "https://example.com/hook" }]),
    ).not.toThrow();
  });

  it("real mode ignores disabled webhook targets even when empty", () => {
    expect(() =>
      assertPushWebhooksReady([{ enabled: false, url: "" }]),
    ).not.toThrow();
  });

  it("demo mode is allowed to proceed with an empty URL (simulated)", () => {
    __setLocalSettingForTests("AUTOROTATE_DEMO", "1");
    expect(() =>
      assertPushWebhooksReady([{ enabled: true, url: "" }]),
    ).not.toThrow();
  });
});

// ── AR31-06 — sanitizeStepMessage (run history / verify detail) ──
describe("AR31-06 — sanitizeStepMessage", () => {
  it("caps messages at RUN_STEP_MESSAGE_CAP characters", () => {
    const long = "x".repeat(RUN_STEP_MESSAGE_CAP * 3);
    const out = sanitizeStepMessage(long);
    expect(out.length).toBeLessThanOrEqual(RUN_STEP_MESSAGE_CAP + 1); // +1 for "…"
    expect(out.endsWith("…")).toBe(true);
  });

  it("redacts Stripe live keys", () => {
    const out = sanitizeStepMessage("Stripe said: sk_live_abcdef1234567890XYZ");
    expect(out).not.toContain("sk_live_");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts GitHub tokens", () => {
    const out = sanitizeStepMessage("GitHub response: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out).not.toContain("ghp_");
  });

  it("redacts AWS access keys", () => {
    const out = sanitizeStepMessage("AWS error: AKIAIOSFODNN7EXAMPLE leaked");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts Authorization Bearer headers", () => {
    const out = sanitizeStepMessage(
      `Failed with HTTP 401\nauthorization: Bearer ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    );
    expect(out).not.toContain("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(out).toMatch(/authorization:\s*\[REDACTED\]/i);
  });

  it("redacts x-api-key headers", () => {
    const out = sanitizeStepMessage("x-api-key: sk-live-aaaaaaaaaaaaaaaaaaaaaaaa failed");
    expect(out).not.toContain("sk-live-aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out).toMatch(/x-api-key:\s*\[REDACTED\]/i);
  });

  it("redacts Anthropic and OpenAI keys", () => {
    const out = sanitizeStepMessage(
      "Got sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa response",
    );
    expect(out).not.toContain("sk-ant-api03-aaaa");
  });

  it("accepts an Error instance", () => {
    const err = new Error("remote threw: connection refused");
    const out = sanitizeStepMessage(err);
    expect(out).toBe("remote threw: connection refused");
  });

  it("accepts non-string inputs", () => {
    expect(sanitizeStepMessage(undefined)).toBe("");
    expect(sanitizeStepMessage(42)).toBe("42");
    expect(sanitizeStepMessage(null)).toBe("");
  });

  it("leaves benign messages untouched", () => {
    const benign =
      "credential delivered but failed liveness probe (HTTP 401)";
    expect(sanitizeStepMessage(benign)).toBe(benign);
  });
});
