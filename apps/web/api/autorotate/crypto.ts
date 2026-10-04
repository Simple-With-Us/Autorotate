import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  encryptionKeySetting,
  isProduction,
  settingsVersion,
} from "./appSettings";

// AES-256-GCM encryption for connector admin credentials at rest.
// Key comes from the Infisical settings cache (AUTOROTATE_ENC_KEY): either a
// 64-char hex key or an arbitrary passphrase (derived with scrypt).  The
// development passphrase below keeps local play working — it is published in
// this repository, so production refuses to start without a real key (AR-04,
// enforced here as well as in appSettings.requireSetting so a bundle that
// skips settings validation still fails closed).

const DEV_PASSPHRASE = "autorotate-demo-passphrase";
const SCRYPT_SALT = "autorotate-connector-config-v1";

let cachedKey: Buffer | null = null;
let cachedVersion = -1;

function getKey(): Buffer {
  // A rotated AUTOROTATE_ENC_KEY must take effect: the derived key is cached
  // only for the current settings version and re-derived after any refresh
  // or write-through.
  const version = settingsVersion();
  if (cachedKey && version === cachedVersion) return cachedKey;
  const configured = encryptionKeySetting();
  if (!configured) {
    if (isProduction()) {
      // encryptionKeySetting() already threw above; unreachable defense.
      throw new Error("AUTOROTATE_ENC_KEY is required in production");
    }
    // Non-production only: the published dev passphrase keeps local play working.
    cachedKey = scryptSync(DEV_PASSPHRASE, SCRYPT_SALT, 32);
    cachedVersion = version;
    return cachedKey;
  }
  if (/^[0-9a-fA-F]{64}$/.test(configured)) {
    const buf = Buffer.from(configured, "hex");
    // F2: the .env.example used to ship 64 zeros — a valid AES key published in
    // a public repo.  An all-zero key is always refused, dev or prod.
    if (buf.every((b) => b === 0)) {
      throw new Error(
        "AUTOROTATE_ENC_KEY is all zero bytes — generate a real key with `openssl rand -hex 32`",
      );
    }
    cachedKey = buf;
    cachedVersion = version;
    return cachedKey;
  }
  // Not a full 64-char hex key: treated as a passphrase (scrypt-derived).  In
  // production a too-short value is almost always a truncated/typo'd hex key or
  // a weak passphrase, so fail closed rather than silently stretch it.
  if (isProduction()) {
    if (/^[0-9a-fA-F]+$/.test(configured) && configured.length < 64) {
      throw new Error(
        "AUTOROTATE_ENC_KEY looks like a truncated hex key (fewer than 64 hex chars) — provide a full 32-byte key from `openssl rand -hex 32`",
      );
    }
    if (configured.length < 16) {
      throw new Error(
        "AUTOROTATE_ENC_KEY passphrase is too short (fewer than 16 chars) in production — use a 32-byte hex key or a strong passphrase",
      );
    }
  }
  cachedKey = scryptSync(configured, SCRYPT_SALT, 32);
  cachedVersion = version;
  return cachedKey;
}

/** Encrypt a JSON-serializable value -> base64 payload `iv.tag.ciphertext`. */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/** Decrypt a payload produced by encryptJson. Returns null on bad input. */
export function decryptJson<T = Record<string, unknown>>(
  payload: string | null | undefined,
): T | null {
  if (!payload) return null;
  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  try {
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      getKey(),
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** sha256 hex prefix (16 chars) — the only trace of a secret value we keep. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/** Full sha256 hex of arbitrary string input. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Random URL-safe/base62-ish token of given length from crypto bytes. */
export function randomToken(length: number, alphabet?: string): string {
  const chars =
    alphabet ??
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}
