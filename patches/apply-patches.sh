#!/usr/bin/env bash
#
# Rebuild app/ from a stock Ropilot Studio install.
#
# app/ is committed already patched, so you only need this if you want to
# re-derive it — to move to a newer Ropilot version, or to read the passes
# against a clean tree.
#
#   bash patches/apply-patches.sh ~/ropilot/resources/app.asar
#   bash patches/apply-patches.sh /path/to/extracted/asar/dir
#
# Point it at a copy of app.asar from an install you already have. Nothing here
# downloads Ropilot. The passes run in order, each against the tree the previous
# one produced, and against a fresh extraction every time — so this is
# idempotent and safe to re-run.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
INPUT=${1:-}

if [[ -z "$INPUT" ]]; then
  cat >&2 <<'EOF'
usage: bash patches/apply-patches.sh <app.asar | extracted-asar-directory>

  The stock app.asar lives inside a Ropilot Studio install at:
    %LOCALAPPDATA%\Programs\ropilot\resources\app.asar
EOF
  exit 2
fi

[[ -e "$INPUT" ]] || { echo "no such file: $INPUT" >&2; exit 2; }

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# ── get a clean tree ────────────────────────────────────────────────────────
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if [[ -d "$INPUT" ]]; then
  step "copying the extracted tree"
  cp -a "$INPUT/." "$WORK/"
else
  step "extracting $INPUT"
  npx --yes @electron/asar extract "$INPUT" "$WORK"
fi
printf '     %s files\n' "$(find "$WORK" -type f | wc -l)"

# ── apply the passes, in order ──────────────────────────────────────────────
export ROPILOT_APP="$WORK"

step "pass 1 — neutralise the gates"
python3 "$HERE/patch.py"

step "pass 2 — strip the paid surface"
python3 "$HERE/patch2.py"

step "pass 3 — onboarding branch and upsell copy"
python3 "$HERE/patch3.py"

step "pass 4 — sidebar wiring and the reimbursement module"
python3 "$HERE/patch4.py"

step "pass 5 — delete the referral method bodies"
python3 "$HERE/patch5.py"

step "pass 6 — the no-ChatGPT onboarding branch"
python3 "$HERE/patch6.py"

step "pass 7 — startup calls about the paid product"
python3 "$HERE/patch7.py"

# ── syntax ──────────────────────────────────────────────────────────────────
step "parse every file the passes touched"
SYN=$(mktemp -d)
for f in \
  src/js/models/model-catalog.js \
  src/app.js \
  src/js/credits/credits-wall.js \
  src/js/credits/credit-reimbursement.js \
  src/js/message-renderer.js \
  src/js/composer/composer-dropdowns.js \
  src/js/composer/composer-footer.js \
  src/js/settings.js \
  src/js/setup-flow.js \
  src/js/message-sender.js \
  src/js/wiring/wire-modals.js \
  src/js/message-handler.js
do
  [[ -f "$WORK/$f" ]] || { printf '     missing  %s\n' "$f"; continue; }
  cp "$WORK/$f" "$SYN/$(basename "$f").mjs"
  node --check "$SYN/$(basename "$f").mjs"
  printf '     ok  %s\n' "$f"
done
rm -rf "$SYN"

# ── install it as app/ ──────────────────────────────────────────────────────
step "replace app/"
rm -rf "$ROOT/app"
mkdir -p "$ROOT/app"
cp -a "$WORK/." "$ROOT/app/"
printf '     %s files\n' "$(find "$ROOT/app" -type f | wc -l)"

printf '\napp/ rebuilt. Now:  bash build.sh --exe\n'
