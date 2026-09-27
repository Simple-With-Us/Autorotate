#!/usr/bin/env bash
# Synthetic key and certificate only. No Apple services or credentials.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home" "$tmp/runner"
cat > "$tmp/bin/sw_vers" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == -productVersion ]]; then echo 15.7; else echo 24G720; fi
SH
cat > "$tmp/bin/security" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == import && "${ASC_TEST_FAIL_IMPORT:-}" == 1 ]]; then exit 1; fi
if [[ "${1:-}" == find-identity ]]; then echo 'Apple Distribution synthetic'; fi
SH
chmod 700 "$tmp/bin/sw_vers" "$tmp/bin/security"
run() {
  env -u ASC_KEY_PATH HOME="$tmp/home" RUNNER_TEMP="$tmp/runner" \
    PATH="$tmp/bin:$PATH" ASC_KEY_ID=synthetic-id ASC_ISSUER_ID=synthetic-issuer \
    ASC_KEY_P8=synthetic-private-key IOS_DIST_P12_BASE64=c3ludGhldGlj \
    IOS_DIST_P12_PASSWORD=synthetic-password ASC_TEST_FAIL_IMPORT="${1:-0}" \
    bash "$repo_root/scripts/ios-appstore-gm-prepare.sh" > "$tmp/out" 2> "$tmp/err"
}
run
[[ ! -e "$tmp/home/.secrets/AuthKey.p8" ]]
[[ "$(find "$tmp/runner" -type f | wc -l | tr -d ' ')" == 1 ]]
[[ -f "$tmp/runner/app-signing-kc-pass" ]]
[[ "$(find "$tmp/runner" -type d -name 'autorotate-asc-key.*' | wc -l | tr -d ' ')" == 0 ]]
if run 1; then echo 'expected synthetic import failure' >&2; exit 1; fi
[[ "$(find "$tmp/runner" -type f | wc -l | tr -d ' ')" == 1 ]]
[[ "$(find "$tmp/runner" -type d -name 'autorotate-asc-key.*' | wc -l | tr -d ' ')" == 0 ]]
if grep -Fq synthetic-private-key "$tmp/out" "$tmp/err"; then
  echo 'synthetic key leaked to output' >&2; exit 1
fi
echo 'synthetic fallback cleanup passed'
