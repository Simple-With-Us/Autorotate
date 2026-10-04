import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initAppSettings, __resetSettingsForTests } from "./appSettings";

// Infisical SOT: crypto reads the encryption key from the settings cache.
// Tests run in local-dev mode (no INFISICAL credentials) — the dev
// passphrase fallback keeps the previous behavior.
beforeAll(async () => {
  delete process.env.INFISICAL_CLIENT_ID;
  delete process.env.INFISICAL_CLIENT_SECRET;
  await initAppSettings();
});

afterAll(() => {
  __resetSettingsForTests();
});
import { encryptJson, decryptJson, fingerprint } from "./crypto";
import {
  computeEntryHash,
  canonicalEntry,
  infisicalSecretName,
  canaryDeliveryName,
  shouldMintProviderCredential,
  readTargetConfig,
} from "./engine";
import { renderUpdated } from "./files";
import { parseGlobalApiKeys, serializeGlobalApiKeys } from "./env-parse";
import { getConnector } from "./connectors";

describe("crypto", () => {
  it("encryptJson/decryptJson round-trips", () => {
    const payload = { adminKey: "sk-test-123", nested: { a: [1, 2] } };
    const enc = encryptJson(payload);
    expect(enc).not.toContain("sk-test-123");
    expect(decryptJson(enc)).toEqual(payload);
  });

  it("decryptJson returns null for garbage", () => {
    expect(decryptJson("not-a-payload")).toBeNull();
    expect(decryptJson(null)).toBeNull();
  });

  it("fingerprint is a 16-char sha256 prefix", () => {
    expect(fingerprint("hello")).toBe("2cf24dba5fb0a30e");
    expect(fingerprint("hello")).toHaveLength(16);
  });
});

// P1 b052d650: targets.configJson (Infisical clientSecret, webhook auth
// headers) used to be stored as plaintext JSON. readTargetConfig() is the
// single accessor every call site now goes through — it must prefer the
// encrypted column and only fall back to the deprecated plaintext column for
// a row a prior environment has not backfilled yet (see
// db/migrate-target-config-encryption.ts).
describe("readTargetConfig — encryption-at-rest (P1 b052d650)", () => {
  it("decrypts configEnc when present, ignoring any leftover configJson", () => {
    const cfg = { clientId: "id", clientSecret: "super-secret", workspaceId: "ws" };
    const target = { configEnc: encryptJson(cfg), configJson: { stale: true } };
    expect(readTargetConfig(target)).toEqual(cfg);
  });

  it("falls back to plaintext configJson when configEnc is unset (pre-migration row)", () => {
    const cfg = { url: "https://hooks.example.com/x", headers: { Authorization: "Bearer abc" } };
    const target = { configEnc: null, configJson: cfg };
    expect(readTargetConfig(target)).toEqual(cfg);
  });

  it("returns {} when neither column is set", () => {
    expect(readTargetConfig({ configEnc: null, configJson: null })).toEqual({});
  });
});

describe("audit hash chain", () => {
  it("is deterministic and chain-dependent", () => {
    const entry = {
      ts: "2025-01-01T00:00:00.000Z",
      actor: "web-user",
      action: "rotation.committed",
      secretId: 7,
      detail: { runId: 3 },
    };
    // AR-07 widened the entry hash from a 16-char prefix to full sha256.
    const genesis = "0".repeat(64);
    const h1 = computeEntryHash(genesis, entry);
    expect(h1).toHaveLength(64);
    expect(computeEntryHash(genesis, entry)).toBe(h1);
    expect(computeEntryHash("1".repeat(64), entry)).not.toBe(h1);
    expect(canonicalEntry(entry)).toBe(canonicalEntry({ ...entry }));
  });
});

describe("infisicalSecretName", () => {
  it("uses the secret record name when wizard secretName is empty", () => {
    expect(infisicalSecretName({}, "CLOUDFLARE_API_TOKEN")).toBe(
      "CLOUDFLARE_API_TOKEN",
    );
    expect(infisicalSecretName({ secretName: "" }, "CLOUDFLARE_API_TOKEN")).toBe(
      "CLOUDFLARE_API_TOKEN",
    );
    expect(
      infisicalSecretName({ secretName: "   " }, "CLOUDFLARE_API_TOKEN"),
    ).toBe("CLOUDFLARE_API_TOKEN");
  });

  it("does not fall back to a value fingerprint", () => {
    const fp = fingerprint("rotated-value");
    expect(infisicalSecretName({ secretName: "" }, "CLOUDFLARE_API_TOKEN")).not.toBe(
      fp,
    );
  });

  it("keeps an explicit Infisical secret name", () => {
    expect(
      infisicalSecretName({ secretName: "prod/cf-token" }, "CLOUDFLARE_API_TOKEN"),
    ).toBe("prod/cf-token");
  });
});

describe("canaryDeliveryName", () => {
  it("never reuses the live Infisical or file key", () => {
    expect(canaryDeliveryName("CLOUDFLARE_API_TOKEN")).toBe(
      "CLOUDFLARE_API_TOKEN_CANARY",
    );
    expect(canaryDeliveryName("API_KEY")).toBe("API_KEY_CANARY");
    expect(canaryDeliveryName("prod.aws_access_key_id")).toBe(
      "prod.aws_access_key_id_CANARY",
    );
    expect(canaryDeliveryName("credentials.npmToken")).toBe(
      "credentials.npmToken_CANARY",
    );
  });

  it("does not double-suffix an already-canary name", () => {
    expect(canaryDeliveryName("API_KEY_CANARY")).toBe("API_KEY_CANARY");
    expect(canaryDeliveryName("  ")).toBe("SECRET_CANARY");
  });

  it("keeps the live name distinct from the canary even after #41 fallback", () => {
    const live = infisicalSecretName({ secretName: "" }, "CLOUDFLARE_API_TOKEN");
    expect(canaryDeliveryName(live)).not.toBe(live);
  });
});

describe("shouldMintProviderCredential", () => {
  it("allows live mints for actual rotations", () => {
    expect(shouldMintProviderCredential(false)).toBe(true);
  });

  it("blocks live mints and revocations during dry-runs", () => {
    expect(shouldMintProviderCredential(true)).toBe(false);
  });
});

describe("file target renderers", () => {
  it("updates .env keys in place", () => {
    const out = renderUpdated(
      { path: "x/.env", format: "env", key: "API_KEY" },
      "FOO=1\nAPI_KEY=old\n",
      "new-value",
    );
    expect(out).toBe("FOO=1\nAPI_KEY=new-value\n");
  });

  it("canary file key leaves the live .env value untouched", () => {
    const live = "API_KEY=sk-live-keep\n";
    const out = renderUpdated(
      {
        path: "x/.env",
        format: "env",
        key: canaryDeliveryName("API_KEY"),
      },
      live,
      "autorotate-canary-probe",
    );
    expect(out).toContain("API_KEY=sk-live-keep");
    expect(out).toContain("API_KEY_CANARY=autorotate-canary-probe");
    expect(out).not.toMatch(/^API_KEY=autorotate-canary-probe$/m);
  });

  it("appends missing .env keys", () => {
    const out = renderUpdated(
      { path: "x/.env", format: "env", key: "NEW_KEY" },
      "FOO=1\n",
      "v",
    );
    expect(out).toBe("FOO=1\nNEW_KEY=v\n");
  });

  it("updates JSON via dot path", () => {
    const out = renderUpdated(
      { path: "x/config.json", format: "json", key: "credentials.npmToken" },
      JSON.stringify({ credentials: { npmToken: "old" }, keep: 1 }),
      "npm_new",
    );
    expect(JSON.parse(out)).toEqual({
      credentials: { npmToken: "npm_new" },
      keep: 1,
    });
  });

  it("updates YAML flat keys", () => {
    const out = renderUpdated(
      { path: "x/p.yaml", format: "yaml", key: "aws_access_key_id" },
      "aws_access_key_id: AKIA_OLD\nother: 1\n",
      "AKIA_NEW",
    );
    expect(out).toContain("aws_access_key_id: AKIA_NEW");
    expect(out).toContain("other: 1");
  });

  it("updates INI section keys", () => {
    const out = renderUpdated(
      { path: "x/credentials", format: "ini", key: "prod.aws_access_key_id" },
      "[default]\naws_access_key_id = A\n\n[prod]\naws_access_key_id = B\n",
      "C",
    );
    expect(out).toContain("[default]\naws_access_key_id = A");
    expect(out).toContain("[prod]\naws_access_key_id = C");
  });
});

describe("global-api-keys parser (Grok merge)", () => {
  it("parses KEY=value, comments, and a trailing agent token", () => {
    const parsed = parseGlobalApiKeys(
      [
        "# Autorotate managed",
        "# username: mac-collab",
        "OPENAI_API_KEY=sk-test-1",
        'GITHUB_TOKEN="ghp_abc 123"',
        "AUTOROTATE_AGENT_TOKEN=agent-secret-token",
        "bare-trailing-token-value",
      ].join("\n"),
    );
    expect(parsed.keys.map((k) => k.key)).toEqual(["OPENAI_API_KEY", "GITHUB_TOKEN"]);
    expect(parsed.keys[1].value).toBe("ghp_abc 123");
    expect(parsed.agentToken).toBe("bare-trailing-token-value");
    expect(parsed.macUsername).toBe("mac-collab");
  });

  it("round-trips keys without embedding the agent token as a secret", () => {
    const text = serializeGlobalApiKeys(
      [{ key: "XAI_API_KEY", value: "xai-demo" }],
      "agent-token",
    );
    const parsed = parseGlobalApiKeys(text);
    expect(parsed.keys).toEqual([{ key: "XAI_API_KEY", value: "xai-demo" }]);
    expect(parsed.agentToken).toBe("agent-token");
    expect(text).not.toMatch(/sk-live|BEGIN .* PRIVATE/);
  });
});

describe("merged live connectors", () => {
  it("registers Resend, Hugging Face, Neon, and live Vercel/Slack", () => {
    expect(getConnector("resend")?.capability).toBe("programmatic");
    expect(getConnector("huggingface")?.capability).toBe("programmatic");
    expect(getConnector("neon")?.capability).toBe("programmatic");
    expect(getConnector("vercel")?.capability).toBe("programmatic");
    expect(getConnector("slack")?.capability).toBe("partial");
  });

  it("registers the Grok/Kimi extra catalog", () => {
    expect(getConnector("coolify")?.capability).toBe("update_only");
    expect(getConnector("xai")?.capability).toBe("update_only");
    expect(getConnector("vault")?.capability).toBe("update_only");
    expect(getConnector("jwt")?.capability).toBe("programmatic");
    expect(getConnector("database")?.capability).toBe("programmatic");
    expect(getConnector("generic_secret")?.capability).toBe("programmatic");
  });
});
