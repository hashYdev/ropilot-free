#!/usr/bin/env bash
#
# Build Ropilot Studio (free) from the source in app/.
#
#   bash build.sh              # stage the runtime, pack app/, verify
#   bash build.sh --exe        # ... then compress the installer with makensis
#
# The Electron runtime is not vendored. It is 176 MB for its main binary alone,
# well over GitHub's per-file limit, and it is open source — so it is fetched
# from the Electron release for the version Ropilot actually ships against and
# cached in .cache/.
#
# Everything under app/ is editable. Change a line, run this, get a new
# installer.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

# The version Ropilot Studio 1.3.2 ships against — from its own package.json
# allowScripts block, which also names esbuild 0.24.2 as the bundler that
# produces main.min.js.
ELECTRON_VERSION=28.3.3
ELECTRON_ARCH=x64
PRODUCT="Ropilot Studio"

CACHE="$ROOT/.cache"
RUNTIME="$CACHE/electron-v$ELECTRON_VERSION-win32-$ELECTRON_ARCH"
STAGE="$ROOT/build/stage"
ASAR="$ROOT/app"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# ── 1. the runtime ──────────────────────────────────────────────────────────
step "1/5  electron $ELECTRON_VERSION (win32-$ELECTRON_ARCH)"
if [[ -x "$RUNTIME/electron.exe" ]]; then
  echo "     cached"
else
  mkdir -p "$CACHE"
  ZIP="$CACHE/electron-v$ELECTRON_VERSION-win32-$ELECTRON_ARCH.zip"
  if [[ ! -f "$ZIP" ]]; then
    URL="https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-win32-$ELECTRON_ARCH.zip"
    echo "     downloading $URL"
    curl -fL --progress-bar -o "$ZIP.part" "$URL"
    mv "$ZIP.part" "$ZIP"
  fi
  rm -rf "$RUNTIME"
  mkdir -p "$RUNTIME"
  unzip -q -o "$ZIP" -d "$RUNTIME"
  echo "     unpacked $(find "$RUNTIME" -type f | wc -l) files"
fi

# ── 2. stage ────────────────────────────────────────────────────────────────
step "2/5  stage the runtime"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -a "$RUNTIME/." "$STAGE/"
# Electron's placeholder app; unused once resources/app.asar exists.
rm -f "$STAGE/resources/default_app.asar"
# The product binary. Electron decides it is packaged by the exe name, so this
# rename is what makes app.isPackaged true.
mv "$STAGE/electron.exe" "$STAGE/$PRODUCT.exe"
echo "     $PRODUCT.exe"

# ── 3. the app source ───────────────────────────────────────────────────────
step "3/5  pack app/ into resources/app.asar"
npx --yes @electron/asar pack "$ASAR" "$STAGE/resources/app.asar" >/dev/null
printf '     app.asar %s bytes\n' "$(stat -c %s "$STAGE/resources/app.asar")"

# ── 4. the parts with no source ─────────────────────────────────────────────
step "4/5  vendor binaries"
mkdir -p "$STAGE/resources/bin"
cp -a "$ROOT/vendor/resources/bin/." "$STAGE/resources/bin/"
cp "$ROOT/vendor/resources/elevate.exe" "$STAGE/resources/"
# Vestigial: names a publisher and a GitHub feed for an updater that is not in
# node_modules. Removing it means nothing can look for a newer app.asar.
rm -f "$STAGE/resources/app-update.yml"
ls -1 "$STAGE/resources/bin/" | sed 's/^/     bin\//'
echo "     elevate.exe"

# ── 5. verify, and optionally build the installer ───────────────────────────
step "5/5  verify"
node "$ROOT/verify.mjs"

if [[ "${1:-}" == "--exe" ]]; then
  step "compressing the installer (slow: LZMA solid over the whole tree)"
  makensis -V2 installer.nsi
  python3 verify-installer.py
fi

printf '\ndone\n'
