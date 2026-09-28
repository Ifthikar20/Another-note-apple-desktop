#!/usr/bin/env bash
# Build the web app (playstudy-card-dash) and copy its production bundle into renderer/,
# which the desktop app serves from its own origin and packages (src/main/renderer.ts).
#
#   scripts/build-renderer.sh                                   clone/update .web/ from GitHub, build
#   ANOTHERNOTES_WEB_DIR=../playstudy-card-dash scripts/build-renderer.sh   a checkout you already have
#   ANOTHERNOTES_WEB_REF=main scripts/build-renderer.sh         a branch or tag (the .web/ clone only)
#
# The build is `npm run build:off` (Turnstile off, API at the relative /api), the same
# profile deploy-aws.sh ships by default. VITE_* variables in the environment override it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_REPO="${ANOTHERNOTES_WEB_REPO:-https://github.com/Ifthikar20/playstudy-card-dash}"
WEB_DIR="${ANOTHERNOTES_WEB_DIR:-$ROOT/.web}"
WEB_REF="${ANOTHERNOTES_WEB_REF:-}"
OUT="$ROOT/renderer"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

# Node 22 or later, as in run-mac.sh: nvm and .nvmrc, with npm_config_prefix dropped for this
# script (nvm refuses to run with it set), else the Node 22 nvm installed, found by its path.
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }
if [ "$(node_major)" -lt 22 ] 2>/dev/null || ! command -v node >/dev/null; then
  unset npm_config_prefix NPM_CONFIG_PREFIX PREFIX
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    set +u
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 || true
    nvm use 22 >/dev/null 2>&1 || nvm install 22 >/dev/null 2>&1 || true
    set -u
  fi
  if [ "$(node_major)" -lt 22 ] 2>/dev/null || ! command -v node >/dev/null; then
    for dir in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v2[2-9]*/bin "${NVM_DIR:-$HOME/.nvm}"/versions/node/v[3-9][0-9]*/bin; do
      [ -x "$dir/node" ] && PATH="$dir:$PATH"
    done
  fi
fi
if [ "$(node_major)" -lt 22 ] 2>/dev/null; then
  echo "Node 22 or later is required; found $(node -v 2>/dev/null || echo none). Install it with 'nvm install 22'." >&2
  exit 1
fi

if [ "$WEB_DIR" = "$ROOT/.web" ]; then
  if [ ! -d "$WEB_DIR/.git" ]; then
    say "cloning $WEB_REPO into .web/"
    git clone --quiet "$WEB_REPO" "$WEB_DIR"
  elif git -C "$WEB_DIR" symbolic-ref -q HEAD >/dev/null; then
    say "updating .web/"
    git -C "$WEB_DIR" pull --ff-only --quiet
  fi
  if [ -n "$WEB_REF" ]; then git -C "$WEB_DIR" checkout --quiet "$WEB_REF"; fi
elif [ ! -f "$WEB_DIR/package.json" ]; then
  echo "No web app at $WEB_DIR (ANOTHERNOTES_WEB_DIR)." >&2
  exit 1
fi

cd "$WEB_DIR"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "installing the web app's dependencies"
  npm ci --no-audit --no-fund
fi
say "building the web app (build:off)"
npm run build:off

say "copying the bundle into renderer/"
rm -rf "$OUT"
cp -R "$WEB_DIR/dist" "$OUT"
printf '%s %s\n' "$(git -C "$WEB_DIR" rev-parse --short HEAD 2>/dev/null || echo local)" "$(date -u +%Y-%m-%dT%H:%MZ)" > "$OUT/BUILD"
say "renderer/ is $(cat "$OUT/BUILD") ($(du -sh "$OUT" | cut -f1))"
