# Autorotate — Status

> **2026-09-22 archaeology note:** the `codes.autorotate` (iOS) and `codes.autorotate.shared` (Keychain Sharing) strings in this file reflect the **2026-08-22 rebrand** and remain verbatim as the historical record of that rebrand.  The current iOS bundle ID is `codes.autorotate.ios` — see `docs/rollouts/2026-09-22-bundle-id-migration.md`.  macOS bundle (`codes.autorotate.macos`) is unchanged.

## Current Handoff

### 2026-09-27 CODEX — Manual Apple release preparation

Issue #265, board `a7493915`: TestFlight Publish selects iOS or macOS explicitly, stages the ASC key through a private file, validates the archive bundle/build/profile/App Group, and then exports to ASC.  Synthetic credential/metadata tests pass; signing and upload are not yet verified.  The owner must replace the exposed shared key, configure this app's Infisical signing values and verify its profile before dispatch.  See `docs/rollouts/2026-09-27-manual-apple-release.md`.

### 2026-09-18 CURSOR — Effort Issues Sync Crons margin (FLEET-INFRA-CD)

Daily `41 5 * * *` board mirror always succeeds; GitHub starts it 3.6-5.3h late so the 15-minute Sentry margin pages at 05:56Z.  Same override as ST #3194 / #3387 / #3389: `CHECKIN_MARGIN_OVERRIDES["Effort Issues Sync"] = 600`.  Cron unchanged.  Extra-ship no.  No Coolify.  Do not resolve CD on merge — wait for the next scheduled upsert of `ci-autorotate-effort-issues-sync`.  Rollout: `docs/rollouts/2026-09-18-effort-issues-sync-monitor-margin.md`.

### 2026-09-01 GROK — Web Sentry SDK (`grok/sentry-fleet-adoption`)

Client `@sentry/react` (DSN-gated, `sendDefaultPii: false`, replay 0% session / 100% error, no feedback widget) plus Node scheduler cron + `rotation.success` / `rotation.fail`.  Rollout: `docs/rollouts/2026-09-01-web-sentry-sdk.md`.  **Android Sentry is iOS-only until Android ships.**

## Current Handoff (Apple IDs)

### 2026-08-22 CURSOR — Owner App IDs (do not use Grok #50)

Git IDs are on AG PR #48.  Duplicate #50 stays closed.  Need owner: Developer
portal App IDs `codes.autorotate` / `codes.autorotate.macos` with Keychain
Sharing group `codes.autorotate.shared`.  ASC New App has no capability list.
Site https://autorotate.codes.  Cheat sheet
`docs/rollouts/2026-08-22-autorotate-apple-ids.md`.  #48 is still CONFLICTING
with `main` — rebase is AG/land, not a merge of `grok/autorotate-ids`.

### 2026-08-22 ANTIGRAVITY — Autorotate Rebrand (`autorotate.codes`), Android Companion App & Bidirectional Board Sync

1. **Rebranding**: Rebranded app to **Autorotate** across all platforms with domain `autorotate.codes`. Configured Apple bundle IDs `codes.autorotate`, `codes.autorotate.macos`, and `codes.autorotate.shared`. Linked developer account (Jay Wedgeworth, LLC, `CC8UTF7ATG`), set minimum iOS 17.0 / macOS 14.0, Xcode document format 26ish, category `public.app-category.developer-tools`.
2. **Android Companion App**: Created native Android companion app (`android/`) with Kotlin + Jetpack Compose (Material 3), BiometricPrompt security gating, live QR code pairing scanner, .env batch importer, and periodic WorkManager sync.
3. **Apple Apps**: Verified `Autorotate.xcodeproj` builds cleanly with `xcodebuild` for both `Autorotate-iOS` and `Autorotate-macOS`. AutorotateCore package tests (27/27) pass with zero failures.
4. **Web Control Center**: Rebranded web console (`apps/web`), updated index.html metadata, package name `autorotate-web`, pairing modal, and navigation headers.
5. **Bidirectional Board Sync**: Deployed `mac-collab-writeback` pm2 daemon in `~/apps/mac-collab/` to keep THE BOARD (`mac.jays.services/board`), live effort-log markdown files, and GitHub Issues bidirectionally synchronized in real-time.

## Status

| Component | State |
|---|---|
| Web control center (`apps/web/`) | Rebranded to Autorotate (`autorotate.codes`), `check` + `build` + unit tests passing. |
| AutorotateCore (`apple/AutorotateCore/`) | `swift test` — 27/27 passing locally. |
| iOS app (`apple/Autorotate-iOS/`) | Local `xcodebuild` **BUILD SUCCEEDED** for `Autorotate-iOS` (bundle `codes.autorotate`, iOS 17+). |
| macOS app (`apple/Autorotate-macOS/`) | Local `xcodebuild` **BUILD SUCCEEDED** for `Autorotate-macOS` (bundle `codes.autorotate.macos`, macOS 14+). |
| Android app (`android/`) | Kotlin + Jetpack Compose (`codes.autorotate`) with Biometrics, QR scanner, and .env parser. |
| Bidirectional Board Sync | `mac-collab-writeback` pm2 daemon active and writing back board updates to effort logs & GitHub Issues. |
| CI | `web` + `apple` + gitleaks secret scan. |


PR #16 merged to `main` (`c1f12a5`). Effort Issues Sync run 32458648310
succeeded. Remaining: Dependabot #1–15 rebase/merge; owner dashboard
(branch protection, Infisical, ASC, SENTRY_FLEET_DSN). Architecture and
invariants: `docs/architecture.md`. Fleet protocol: `AGENTS.md` §
Inter-agent coordination.
