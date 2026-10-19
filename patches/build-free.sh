#!/usr/bin/env bash
#
# Build Ropilot Studio (free).
#
#   bash build-free.sh          # patch -> pack -> assemble -> verify
#   bash build-free.sh --exe    # ... then compress the installer with makensis
#
# Inputs are read-only:  /tmp/opencode/re/app  (the shipped Electron tree)
#                        /tmp/opencode/rp/orig (app.asar, extracted)
# Output:                /tmp/opencode/rp/win  (installable tree)
#                        /tmp/opencode/rp/Ropilot-Studio-Free-Setup.exe
set -euo pipefail

RP=/tmp/opencode/rp
SRC=/tmp/opencode/re/app

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "1/6  patched tree from pristine"
rm -rf "$RP/patched"
cp -a "$RP/orig" "$RP/patched"

step "2/6  pass 1 — neutralise the gates"
python3 "$RP/patch.py"

step "3/6  pass 2 — strip the paid surface"
python3 "$RP/patch2.py"

step "3b/6  pass 3 — onboarding branch and upsell copy"
python3 "$RP/patch3.py"

step "3c/6  pass 4 — sidebar wiring and the reimbursement module"
python3 "$RP/patch4.py"

step "3d/6  pass 5 — delete the referral method bodies"
python3 "$RP/patch5.py"

step "3e/6  pass 6 — the no-ChatGPT onboarding branch"
python3 "$RP/patch6.py"

step "3f/6  pass 7 — startup calls about the paid product"
python3 "$RP/patch7.py"

step "4/6  syntax"
mkdir -p "$RP/syn"
for f in src/js/models/model-catalog.js src/app.js src/js/credits/credits-wall.js \
         src/js/credits/credit-reimbursement.js \
         src/js/message-renderer.js src/js/composer/composer-dropdowns.js \
         src/js/composer/composer-footer.js src/js/settings.js src/js/setup-flow.js \
         src/js/message-sender.js \
         src/js/wiring/wire-modals.js src/js/message-handler.js; do
  cp "$RP/patched/$f" "$RP/syn/$(basename "$f").mjs"
  node --check "$RP/syn/$(basename "$f").mjs"
  printf '     ok  %s\n' "$f"
done

step "5/6  pack app.asar and assemble the windows tree"
rm -rf "$RP/win"
cp -a "$SRC" "$RP/win"
npx --yes @electron/asar pack "$RP/patched" "$RP/win/resources/app.asar" >/dev/null
# Vestigial: names a publisher and a GitHub feed for an updater that is not in
# node_modules. Removing it means nothing can look for a newer app.asar.
rm -f "$RP/win/resources/app-update.yml"
printf '     app.asar %s bytes\n' "$(stat -c %s "$RP/win/resources/app.asar")"
printf '     tree     %s\n' "$(du -sh "$RP/win" | cut -f1)"

step "6/6  verify"
node "$RP/verify.mjs"

if [[ "${1:-}" == "--exe" ]]; then
  step "compressing the installer (this is the slow one)"
  cd "$RP" && makensis -V2 installer.nsi
  ls -l "$RP/Ropilot-Studio-Free-Setup.exe"
  sha256sum "$RP/Ropilot-Studio-Free-Setup.exe"
fi

printf '\ndone\n'
