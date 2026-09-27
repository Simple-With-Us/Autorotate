#!/usr/bin/env bash
# Manual Apple release only.  Select one target; validate its archive before upload.
set +o xtrace
set -euo pipefail
umask 077
validate_only=0
if [[ "${1:-}" == --validate-only ]]; then validate_only=1; shift; fi
platform="${1:-}"
build_number="${2:-}"
case "$platform" in
  ios) scheme=Autorotate-iOS; destination='generic/platform=iOS'; bundle=codes.autorotate.ios ;;
  macos) scheme=Autorotate-macOS; destination='generic/platform=macOS'; bundle=codes.autorotate.macos ;;
  *) echo 'Choose ios or macos.' >&2; exit 1 ;;
esac
[[ "$build_number" =~ ^[1-9][0-9]*$ && ${#build_number} -le 18 ]] || { echo 'Supply a positive numeric build number (up to 18 digits).' >&2; exit 1; }
if [[ "$validate_only" == 1 ]]; then exit 0; fi
: "${RUNNER_TEMP:?Run on the hosted release runner}"
: "${ASC_KEY_PATH:?ASC_KEY_PATH required}"
: "${ASC_KEY_ID:?ASC_KEY_ID required}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID required}"
[[ -s "$ASC_KEY_PATH" ]] || { echo 'Staged ASC key file is missing.' >&2; exit 1; }
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_dir="$(mktemp -d "$RUNNER_TEMP/autorotate-release.XXXXXX")"
archive="$release_dir/Autorotate.xcarchive"
auth=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
xcodebuild -project "$repo_root/apple/Autorotate.xcodeproj" -scheme "$scheme" \
  -configuration Release -destination "$destination" -archivePath "$archive" \
  archive CURRENT_PROJECT_VERSION="$build_number" "${auth[@]}"
python3 "$repo_root/scripts/validate-apple-release-archive.py" "$archive" "$platform" "$bundle" "$build_number"
python3 - "$release_dir/export-options.plist" <<'PY'
import pathlib, plistlib, sys
pathlib.Path(sys.argv[1]).write_bytes(plistlib.dumps({
    'method': 'app-store-connect', 'destination': 'upload',
    'teamID': 'CC8UTF7ATG', 'signingStyle': 'automatic',
    'manageAppVersionAndBuildNumber': False,
}))
PY
xcodebuild -exportArchive -archivePath "$archive" \
  -exportOptionsPlist "$release_dir/export-options.plist" -exportPath "$release_dir/export" "${auth[@]}"
printf 'Upload command completed for %s build %s.  Verify ASC processing and beta review before publishing an invite.\n' "$bundle" "$build_number"
