# Autorotate current-bundle TestFlight readiness — 2026-09-27

The owner authorized external iOS testing.  The current iOS source bundle is
`codes.autorotate.ios`; the existing public TestFlight app with bundle
`codes.autorotate` is a legacy build and remains untouched.  No current-bundle
App Store Connect app, uploaded build, or public invite exists yet.

## Apple Developer state

- Explicit Bundle ID `codes.autorotate.ios` registered as `2K9P3D8VVZ` for
  team `CC8UTF7ATG`.
- APP_GROUPS and ASSOCIATED_DOMAINS capabilities enabled, matching the iOS
  entitlements in `apple/Autorotate-iOS/Autorotate.entitlements`.
- Active App Store distribution profile `B2588DKF28`, UUID
  `6ab15488-b9c6-481f-a0c9-5f4ca80b0dfc`, created with the existing team
  distribution certificate.  Decoded profile has the correct
  `CC8UTF7ATG.codes.autorotate.ios` application identifier but an empty
  App Groups entitlement.  The source requires `group.codes.autorotate`.
  Register/associate that group in the Apple Developer website and generate
  a replacement profile before a signed archive.

## Source and release gates

- `apple/project.yml` pins the iOS target to marketing version `1.0.1` for
  its first current-bundle build.  The macOS target retains its separate
  inherited version and bundle ID.  Keep the iOS build number monotonic on
  subsequent uploads.
- Create a new iOS App Store Connect app record in the authenticated website
  with bundle `codes.autorotate.ios`, primary locale `en-US`, and a unique SKU
  such as `autorotate-ios`.  Apple's public Apps API cannot create new apps.
  Check name availability in the form before choosing final display metadata.
- The existing `.github/workflows/testflight.yml` uses direct secret
  environment injection.  Do not dispatch it with the current signing key.
  Replace its credential handling with the fleet-approved file-loading path,
  then scope upload to the new iOS app record and publish factual What to
  Test.  Retain the legacy app and its working public beta during migration.
- Validate bundle ID, profile entitlements, signed archive, ASC build
  processing, export compliance, and beta review before publishing a new
  public TestFlight URL.  The old invite is not evidence for the new bundle.

Tracking: [Autorotate #246](https://github.com/jaywedgeworth22/Autorotate/issues/246),
fleet release [#296](https://github.com/jaywedgeworth22/AI-Fleet-Coordinator/issues/296),
effort board `d4e31b2497ba4910a2d16abca4d28165`.
