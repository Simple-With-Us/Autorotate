import { randomBytes } from "node:crypto";
import type { ConnectorCapability } from "@contracts/autorotate";
import { isDemoMode, demoLatency } from "./demo";
import { randomToken } from "./crypto";
import { safeFetch, BlockedUrlError } from "./netguard";

// Server-side connector registry mirroring the capability matrix in
// docs/architecture.md §3. Each connector knows how to rotate() a credential
// using an admin credential/config (already decrypted by the caller).
//
// DEMO MODE (AR-02): rotate() returns a realistic random secret ONLY when
// AUTOROTATE_DEMO is explicitly on. A missing config in real mode is a hard
// error — never a fabricated value — because the engine cannot tell a demo
// value from a real one and will happily write it to live targets, verify it
// against itself, and report success. Partial/update-only connectors throw
// MANUAL_ROTATION_REQUIRED outside demo mode.

export class ManualRotationRequired extends Error {
  constructor(platform: string) {
    super(
      `MANUAL_ROTATION_REQUIRED: ${platform} has no programmatic rotation API — import the new value manually`,
    );
    this.name = "ManualRotationRequired";
  }
}

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}

export type ConnectorConfig = Record<string, unknown> | null;

export type RotateResult = {
  value?: string;
  demo: boolean;
  message: string;
};

export type ServerConnector = {
  platform: string;
  displayName: string;
  capability: ConnectorCapability;
  /** Generate a realistic-format random secret for demo mode. */
  demoValue: () => string;
  rotate: (config: ConnectorConfig) => Promise<RotateResult>;
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

// AR-09 / F10: every outbound fetch to an OPERATOR-SUPPLIED URL (generic_rest
// cfg.url, kubernetes cfg.apiServer, infisical cfg.baseUrl) must pass through
// the netguard so it cannot be pointed at a metadata endpoint or an internal
// host, nor be redirected to one.  Hardcoded provider hosts (api.stripe.com,
// …) are trusted constants and use a plain fetch.
async function apiFetch(
  url: string,
  init: RequestInit,
  what: string,
  opts?: { guardUrl?: boolean },
): Promise<Response> {
  let res: Response;
  try {
    res = opts?.guardUrl ? await safeFetch(url, init) : await fetch(url, init);
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      throw new ConnectorError(`${what}: blocked outbound URL — ${err.message}`);
    }
    throw new ConnectorError(`${what}: network error — ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ConnectorError(`${what}: HTTP ${res.status} ${body.slice(0, 160)}`);
  }
  return res;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// ── Real API call shapes (used only when not in demo mode) ──────

// AWS IAM has no programmatic rotate here (AR-10).  The previous
// implementation POSTed CreateAccessKey with no SigV4 signature — so it
// always failed auth — and on its success path parsed the returned
// AccessKeyId, discarded it, and returned a locally generated "AKIA…"
// string.  Adding signing without fixing the return would have created a
// real access key, thrown it away, and pushed a value that authenticates to
// nothing.  AWS is registered as update_only until SigV4 signing and the
// out-of-band SecretAccessKey are both handled; docs/architecture.md §3
// matches.

async function rotateStripe(cfg: ConnectorConfig): Promise<string> {
  const adminKey = str(cfg?.adminKey);
  if (!adminKey) throw new ConnectorError("Stripe: adminKey required");
  // Real shape: POST /v1/api_keys (create) then DELETE the rolled key.
  const res = await apiFetch(
    "https://api.stripe.com/v1/api_keys",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
    },
    "Stripe create key",
  );
  const data = (await res.json()) as { secret?: string };
  if (!data.secret) throw new ConnectorError("Stripe: no secret in response");
  return data.secret;
}

async function rotateOpenAI(cfg: ConnectorConfig): Promise<string> {
  const adminKey = str(cfg?.adminKey);
  const projectId = str(cfg?.projectId);
  if (!adminKey || !projectId) {
    throw new ConnectorError("OpenAI: adminKey and projectId required");
  }
  // Real shape: POST /v1/organization/projects/{id}/service_accounts
  const res = await apiFetch(
    `https://api.openai.com/v1/organization/projects/${projectId}/service_accounts`,
    {
      method: "POST",
      headers: bearer(adminKey),
      body: JSON.stringify({ name: `autorotate-${Date.now()}` }),
    },
    "OpenAI create service account",
  );
  const data = (await res.json()) as { api_key?: { value?: string } };
  if (!data.api_key?.value) throw new ConnectorError("OpenAI: no key in response");
  return data.api_key.value;
}

async function rotateCloudflare(cfg: ConnectorConfig): Promise<string> {
  const apiToken = str(cfg?.apiToken);
  const accountId = str(cfg?.accountId);
  const tokenId = str(cfg?.tokenId);
  if (!apiToken || !accountId || !tokenId) {
    throw new ConnectorError("Cloudflare: apiToken/accountId/tokenId required");
  }
  // Real shape: PUT /client/v4/accounts/{accountId}/tokens/{tokenId}/value
  const res = await apiFetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/${tokenId}/value`,
    { method: "PUT", headers: bearer(apiToken), body: "{}" },
    "Cloudflare token roll",
  );
  const data = (await res.json()) as { result?: { value?: string } };
  if (!data.result?.value) throw new ConnectorError("Cloudflare: no value in response");
  return data.result.value;
}

async function rotateTwilio(cfg: ConnectorConfig): Promise<string> {
  const accountSid = str(cfg?.accountSid);
  const authToken = str(cfg?.authToken);
  if (!accountSid || !authToken) {
    throw new ConnectorError("Twilio: accountSid/authToken required");
  }
  // Real shape: POST /2010-04-01/Accounts/{sid}/Keys.json
  const res = await apiFetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Keys.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ FriendlyName: `autorotate-${Date.now()}` }).toString(),
    },
    "Twilio create API key",
  );
  const data = (await res.json()) as { secret?: string };
  if (!data.secret) throw new ConnectorError("Twilio: no secret in response");
  return data.secret;
}

async function rotateSendGrid(cfg: ConnectorConfig): Promise<string> {
  const adminKey = str(cfg?.adminKey);
  if (!adminKey) throw new ConnectorError("SendGrid: adminKey required");
  // Real shape: POST /v3/api_keys with scopes
  const res = await apiFetch(
    "https://api.sendgrid.com/v3/api_keys",
    {
      method: "POST",
      headers: bearer(adminKey),
      body: JSON.stringify({
        name: `autorotate-${Date.now()}`,
        scopes: ["mail.send"],
      }),
    },
    "SendGrid create API key",
  );
  const data = (await res.json()) as { api_key?: string };
  if (!data.api_key) throw new ConnectorError("SendGrid: no api_key in response");
  return data.api_key;
}

async function rotateDockerHub(cfg: ConnectorConfig): Promise<string> {
  const username = str(cfg?.username);
  const password = str(cfg?.password);
  if (!username || !password) {
    throw new ConnectorError("DockerHub: username/password required");
  }
  // Real shape: POST /v2/users/login -> token, then POST /v2/access-tokens
  const loginRes = await apiFetch(
    "https://hub.docker.com/v2/users/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
    "DockerHub login",
  );
  const { token } = (await loginRes.json()) as { token?: string };
  if (!token) throw new ConnectorError("DockerHub: login returned no token");
  const res = await apiFetch(
    "https://hub.docker.com/v2/access-tokens",
    {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        token_label: `autorotate-${Date.now()}`,
        scopes: ["repo:admin"],
      }),
    },
    "DockerHub create PAT",
  );
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new ConnectorError("DockerHub: no token in response");
  return data.token;
}

async function rotateNpm(cfg: ConnectorConfig): Promise<string> {
  const token = str(cfg?.token);
  if (!token) throw new ConnectorError("npm: token required");
  // Real shape: POST /-/npm/v1/tokens (granular access tokens)
  const res = await apiFetch(
    "https://registry.npmjs.org/-/npm/v1/tokens",
    {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        name: `autorotate-${Date.now()}`,
        token_type: "read_write",
      }),
    },
    "npm create granular token",
  );
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new ConnectorError("npm: no token in response");
  return data.token;
}



async function rotateInfisicalSource(cfg: ConnectorConfig): Promise<string> {
  const clientId = str(cfg?.clientId);
  const clientSecret = str(cfg?.clientSecret);
  const workspaceId = str(cfg?.workspaceId);
  const secretName = str(cfg?.secretName) ?? "AUTOROTATE_MANAGED";
  if (!clientId || !clientSecret || !workspaceId) {
    throw new ConnectorError("Infisical: clientId/clientSecret/workspaceId required");
  }
  const { upsertSecret } = await import("./infisical");
  const newValue = randomBytes(32).toString("hex");
  await upsertSecret(
    {
      baseUrl: str(cfg?.baseUrl),
      clientId,
      clientSecret,
      workspaceId,
      environment: str(cfg?.environment) ?? "prod",
      secretPath: str(cfg?.secretPath) ?? "/",
    },
    secretName,
    newValue,
  );
  return newValue;
}

async function rotateGenericRest(cfg: ConnectorConfig): Promise<string> {
  const url = str(cfg?.url);
  if (!url) throw new ConnectorError("generic-rest: url required");
  const method = str(cfg?.method) ?? "POST";
  const headers = (cfg?.headers as Record<string, string> | undefined) ?? {};
  // Real shape: configurable request template; response JSON path configurable.
  const res = await apiFetch(
    url,
    {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof cfg?.body === "string" ? cfg.body : JSON.stringify(cfg?.body ?? {}),
    },
    "generic-rest rotate",
    { guardUrl: true }, // F10: url is operator-supplied
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const path = str(cfg?.responsePath) ?? "secret";
  const value = data[path];
  if (typeof value !== "string") {
    throw new ConnectorError(`generic-rest: no string at response path "${path}"`);
  }
  return value;
}

async function rotateResend(cfg: ConnectorConfig): Promise<string> {
  const adminKey = str(cfg?.adminKey) ?? str(cfg?.token);
  if (!adminKey) throw new ConnectorError("Resend: adminKey required");
  const res = await apiFetch(
    "https://api.resend.com/api-keys",
    {
      method: "POST",
      headers: bearer(adminKey),
      body: JSON.stringify({ name: `autorotate-${new Date().toISOString().slice(0, 10)}` }),
    },
    "Resend create key",
  );
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new ConnectorError("Resend: no token in response");
  return data.token;
}

async function rotateSlackLive(cfg: ConnectorConfig): Promise<string> {
  const token = str(cfg?.botToken) ?? str(cfg?.token);
  if (!token) throw new ConnectorError("Slack: botToken required");
  const res = await apiFetch(
    "https://slack.com/api/auth.rotate",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    },
    "Slack auth.rotate",
  );
  const data = (await res.json()) as { ok?: boolean; token?: string; error?: string };
  if (!data.ok || !data.token) {
    throw new ConnectorError(`Slack auth.rotate: ${data.error ?? "no token"}`);
  }
  return data.token;
}

async function rotateHuggingFace(cfg: ConnectorConfig): Promise<string> {
  const token = str(cfg?.token);
  if (!token) throw new ConnectorError("Hugging Face: token required");
  const res = await apiFetch(
    "https://huggingface.co/api/fine-grained-tokens",
    {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: `autorotate-${Date.now()}`, role: "read" }),
    },
    "Hugging Face create token",
  );
  const data = (await res.json()) as { token?: string; accessToken?: string };
  const value = data.token ?? data.accessToken;
  if (!value) throw new ConnectorError("Hugging Face: no token in response");
  return value;
}

async function rotateNeon(cfg: ConnectorConfig): Promise<string> {
  const token = str(cfg?.token);
  if (!token) throw new ConnectorError("Neon: token required");
  const res = await apiFetch(
    "https://console.neon.tech/api/v2/api_keys",
    {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ key_name: `autorotate-${new Date().toISOString().slice(0, 10)}` }),
    },
    "Neon create API key",
  );
  const data = (await res.json()) as { key?: string };
  if (!data.key) throw new ConnectorError("Neon: no key in response");
  return data.key;
}

async function rotateVercel(cfg: ConnectorConfig): Promise<string> {
  const token = str(cfg?.token);
  if (!token) throw new ConnectorError("Vercel: token required");
  const res = await apiFetch(
    "https://api.vercel.com/v3/user/tokens",
    {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: `autorotate-${new Date().toISOString().slice(0, 10)}` }),
    },
    "Vercel create token",
  );
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new ConnectorError("Vercel: no token in response");
  return data.token;
}

// ── Demo value generators (realistic formats per platform) ──────
const BASE62 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// AR31-29 (2026-09-20): required field map for `testConnection`.  Keys are
// connector platforms; values are the config keys that must be non-empty
// before a real-mode connection test is allowed to proceed.  Platforms not
// in this map (update_only entries, local generators like jwt/database)
// are validated by their platform-specific branch or have no remote check
// to make; they still get the demo-mode short-circuit above.
const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  stripe: ["adminKey"],
  openai: ["adminKey"],
  cloudflare: ["apiToken"],
  sendgrid: ["adminKey"],
  npm: ["token"],
  vercel: ["token"],
  resend: ["adminKey"],
  huggingface: ["token"],
  neon: ["token"],
  slack: ["botToken"],
  twilio: ["accountSid", "authToken"],
  infisical: ["clientId", "clientSecret", "workspaceId"],
  github: ["token"],
};

const demoValues: Record<string, () => string> = {
  infisical: () => `st.${randomBytes(4).toString("hex")}.${randomBytes(16).toString("hex")}.${randomBytes(12).toString("hex")}`,
  aws_iam: () => `AKIA${randomToken(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`, // gitleaks:allow
  github: () => `ghp_${randomToken(36, BASE62)}`, // gitleaks:allow
  stripe: () => `sk_live_${randomToken(24, BASE62)}`, // gitleaks:allow
  openai: () => `sk-proj-${randomToken(48, `${BASE62}-_`)}`, // gitleaks:allow
  anthropic: () => `sk-ant-api03-${randomToken(40, `${BASE62}-_`)}`, // gitleaks:allow
  cloudflare: () => randomToken(40, BASE62),
  vercel: () => randomToken(24, BASE62),
  twilio: () => `SK${randomBytes(16).toString("hex")}`,
  sendgrid: () => `SG.${randomToken(22, `${BASE62}-_`)}.${randomToken(43, `${BASE62}-_`)}`,
  slack: () => `xoxb-${randomToken(11, "0123456789")}-${randomToken(13, "0123456789")}-${randomToken(24, BASE62)}`,
  npm: () => `npm_${randomToken(36, BASE62)}`,
  dockerhub: () => `dckr_pat_${randomToken(27, BASE62)}`,
  kubernetes: () => randomBytes(48).toString("base64url"),
  generic_rest: () => randomBytes(32).toString("hex"),
  resend: () => `re_${randomToken(32, BASE62)}`,
  huggingface: () => `hf_${randomToken(37, BASE62)}`,
  neon: () => randomBytes(24).toString("hex"),
  vault: () => `hvs.${randomToken(24, BASE62)}`,
  doppler: () => `dp.st.${randomToken(32, BASE62)}`,
  onepassword: () => `ops_${randomToken(32, BASE62)}`,
  xai: () => `xai-${randomToken(48, BASE62)}`,
  groq: () => `gsk_${randomToken(48, BASE62)}`,
  google_ai: () => `AIza${randomToken(35, BASE62)}`,
  gitlab: () => `glpat-${randomToken(20, BASE62)}`,
  bitbucket: () => randomToken(32, BASE62),
  gcp: () => randomBytes(32).toString("hex"),
  azure: () => randomToken(40, BASE62),
  netlify: () => randomToken(40, BASE62),
  railway: () => randomToken(32, BASE62),
  render: () => `rnd_${randomToken(32, BASE62)}`,
  fly: () => `FlyV1 ${randomToken(40, BASE62)}`,
  digitalocean: () => `dop_v1_${randomToken(40, BASE62)}`,
  coolify: () => randomBytes(32).toString("hex"),
  heroku: () => randomBytes(20).toString("hex"),
  discord: () => `${randomToken(24, BASE62)}.${randomToken(6, BASE62)}.${randomToken(27, BASE62)}`,
  mailgun: () => `key-${randomBytes(16).toString("hex")}`,
  postmark: () => randomBytes(20).toString("hex"),
  supabase: () => `sbp_${randomToken(40, BASE62)}`,
  planetscale: () => `pscale_tkn_${randomToken(32, BASE62)}`,
  mongodb: () => randomToken(32, BASE62),
  fmp: () => randomToken(32, BASE62),
  ssh: () => `ssh-ed25519 ${randomBytes(32).toString("base64")} autorotate-demo`,
  database: () => randomToken(32, BASE62),
  webhook_hmac: () => `whsec_${randomBytes(24).toString("base64url")}`,
  jwt: () => randomBytes(32).toString("hex"),
  apple_asc: () => randomBytes(16).toString("hex"),
  linear: () => `lin_api_${randomToken(40, BASE62)}`,
  notion: () => `ntn_${randomToken(40, BASE62)}`,
  generic_secret: () => randomBytes(32).toString("hex"),
};

// ── Registry ────────────────────────────────────────────────────

type RealRotate = (cfg: ConnectorConfig) => Promise<string>;

/** Local CSPRNG mint — used for jwt / database / webhook HMAC / generic secret. */
const rotateGenerated: RealRotate = async () => randomBytes(32).toString("hex");

function define(
  platform: string,
  displayName: string,
  capability: ConnectorCapability,
  realRotate: RealRotate | null,
): ServerConnector {
  const demoValue = demoValues[platform] ?? (() => randomBytes(32).toString("hex"));
  return {
    platform,
    displayName,
    capability,
    demoValue,
    async rotate(config) {
      if (isDemoMode()) {
        await demoLatency();
        const value = demoValue();
        return {
          value,
          demo: true,
          message:
            capability === "programmatic"
              ? `generated new ${displayName} credential (simulated)`
              : `simulated manual rotation for ${displayName} (no programmatic API)`,
        };
      }
      // AR-02: fail closed. Without an admin credential there is nothing to
      // rotate, and a fabricated value would be pushed to live targets and
      // then "verified" against itself.
      if (!config) {
        throw new ConnectorError(
          `${displayName}: no stored admin credential — connect the platform before rotating`,
        );
      }
      if (!realRotate) {
        throw new ManualRotationRequired(displayName);
      }
      const value = await realRotate(config);
      return {
        value,
        demo: false,
        message: `rotated ${displayName} credential via API`,
      };
    },
  };
}

export const connectorRegistry: ServerConnector[] = [
  define("infisical", "Infisical", "programmatic", rotateInfisicalSource),
  // AR-10: update_only until SigV4 signing lands and the real
  // SecretAccessKey is returned. See the note above rotateStripe.
  define("aws_iam", "AWS IAM", "update_only", null),
  define("github", "GitHub", "partial", null),
  define("stripe", "Stripe", "programmatic", rotateStripe),
  define("openai", "OpenAI", "programmatic", rotateOpenAI),
  define("anthropic", "Anthropic", "partial", null),
  define("cloudflare", "Cloudflare", "programmatic", rotateCloudflare),
  define("vercel", "Vercel", "programmatic", rotateVercel),
  define("twilio", "Twilio", "programmatic", rotateTwilio),
  define("sendgrid", "SendGrid", "programmatic", rotateSendGrid),
  define("slack", "Slack", "partial", rotateSlackLive),
  define("npm", "npm", "programmatic", rotateNpm),
  define("dockerhub", "Docker Hub", "programmatic", rotateDockerHub),
  // AR31-02 (2026-09-20): rotateKubernetes POSTs a real ServiceAccount
  // create then returns `randomBytes(48)` — an invented credential.  Until
  // it returns a real cluster token (or an operator-imported value), it
  // belongs in the update_only bucket like AWS.  docs/architecture.md §3
  // reclassified in the same commit.
  define("kubernetes", "Kubernetes", "update_only", null),
  define("generic_rest", "Generic REST", "programmatic", rotateGenericRest),
  define("resend", "Resend", "programmatic", rotateResend),
  define("huggingface", "Hugging Face", "programmatic", rotateHuggingFace),
  define("neon", "Neon", "programmatic", rotateNeon),
  // Grok catalog — update-only unless a local generator applies.
  define("vault", "HashiCorp Vault", "update_only", null),
  define("doppler", "Doppler", "update_only", null),
  define("onepassword", "1Password Connect", "update_only", null),
  define("xai", "xAI", "update_only", null),
  define("groq", "Groq", "update_only", null),
  define("google_ai", "Google AI / Gemini", "update_only", null),
  define("gitlab", "GitLab", "update_only", null),
  define("bitbucket", "Bitbucket", "update_only", null),
  define("gcp", "Google Cloud", "update_only", null),
  define("azure", "Azure", "update_only", null),
  define("netlify", "Netlify", "update_only", null),
  define("railway", "Railway", "update_only", null),
  define("render", "Render API token", "update_only", null),
  define("fly", "Fly.io", "update_only", null),
  define("digitalocean", "DigitalOcean", "update_only", null),
  define("coolify", "Coolify", "update_only", null),
  define("heroku", "Heroku", "update_only", null),
  define("discord", "Discord", "update_only", null),
  define("mailgun", "Mailgun", "update_only", null),
  define("postmark", "Postmark", "update_only", null),
  define("supabase", "Supabase", "update_only", null),
  define("planetscale", "PlanetScale", "update_only", null),
  define("mongodb", "MongoDB Atlas", "update_only", null),
  define("fmp", "Financial Modeling Prep", "update_only", null),
  define("ssh", "SSH keys", "update_only", null),
  define("database", "Database password", "programmatic", rotateGenerated),
  define("webhook_hmac", "Webhook / HMAC", "programmatic", rotateGenerated),
  define("jwt", "JWT signing key", "programmatic", rotateGenerated),
  define("apple_asc", "App Store Connect", "update_only", null),
  define("linear", "Linear", "update_only", null),
  define("notion", "Notion", "update_only", null),
  define("generic_secret", "Generic secret", "programmatic", rotateGenerated),
];

export function getConnector(platform: string): ServerConnector | undefined {
  return connectorRegistry.find((c) => c.platform === platform);
}

/**
 * Post-commit liveness probe (AR-11).
 *
 * VERIFY only proves the new value landed where it was written — it reads
 * back what it just wrote and compares it to itself, so a dead, malformed or
 * fabricated credential is indistinguishable from a healthy one.  This
 * authenticates the NEW value against its own provider with the cheapest
 * available read.
 *
 * Returns null when the platform has no probe — a rotated database password
 * or JWT signing key is not an API credential and there is nothing to call.
 * Never returns a value or fingerprint in its message.
 */
export async function probeNewCredential(
  platform: string,
  value: string,
): Promise<string | null> {
  const connector = getConnector(platform);
  const name = connector?.displayName ?? platform;
  switch (platform) {
    case "stripe":
      await apiFetch("https://api.stripe.com/v1/account", { headers: bearer(value) }, "Stripe liveness probe");
      break;
    case "openai":
      await apiFetch("https://api.openai.com/v1/models", { headers: bearer(value) }, "OpenAI liveness probe");
      break;
    case "cloudflare":
      await apiFetch(
        "https://api.cloudflare.com/client/v4/user/tokens/verify",
        { headers: bearer(value) },
        "Cloudflare liveness probe",
      );
      break;
    case "npm":
      await apiFetch("https://registry.npmjs.org/-/whoami", { headers: bearer(value) }, "npm liveness probe");
      break;
    case "vercel":
      await apiFetch("https://api.vercel.com/v2/user", { headers: bearer(value) }, "Vercel liveness probe");
      break;
    case "resend":
      await apiFetch("https://api.resend.com/api-keys", { headers: bearer(value) }, "Resend liveness probe");
      break;
    case "huggingface":
      await apiFetch(
        "https://huggingface.co/api/whoami-v2",
        { headers: bearer(value) },
        "Hugging Face liveness probe",
      );
      break;
    case "neon":
      await apiFetch(
        "https://console.neon.tech/api/v2/api_keys",
        { headers: bearer(value) },
        "Neon liveness probe",
      );
      break;
    case "slack": {
      // Slack answers 200 with {ok:false} for a dead token.
      const res = await apiFetch(
        "https://slack.com/api/auth.test",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: value }).toString(),
        },
        "Slack liveness probe",
      );
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        throw new ConnectorError(`Slack liveness probe: ${data.error ?? "auth.test returned ok:false"}`);
      }
      break;
    }
    default:
      return null;
  }
  return `new ${name} credential authenticated against the provider`;
}

/** Lightweight connectivity check for connectors.test. Demo-mode safe. */
export async function testConnection(
  platform: string,
  config: ConnectorConfig,
): Promise<string> {
  const connector = getConnector(platform);
  const name = connector?.displayName ?? platform;
  // AR31-29 (2026-09-20): the previous short-circuit also returned success
  // when `config` was missing in REAL mode — a misconfigured connector then
  // showed up as `connected` and the next rotation failed with no
  // explanation.  Demo mode keeps the simulated pass (with the demo tag so
  // it never reads as a real verification).  Real mode with no config now
  // fails with the field names the operator actually has to fill in.
  if (isDemoMode()) {
    const ms = await demoLatency();
    return `[demo] connection to ${name} verified (simulated, ${ms}ms)`;
  }
  if (!config || typeof config !== "object") {
    throw new ConnectorError(
      `${name}: connector has no configuration saved — open the connector and fill in the required fields before testing`,
    );
  }
  // Reject empty required fields up front.  Platform-specific branches below
  // would otherwise make a real upstream call with empty credentials and
  // surface the provider's 401/403 as a "success" — or, for local generators,
  // return "ready" without ever looking at the config.
  const requiredFields = REQUIRED_FIELDS[platform];
  if (requiredFields) {
    const missing = requiredFields.filter(
      (field) => !str((config as Record<string, unknown>)[field]),
    );
    if (missing.length > 0) {
      throw new ConnectorError(
        `${name}: missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      );
    }
  }
  switch (platform) {
    case "stripe":
      await apiFetch("https://api.stripe.com/v1/account", { headers: bearer(str(config.adminKey) ?? "") }, "Stripe test");
      break;
    case "openai":
      await apiFetch("https://api.openai.com/v1/models", { headers: bearer(str(config.adminKey) ?? "") }, "OpenAI test");
      break;
    case "cloudflare":
      await apiFetch("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: bearer(str(config.apiToken) ?? "") }, "Cloudflare test");
      break;
    case "sendgrid":
      await apiFetch("https://api.sendgrid.com/v3/scopes", { headers: bearer(str(config.adminKey) ?? "") }, "SendGrid test");
      break;
    case "npm":
      await apiFetch("https://registry.npmjs.org/-/npm/v1/tokens", { headers: bearer(str(config.token) ?? "") }, "npm test");
      break;
    case "vercel":
      await apiFetch("https://api.vercel.com/v2/user", { headers: bearer(str(config.token) ?? "") }, "Vercel test");
      break;
    case "resend":
      await apiFetch("https://api.resend.com/api-keys", { headers: bearer(str(config.adminKey) ?? str(config.token) ?? "") }, "Resend test");
      break;
    case "huggingface":
      await apiFetch("https://huggingface.co/api/whoami-v2", { headers: bearer(str(config.token) ?? "") }, "Hugging Face test");
      break;
    case "neon":
      await apiFetch("https://console.neon.tech/api/v2/api_keys", { headers: bearer(str(config.token) ?? "") }, "Neon test");
      break;
    case "slack":
      await apiFetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: str(config.botToken) ?? str(config.token) ?? "" }).toString(),
      }, "Slack test");
      break;
    case "twilio": {
      const sid = str(config.accountSid);
      if (!sid) throw new ConnectorError("Twilio: accountSid required");
      await apiFetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${str(config.authToken) ?? ""}`).toString("base64")}` },
      }, "Twilio test");
      break;
    }
    case "infisical": {
      const { login } = await import("./infisical");
      await login({
        baseUrl: str(config.baseUrl),
        clientId: str(config.clientId),
        clientSecret: str(config.clientSecret),
        workspaceId: str(config.workspaceId),
        environment: str(config.environment) ?? "prod",
        secretPath: str(config.secretPath) ?? "/",
      });
      break;
    }
    case "jwt":
    case "database":
    case "webhook_hmac":
    case "generic_secret":
      return `local generator for ${name} is ready`;
    default:
      return `no lightweight test available for ${name} — credential saved`;
  }
  return `connection to ${name} verified`;
}
