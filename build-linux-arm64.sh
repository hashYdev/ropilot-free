#!/usr/bin/env bash
#
# Build Ropilot Studio Free for linux/arm64.
#
#   bash build-linux-arm64.sh
#
# The Windows installer is the primary build. This one exists because Ropilot's
# own Linux build is x86_64, and the shipped bridge — ropilot-infra — is x86_64
# too, so neither runs on an arm64 machine. Electron ships linux-arm64, the
# client code is plain JavaScript, and the bridge can be rebuilt from source
# in bridge/, so the whole thing ports over.
#
# Two things come from Ropilot's own x86_64 Linux AppImage and are not
# rebuildable:
#
#   * the client tree (app/) — patched in place, and the same tree the Windows
#     build uses
#   * ropilot-infra — the Go bridge, replaced by bridge/ here
#
# So the only input this needs is the AppImage, for the x86_64 AppImage:
#
#   bash build-linux-arm64.sh /path/to/Ropilot-Studio-x86_64.AppImage
#
# Electron 28.3.3 is fetched, not vendored, for the same reason as the Windows
# build: 176 MB for the main binary.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

ELECTRON_VERSION=28.3.3
ELECTRON_ARCH=arm64
PRODUCT="ropilot"
CACHE="$ROOT/.cache"
RUNTIME="$CACHE/electron-v$ELECTRON_VERSION-linux-$ELECTRON_ARCH"
STAGE="$ROOT/build/stage-linux-arm64"
APPIMAGE=${1:-}

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# ── the Electron runtime ─────────────────────────────────────────────────────
step "1/6  electron $ELECTRON_VERSION (linux-$ELECTRON_ARCH)"
if [[ -x "$RUNTIME/electron" ]]; then
  echo "     cached"
else
  mkdir -p "$CACHE"
  ZIP="$CACHE/electron-v$ELECTRON_VERSION-linux-$ELECTRON_ARCH.zip"
  if [[ ! -f "$ZIP" ]]; then
    URL="https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-linux-$ELECTRON_ARCH.zip"
    echo "     downloading $URL"
    curl -fL --progress-bar -o "$ZIP.part" "$URL"
    mv "$ZIP.part" "$ZIP"
  fi
  rm -rf "$RUNTIME"; mkdir -p "$RUNTIME"
  unzip -q -o "$ZIP" -d "$RUNTIME"
fi

# ── the bridge, rebuilt for this arch ────────────────────────────────────────
step "2/6  build the bridge for linux/$ELECTRON_ARCH"
if ! command -v go >/dev/null 2>&1; then
  echo "     ! go is not installed — the bridge is the one piece that has to be"
  echo "       compiled for the target; install go 1.26+ and re-run"
  exit 1
fi
( cd "$ROOT/bridge" && CGO_ENABLED=0 GOOS=linux GOARCH="$ELECTRON_ARCH" \
    go build -trimpath -ldflags="-s -w" -o "$ROOT/build/ropilot-infra" . )
printf '     ropilot-infra %s bytes\n' "$(stat -c %s "$ROOT/build/ropilot-infra")"

# ── the client tree, straight from the repo ──────────────────────────────────
step "3/6  stage the app"
rm -rf "$STAGE"; mkdir -p "$STAGE/resources/bin"
cp -a "$RUNTIME/." "$STAGE/"
rm -f "$STAGE/resources/default_app.asar"
mv "$STAGE/electron" "$STAGE/$PRODUCT"
chmod +x "$STAGE/$PRODUCT"
npx --yes @electron/asar pack "$ROOT/app" "$STAGE/resources/app.asar" >/dev/null
printf '     app.asar %s bytes\n' "$(stat -c %s "$STAGE/resources/app.asar")"

# ── the binaries with no source ──────────────────────────────────────────────
step "4/6  vendor binaries"
cp "$ROOT/vendor/resources/bin/ropilot-infra.exe" "$STAGE/resources/bin/" 2>/dev/null || true
cp "$ROOT/vendor/resources/elevate.exe" "$STAGE/resources/" 2>/dev/null || true
# The x86_64 bridge cannot run here, and the one built above replaces it.
rm -f "$STAGE/resources/bin/ropilot-infra.exe"
cp "$ROOT/build/ropilot-infra" "$STAGE/resources/bin/ropilot-infra"
chmod +x "$STAGE/resources/bin/ropilot-infra"
rm -f "$STAGE/resources/app-update.yml"
ls -1 "$STAGE/resources/bin/" | sed 's/^/     bin\//'

# ── verify ───────────────────────────────────────────────────────────────────
step "5/6  verify"
node "$ROOT/verify.mjs"

# ── run it ───────────────────────────────────────────────────────────────────
step "6/6  run"
cat <<'EOF'
     Launch it against a display:

       export DISPLAY=:1
       ./build/stage-linux-arm64/ropilot \
         --no-sandbox --disable-setuid-sandbox \
         --in-process-gpu --disable-gpu --disable-gpu-compositing \
         --disable-dev-shm-usage

     On a phone or a proot container the GPU process cannot be forked, so
     --in-process-gpu is what keeps it alive. Without it Chromium aborts with
     "GPU process isn't usable".
EOF
printf '\ndone — %s\n' "$STAGE"
