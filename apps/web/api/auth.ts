import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./lib/env";
import { adminTokenSetting, sessionTtlMsSetting } from "./autorotate/appSettings";

// ── Console authentication (AR-01) ──────────────────────────────
// One operator credential (AUTOROTATE_ADMIN_TOKEN) exchanged for a stateless
// signed session cookie.  Stateless because the server keeps no session
// store and a rotation console must survive a restart without logging the
// operator out mid-run; signed with a key derived from the admin token so
// rotating the token invalidates every outstanding session for free.
//
// CSRF stance: the cookie is SameSite=Strict, every tRPC call is a
// same-origin POST from the console bundle, and no CORS middleware is
// mounted (see boot.ts).  A cross-site page therefore cannot make the
// browser attach this cookie to a state-changing request, so no separate
// CSRF token is issued.  Adding CORS later means adding CSRF tokens.

export const SESSION_COOKIE = "autorotate_session";
/**
 * Session lifetime in milliseconds.  Read from the settings cache
 * (SETTINGS: SESSION_TTL_MS) — memory-only, never a network call.
 */
export function sessionTtlMs(): number {
  return sessionTtlMsSetting();
}
const SESSION_DOMAIN_SEPARATOR = "autorotate-session:";

let ephemeralDevToken: string | null = null;

/**
 * The operator credential.  In production it is required in the Infisical
 * settings cache (adminTokenSetting() throws naming the key when it is
 * missing).  In development an ephemeral random token is minted once per
 * process and printed once — never a fixed default, so a forgotten variable
 * cannot become a shipped password.
 */
export function adminToken(): string {
  const configured = adminTokenSetting();
  if (configured) return configured;
  if (env.isProduction) {
    // adminTokenSetting() already threw above; this is unreachable defense.
    throw new Error("Missing required app setting: AUTOROTATE_ADMIN_TOKEN");
  }
  if (!ephemeralDevToken) {
    ephemeralDevToken = randomBytes(24).toString("hex");
    console.log(
      `[autorotate] dev admin token: ${ephemeralDevToken}  (ephemeral — set AUTOROTATE_ADMIN_TOKEN in Infisical to pin it)`,
    );
  }
  return ephemeralDevToken;
}

function sessionKey(): Buffer {
  return createHash("sha256").update(adminToken(), "utf8").digest();
}

/** Constant-time compare of two arbitrary-length strings. */
function timingSafeEqualString(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function signExpiry(exp: number): string {
  return createHmac("sha256", sessionKey())
    .update(`${SESSION_DOMAIN_SEPARATOR}${exp}`, "utf8")
    .digest("hex");
}

/** Mint a `exp.sig` session value valid for sessionTtlMs() from `now`. */
export function createSession(now: number = Date.now()): string {
  const exp = now + sessionTtlMs();
  return `${exp}.${signExpiry(exp)}`;
}

/** True when the cookie value carries an unexpired, untampered signature. */
export function verifySession(
  cookieValue: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!cookieValue) return false;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return false;
  const expRaw = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  if (!/^\d{1,15}$/.test(expRaw) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp <= now) return false;
  return timingSafeEqualString(signature, signExpiry(exp));
}

/** Constant-time check of a login attempt against the operator credential. */
export function verifyAdminToken(candidate: string): boolean {
  const expected = adminToken();
  if (!expected || !candidate) return false;
  return timingSafeEqualString(candidate, expected);
}

function cookieAttributes(maxAgeSeconds: number): string[] {
  const attrs = [
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ];
  // Secure would make the cookie unusable over plain-http local development.
  if (env.isProduction) attrs.push("Secure");
  return attrs;
}

export function sessionCookie(value: string): string {
  return [`${SESSION_COOKIE}=${value}`, ...cookieAttributes(Math.floor(sessionTtlMs() / 1000))].join(
    "; ",
  );
}

export function clearedSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, ...cookieAttributes(0)].join("; ");
}

/** Pull the session cookie out of a raw `Cookie:` header. */
export function readSessionCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}
