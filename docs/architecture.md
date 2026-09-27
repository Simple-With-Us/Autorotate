# Autorotate — Architecture & Rotation Engine Spec

Autorotate (`autorotate.codes`) rotates secrets across as many platforms as possible and propagates the new
values to every configured target: **Infisical**, **local secret files** (`.env`, JSON,
YAML, TOML, INI like `~/.aws/credentials`), **Apple Keychain** (native iOS & macOS apps),
**Android Keystore** (native Android app), and **HTTPS Webhooks**.

## 1. Core concepts

| Concept | Description |
|---|---|
| **Connector** | Adapter for one secret platform (AWS IAM, GitHub, Stripe, …). Knows how to `rotate()` a credential using a user-supplied admin credential, or reports itself `updateOnly` when the platform has no programmatic rotation API. |
| **Secret record** | Metadata about ONE managed secret: name, platform/connector id, current reference, rotation policy, target bindings, status, timestamps. **Never stores the plaintext value.** |
| **Target** | Destination that receives the new secret value after rotation: Infisical project/env/path, file target (path + format + key), Keychain item (service/account), Android Keystore, webhook. |
| **Rotation run** | One execution of the rotation pipeline for one secret. Produces an audit entry with per-step results. |
| **Policy** | Schedule (interval hours / cron-like), auto-rotate on/off, verify-after-write, retry rules. |

## 2. Rotation pipeline (identical on all platforms)

```
rotate(secretId):
  1. LOCK    — acquire per-secret lock (skip if a run is in progress)
  2. ROTATE  — connector.rotate(adminCredential) -> newSecretValue
               (updateOnly connectors: prompt/import new value manually)
  3. PUSH    — for each enabled target, write newSecretValue:
                 - Infisical: POST /api/v3/secrets/raw/... (upsert) with workspace token
                 - File: parse file by format, set key, atomic rewrite (tmp+rename)
                 - Keychain (Apple): SecItemAdd/SecItemUpdate, kSecAttrAccessibleAfterFirstUnlock,
                   optional kSecAttrSynchronizable (iCloud Keychain)
                 - Keystore (Android): EncryptedSharedPreferences with AES256-GCM master key
                 - Webhook: POST JSON {name, valueRef} (value optional)
  4. VERIFY  — optional read-back per target (Infisical GET, Keychain SecItemCopyMatching, Android Keystore)
  5. COMMIT  — if all required targets OK: update record (lastRotatedAt, version+1)
               else: mark PARTIAL/FAILED, keep old value where already written, flag rollback
  6. AUDIT   — append immutable audit entry (never log secret values — hash prefix only)
```

## 3. Connector capability matrix (v1)

| Platform | Programmatic rotation | Mechanism |
|---|---|---|
| Infisical | ✅ (as target & source) | REST v3 raw secrets, service tokens / universal auth |
| AWS IAM | ⚠️ update-only | No signed CreateAccessKey call ships today (SigV4 signing and the out-of-band SecretAccessKey are both unimplemented); import the new key pair manually |
| GitHub | ⚠️ partial | Fine-grained PATs can't self-rotate; OAuth app secrets ✅ via API; PAT = updateOnly |
| Stripe | ✅ | Roll/create restricted keys via API |
| OpenAI | ✅ | Admin API: create/delete project service-account keys |
| Anthropic | ⚠️ | Admin API key management (workspace-scoped) |
| Cloudflare | ✅ | API token roll (`PUT .../tokens/:id/value`) |
| Vercel | ✅ | Create user token via REST (`POST /v3/user/tokens`); dashboard-only tokens remain update-only fallback |
| Twilio | ✅ | API key create/delete |
| SendGrid | ✅ | API key create/delete (scoped) |
| Slack | ⚠️ partial | `auth.rotate` when the token supports refresh-token rotation; otherwise updateOnly |
| Resend | ✅ | Create sending API key (`POST /api-keys`) |
| Hugging Face | ✅ | Create fine-grained token |
| Neon | ✅ | Create org API key |
| npm | ✅ (granular) / ⚠️ | Granular access tokens via API where enabled |
| Docker Hub | ✅ | Personal access tokens create/delete |
| Doppler / generic REST | ✅ | Generic connector: configurable request template |
| Kubernetes secrets | ⚠️ partial | `rotateKubernetes` POSTs a real ServiceAccount create then returned a fabricated `randomBytes(48)` credential; reclassified `update_only` 2026-09-20 (AR31-02) until a real cluster token is returned (or operator-imported) |
| `.env` / JSON / YAML / TOML / INI files | ✅ | File target engine |
| `global-api-keys` | ✅ | Env-style parser (`export`, comments) — Mac agent support not implemented |
| Mac agent (`mac.jays.services`) | ⛔ not implemented (stub) | Placeholder only; no implementation exists. |
| Extra catalog (Grok) | ⚠️ update-only or local generate | HashiCorp Vault, Doppler, 1Password Connect, xAI, Groq, Google AI, GitLab, Bitbucket, GCP, Azure, Netlify, Railway, Render API token (credential target only — this fleet does not host on Render), Fly.io, DigitalOcean, Coolify, Heroku, Discord, Mailgun, Postmark, Supabase, PlanetScale, MongoDB Atlas, FMP, SSH import, App Store Connect, Linear, Notion |
| Local generators | ✅ | JWT signing key, database password, webhook HMAC, generic secret (CSPRNG, then PUSH) |

The Grok App Builder snapshot catalogs 40+ platforms (xAI, Groq, Anthropic, Coolify, FMP, App Store Connect, …) with live / generate / console rotation kinds. Native Apple and Android clients implement rotation and delivery with platform-specific credential stores.

## 4. Infisical integration

- Auth: **Universal Auth** (clientId/clientSecret → access token) or service token.
- Upsert: `POST /api/v3/secrets/raw/{secretName}` with `workspaceId`, `environment`, `secretPath`, `secretValue`.
- Read-back verify: `GET /api/v3/secrets/raw/{secretName}`.
- Config stored per-workspace: baseUrl (default https://app.infisical.com), clientId, clientSecret (stored ONLY in Keychain on native / server-side encrypted on web), workspaceId, environment, path.

## 5. Apple Keychain & Android Keystore integration (native)

- `KeychainManager` (Apple): generic-password items, service = `codes.autorotate.<secretId>`, account = secret name.
- Accessibility: `kSecAttrAccessibleAfterFirstUnlock`; optional `kSecAttrSynchronizable = true` (iCloud Keychain) — user toggle, **"if allowed"** per entitlements.
- Access group: `$(AppIdentifierPrefix)codes.autorotate.shared` so iOS + macOS share items.
- Every query sets `kSecUseDataProtectionKeychain: true`. Without it, macOS writes generic-password items to the legacy file-based keychain, which ignores `kSecAttrAccessible`, handles access groups differently, and does not sync via iCloud — so the three bullets above would be true on iOS only. A read that misses in the data-protection keychain falls back to the legacy keychain and migrates a hit: data-protection write first, legacy delete only after it succeeds, so no path loses an item.
- `EncryptedStorage` (Android): `EncryptedSharedPreferences` backed by Android Keystore `AES256_GCM` master key.
- Keychain & Keystore are ALSO the credential store for connector admin credentials and Infisical clientSecret on native — the web server uses its DB (AES-GCM encrypted at rest) instead.

## 6. Storage rule (hard requirement)

Secret records retain metadata and references rather than plaintext values.  Application-managed
credential storage uses native credential stores or encryption at rest; plaintext does not belong
in databases, disk caches, logs, or other general-purpose storage.  Explicitly configured file
targets are the narrow filesystem exception described in [SECURITY.md](../SECURITY.md).
Providers, Infisical, native credential stores, and configured HTTPS webhooks receive values
as part of delivery.  Audit entries use `sha256(value)[0:16]` fingerprints rather than secret values.

**Fingerprint length: 16 hex characters** (64 bits of the SHA-256 digest), identical on every
platform — `Fingerprint.prefixLength` in AutorotateCore and `fingerprint()` in
`apps/web/api/autorotate/crypto.ts`. This spec previously said 8 while the web engine already
kept 16 and Apple kept 8, so a cross-platform drift comparison mismatched by construction.
Records written by an Apple build older than 2026-08-26 hold 8 characters; comparison goes
through `Fingerprint.matches(_:_:)`, which compares on the shorter of the two lengths so those
records do not all report drift on upgrade.

### Audit hash chain

The audit log is append-only **and** hash-chained on both platforms (AGENTS.md invariant 2).
Each entry carries `prevHash` (the previous entry's `entryHash`, or 64 zeros for the first
chained entry) and `entryHash` = full 64-character lowercase hex SHA-256 over a canonical
serialization of the entry including `prevHash`. The canonical form is a hand-written JSON
object — fixed alphabetical field order, no whitespace, `detail` keys sorted by UTF-8 bytes,
timestamps as **integer milliseconds since epoch** so a store's date round-trip cannot change
the hash. The normative definition lives in
`apple/AutorotateCore/Sources/AutorotateCore/AuditChain.swift`.

Entries persisted before chaining shipped have neither field. Verification treats them as a
pre-chain prefix: it skips them, reports how many it skipped, and starts at the first chained
entry, so upgrading an existing install never reports a false break.


## 7. Web data model (Drizzle / MySQL)

- `connectors` (id, platform, displayName, capability, configEnc, createdAt)
- `secrets` (id, name, connectorId, status, policyJson, lastRotatedAt, version, fingerprint)
- `targets` (id, secretId, kind: infisical|file|webhook|keychain, configJson, enabled)
- `rotationRuns` (id, secretId, startedAt, finishedAt, status, stepsJson)
- `auditLog` (id, ts, actor, action, secretId, detailJson)

## 8. API surface (tRPC)

- `connectors.list/create/update/delete/test`
- `secrets.list/get/create/update/delete`
- `secrets.rotateNow(secretId)` → runs pipeline server-side
- `targets.upsert/remove`
- `policies.set` (intervalHours, autoRotate, verify)
- `runs.list(secretId?)`, `audit.list(limit)`
- `scheduler.tick()` — internal: rotates due secrets (called by cron / on server boot)
