# Manual Apple release preparation — 2026-09-27

Module: repo tooling / CI.  Issue #265, board `a7493915`.

The earlier workflow built and uploaded macOS and iOS together and injected the
multiline ASC key into a step environment.  TestFlight Publish now selects exactly
one platform and uses the reviewed private-file signing handoff.  The iOS bundle
is `codes.autorotate.ios`; the macOS bundle remains `codes.autorotate.macos`.

## Inputs and prerequisites

Dispatch from `main` only.  Select `ios` or `macos`, supply a numeric build number
that exceeds that app's latest ASC build, and confirm `signing_ready` only after the
credential and profile prerequisites below are complete.  There is no push or
scheduled release trigger.

GitHub holds the Infisical project ID and machine identity:
`INFISICAL_PROJECT_ID`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`, and
`INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` (the legacy `INFISICAL_CLIENT_ID` and
`INFISICAL_CLIENT_SECRET` fallback remains supported).  The app's Infisical prod
root must hold the replacement `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`,
`IOS_DIST_P12_BASE64`, and `IOS_DIST_P12_PASSWORD`.  Old direct
`APPSTORE_API_*`/`IOS_DIST_P12_PASS` GitHub values are no longer read by this workflow.
Do not reuse the exposed shared key.  Both selected targets need a distribution
profile with `group.codes.autorotate`; the iOS target also retains its declared
Associated Domains and Keychain Sharing capabilities.  Portal/profile correction
is a separate release prerequisite.

## Implementation

- `ios-stage-asc-key.sh` creates a unique mode-700 temporary directory and mode-600
  key file from stdin; only its path crosses the Actions step boundary.
- `ios-appstore-gm-prepare.sh` imports the distribution identity into a temporary
  keychain, with tracing disabled and a restrictive umask.
- `apple-testflight-release.sh` chooses one scheme, archives with the requested
  build number and calls `validate-apple-release-archive.py` before upload.
- The validator rejects a wrong bundle/build, mismatched profile app/team, and
  missing profile or signed-app App Group.  It checks archive metadata, not just
  the source specification.
- Export uses Xcode's App Store Connect upload destination and the staged key file.
  It preserves the supplied build number.  Cleanup removes the temporary keychain,
  private key and local signing handoff files.

Runtime secret-storage, audit-chain and connector behavior are unchanged.
Signing tools require temporary private files on the ephemeral hosted runner;
those files are not product data, workflow artifacts or checked-in credentials.

## Validation and current limits

`bash scripts/test-ios-stage-asc-key.sh` passed using a fake Infisical CLI through
the actual workflow block; no PEM reached stdout, stderr or GITHUB_ENV.
`python3 scripts/test-apple-release.py` passed nine tests for iOS/macOS target
metadata, retired bundle rejection, build/profile/team/App Group checks and
manual input validation.  Shell syntax and diff checks passed.  Both tests run in
hosted CI before the web build; existing Apple unsigned CI remains unchanged.

No signing workflow was dispatched, credential replaced or profile changed by this
source-preparation unit.  A successful upload command still requires independent
ASC build processing, export-compliance and external-beta review checks before a
public invite can be advertised.  The current iOS ASC app is `6816633326`.
