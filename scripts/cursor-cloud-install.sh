#!/usr/bin/env bash
# Cursor cloud agent install script for Autorotate.
#
# Runs during the Cursor cloud Build phase.  Persisted on the install disk,
# so re-runs must be idempotent and fast (no secret export here — that
# belongs in cursor-cloud-start.sh, which runs every agent boot).
#
# Targets: Ubuntu Linux only.  Native Apple / Android trees under apple/
# and android/ require Xcode / Android SDK and are skipped on Linux with a
# one-line note.
#
# Required Cursor dashboard secrets (org-wide):
#   - INFISICAL_CLIENT_ID
#   - INFISICAL_CLIENT_SECRET

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Cursor cloud install: Autorotate"
echo "==> Host: $(uname -srm 2>/dev/null || echo unknown)"

if [ "$(uname -s)" != "Linux" ]; then
  echo "==> ERROR: this script is Linux-only (got $(uname -s))." >&2
  exit 1
fi

# ── Node + npm ─────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "==> Installing Node.js + npm via NodeSource (Ubuntu)."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y nodejs >/dev/null
  else
    echo "==> ERROR: apt-get not found; cannot install Node.js." >&2
    exit 1
  fi
fi

echo "==> Node: $(node --version)  npm: $(npm --version)"

# ── Infisical CLI (official Linux install) ────────────────
if ! command -v infisical >/dev/null 2>&1; then
  echo "==> Installing Infisical CLI."
  curl -fsSL https://infisical.com/install.sh | bash -s -- >/dev/null
fi

if ! command -v infisical >/dev/null 2>&1; then
  echo "==> WARN: infisical CLI not available; start script will fall back to API fetch." >&2
else
  echo "==> Infisical CLI: $(infisical --version 2>/dev/null || echo installed)"
fi

# ── apps/web npm deps ─────────────────────────────────────
if [ -f "$REPO_ROOT/apps/web/package.json" ]; then
  echo "==> Installing apps/web dependencies (npm ci --include=dev)."
  npm ci --include=dev --prefix "$REPO_ROOT/apps/web"
else
  echo "==> ERROR: apps/web/package.json not found at $REPO_ROOT/apps/web." >&2
  exit 1
fi

# ── Playwright system deps for apps/web/e2e (best-effort) ─
if [ -f "$REPO_ROOT/apps/web/playwright.config.ts" ] && command -v apt-get >/dev/null 2>&1; then
  echo "==> Installing Playwright system dependencies (best-effort)."
  apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 \
    libatspi2.0-0 >/dev/null 2>&1 || \
    echo "==> WARN: Playwright system deps install skipped (will retry on first run)."
fi

# ── Skipped on Linux (Apple + Android require Mac / SDK) ─
cat <<'SKIP'

==> Skipping native builds on Linux:
    - apple/Autorotate-iOS, apple/Autorotate-macOS, apple/AutorotateCore (Xcode required)
    - android/ (Android SDK required)

SKIP

echo "==> Cursor cloud install: complete."