#!/usr/bin/env bash
# Build AnotherNotes for the Mac and open it, with its logs in this terminal.
#
#   scripts/run-mac.sh                          the live site, packaged .app
#   scripts/run-mac.sh http://100.49.56.40/     a test server instead
#   scripts/run-mac.sh --dev [url]              from source with Electron, no .app (fastest)
#   scripts/run-mac.sh --dist [url]             also build the universal .dmg
#   scripts/run-mac.sh --key [url]              ask for the maintenance-gate team key first
#   scripts/run-mac.sh --renderer [url]         rebuild the bundled web app first (scripts/build-renderer.sh)
#   scripts/run-mac.sh --site [url]             load the site in the window instead of the bundle
#
# Environment: ANOTHERNOTES_URL and ANOTHERNOTES_API_URL as in the README, and
# ANOTHERNOTES_PREVIEW_KEY (the gate key; stored by the app on first use, see README).
# Ctrl-C here quits the app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE=pack
ASK_KEY=0
RENDERER=auto
for arg in "$@"; do
  case "$arg" in
    --dev) MODE=dev ;;
    --dist) MODE=dist ;;
    --key) ASK_KEY=1 ;;
    --renderer) RENDERER=build ;;
    --site) RENDERER=site ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) export ANOTHERNOTES_URL="$arg" ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

# 1. Node 22 or later (Electron 44 needs it). Use nvm and .nvmrc if the shell has an older one.
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }
if [ "$(node_major)" -lt 22 ] 2>/dev/null || ! command -v node >/dev/null; then
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm use >/dev/null 2>&1 || nvm install >/dev/null
  fi
fi
if [ "$(node_major)" -lt 22 ] 2>/dev/null; then
  echo "Node 22 or later is required; found $(node -v). Install it with 'nvm install 22'." >&2
  exit 1
fi
say "node $(node -v), npm $(npm -v)"

# 2. Dependencies, including the Electron binary (missing when npm ci ran under an old Node).
if [ ! -d node_modules ] || ! node -e "require('electron')" >/dev/null 2>&1; then
  say "installing dependencies"
  npm ci
fi

# 3. codesign refuses files carrying Finder or iCloud metadata, and iCloud Drive stamps
#    everything under a synced folder (Desktop, Documents). Keep the build output elsewhere.
in_icloud() {
  local d="$1"
  while [ "$d" != "/" ]; do
    xattr -l "$d" 2>/dev/null | grep -q 'com.apple.file-provider' && return 0
    d="$(dirname "$d")"
  done
  return 1
}
if [ "$MODE" != dev ] && [ ! -L release ] && in_icloud "$ROOT"; then
  OUT="$HOME/Library/Caches/anothernotes-release"
  say "project is in an iCloud-synced folder; building into $OUT (release -> symlink)"
  rm -rf release
  mkdir -p "$OUT"
  ln -s "$OUT" release
fi

# 4. The app allows one running copy; a second launch would quit silently.
DEV_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if pgrep -x AnotherNotes >/dev/null || pgrep -f "$DEV_BIN" >/dev/null; then
  say "quitting the running copy"
  pkill -x AnotherNotes 2>/dev/null || true
  pkill -f "$DEV_BIN" 2>/dev/null || true
  sleep 1
fi

# 5. The maintenance-gate key, typed here so it never lands in shell history.
if [ "$ASK_KEY" = 1 ] && [ -z "${ANOTHERNOTES_PREVIEW_KEY:-}" ]; then
  read -rs -p "Team key (hidden): " ANOTHERNOTES_PREVIEW_KEY
  echo
  export ANOTHERNOTES_PREVIEW_KEY
fi

# 6. The web app's bundle, served from the app's own origin (src/main/renderer.ts). Built
#    when missing or asked for; --site skips it and loads the site in the window instead.
case "$RENDERER" in
  site) export ANOTHERNOTES_SITE=1 ;;
  build) scripts/build-renderer.sh ;;
  auto) [ -f renderer/index.html ] || scripts/build-renderer.sh ;;
esac

# 7. Build, then run in the foreground: the app prints its own and the web app's console
#    output here. ELECTRON_ENABLE_LOGGING=1 in the environment adds Chromium's own.
say "app URL: ${ANOTHERNOTES_URL:-https://anothernote.app/dashboard (default)}"
case "$MODE" in
  dev)
    say "building from source and starting Electron"
    npm run build
    exec node_modules/.bin/electron .
    ;;
  pack)
    say "building release/<arch>/AnotherNotes.app"
    npm run pack
    ARCH_DIR="mac-$(uname -m | sed 's/x86_64/x64/')"
    [ -d "release/$ARCH_DIR" ] || ARCH_DIR=mac
    APP="release/$ARCH_DIR/AnotherNotes.app"
    ;;
  dist)
    say "building the universal .app and .dmg"
    npm run dist:mac
    APP="release/mac-universal/AnotherNotes.app"
    ls -1 release/*.dmg
    ;;
esac
say "starting $APP"
exec "$APP/Contents/MacOS/AnotherNotes"
