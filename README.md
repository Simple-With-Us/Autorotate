# Autorotate

[![CI](https://github.com/jaywedgeworth22/Autorotate/actions/workflows/ci.yml/badge.svg)](https://github.com/jaywedgeworth22/Autorotate/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](CHANGELOG.md)

Autorotate helps configure credential rotation, deliver updated values to selected targets, and review the results.  This repository includes a web control center and native Apple and Android clients; connector support varies by provider and platform.

[App overview](https://simplewithus.com/autorotate/) · [macOS beta on TestFlight](https://testflight.apple.com/join/5yDXA8Vk) · [Source releases](https://github.com/jaywedgeworth22/Autorotate/releases)

The web control center can be run from source.  The iOS release under the current bundle identifier is being prepared; a public install link is not available yet.

## What it does

- **Rotation workflow** — coordinates rotation, delivery, verification, and audit steps.  Some connectors support API-based rotation; others require an imported value or a local generator.
- **Configured targets** — includes Infisical, files, native credential stores, and HTTPS webhooks.  See the [connector capability matrix](docs/architecture.md) for implementation details and limitations.
- **Credential handling** — uses encrypted configuration and native credential stores where implemented.  A configured file target writes a credential to that file, so its permissions and backups still matter.
- **Run history** — records outcomes and supports checking a hash-chained audit history.  Failed or partial delivery may need operator follow-up; providers and targets do not share a universal rollback operation.
- **Mac agent** — remains a placeholder; the native macOS app is a separate client.

## Monorepo layout

```
Autorotate/
├── apps/
│   ├── web/                # Web control center (React + Vite frontend,
│   │                       #   Hono + tRPC + Drizzle backend, MySQL)
│   └── agent/              # Mac Python agent (stub placeholder only)
├── apple/                  # Apple-platform workspace (XcodeGen)
│   ├── AutorotateCore/        #   Shared SwiftPM package: rotation engine,
│   │                       #   connectors, crypto, Keychain, stores
│   ├── Autorotate-iOS/        #   iOS app (SwiftUI, iOS 17+, codes.autorotate.ios)
│   ├── Autorotate-macOS/      #   macOS app (SwiftUI, macOS 14+, codes.autorotate.macos)
│   └── project.yml         #   XcodeGen spec → Autorotate.xcodeproj
├── android/                # Android companion app (Kotlin + Compose, codes.autorotate)
│   ├── app/                #   Material 3, Biometrics, QR Scanner, .env Importer
│   └── build.gradle.kts    #   Gradle build spec
├── docs/
│   ├── architecture.md     # System architecture + connector capability matrix
│   └── build-plan.md       # Original build plan
├── .github/                # CI, release, CodeQL, Dependabot, templates
├── scripts/                # Repo automation (e.g. push-to-github.sh)
└── AGENTS.md               # Coordination manifest for AI agent fleets
```

## Quickstart

### Web control center (local development)

```bash
cd apps/web
cp .env.example .env        # fill in DATABASE_URL etc.
npm install
npm run db:push             # create schema
npm run db:seed             # optional demo data
npm run dev                 # start dev server
```

### Apple apps (iOS + macOS)

```bash
brew install xcodegen
cd apple
xcodegen generate
open Autorotate.xcodeproj
```

Or build/test just the shared core with SwiftPM:

```bash
cd apple/AutorotateCore
swift build && swift test
```

### Android companion app

```bash
cd android
./gradlew assembleDebug
```

To produce a signed release build locally, create `android/keystore.properties`
(never committed — see `.gitignore`) with `storeFile`, `storePassword`,
`keyAlias`, and `keyPassword`, then run `./gradlew assembleRelease`.  Without
that file the release build type is left unsigned rather than falling back to
the debug key.

## Sentry

Every surface (web client, web/Node server, iOS, macOS, Android) carries a
DSN-gated Sentry init that is a complete no-op when its DSN is unset — see
each platform's `.env.example` / Info.plist / `BuildConfig` for the DSN name.
Session Replay stays at 0% session-sample for the web and Android surfaces
(this is a secrets app); error-sample stays at 100% everywhere it's
supported.

Every event is tagged with a `release` derived from the deploying commit
(`VERCEL_GIT_COMMIT_SHA` / `SOURCE_COMMIT` / `GITHUB_SHA` for `apps/web`,
`CFBundleShortVersionString`+`CFBundleVersion` for iOS/macOS,
`versionName`+`versionCode` for Android) so a regression can be bisected to
the build that shipped it.

Source-map upload for `apps/web`'s client bundle is opt-in and requires
three env vars, none of which are set in CI today (so `npm run build` is
unchanged unless you set them locally or in a deploy environment):

| Var | Meaning | Default |
|---|---|---|
| `SENTRY_AUTH_TOKEN` | Project-scoped Sentry auth token — never a DSN.  Presence is the on/off switch for the whole upload step (`@sentry/vite-plugin`). | unset (upload off) |
| `SENTRY_ORG` | Sentry organization slug. | `jays-services` |
| `SENTRY_PROJECT` | Sentry project slug the maps are uploaded to — must match the project the corresponding DSN reports events into, or the maps deobfuscate nothing. | `autorotate-web` |

The [TestFlight workflow](.github/workflows/testflight.yml) archives Apple builds when signing and App Store Connect setup are complete.  The existence of a workflow does not indicate that a build has been published; use the app overview above for available downloads.

## Releases

Release assets vary by version.  Check [GitHub Releases](https://github.com/jaywedgeworth22/Autorotate/releases) for the files attached to a specific release; a source archive is not an installable app.  Generated packages belong in release assets rather than source control — see `.gitignore`.  A prior release (`1.0.0`) committed a debug-signed Android APK
and a development provisioning profile containing a hardware device UDID
directly to this public repo; both were removed, but the signing identity and
UDID were exposed in git history and **must be treated as public** going
forward (see `docs/AUDIT-2026-08-26.md`, findings AR-33 and AR-34).  The
debug keystore in particular is not a secret an owner can rotate — it ships
with every Android SDK install — so no additional action recovers
confidentiality for that artifact; the fix is that release builds are no
longer signed with it (see AR-13).

Cutting a release is now `git tag vX.Y.Z && git push origin vX.Y.Z`:
`.github/workflows/release.yml` creates the GitHub Release from
`CHANGELOG.md`, attaches the zipped `apple/` sources, and — once the
one-time upload-keystore secrets exist — builds and attaches a signed
Android release APK. See `android/RELEASE.md` for the one-time keystore
setup and the full flow.

## Documentation

- [Architecture & connector capability matrix](docs/architecture.md)
- [How the Grok and GitHub trees were merged](MERGE.md)
- [Build plan](docs/build-plan.md)
- [Apple workspace notes](apple/README.md) · [macOS notes](apple/README-macOS.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) ·
  [Changelog](CHANGELOG.md) · [Agent coordination](AGENTS.md)

## License

Apache License 2.0 — © 2026 Jay.  See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This project was previously distributed under the MIT License (placeholder
copyright "Autorotate Systems").  As of 2026-08-21 new copies are Apache-2.0.
Historical commits remain MIT as originally published.
 
