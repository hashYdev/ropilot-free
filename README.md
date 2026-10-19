# ropilot-free

Patch tooling that turns a copy of **Ropilot Studio** you already have into a
build with no credits, no checkout and no plan gating.

This repository contains **patches and build tooling only.** No Ropilot code, no
Ropilot binaries. You bring your own installed copy of the app; the scripts here
rewrite its JavaScript, repack it and build an installer.

---

## The build

`Ropilot-Studio-Free-Setup.exe` — 85.4 MB

```
sha256  68b09e2b6b59f62abf689dc8d85c9c2852591648148f918988faf2a71d1561f1
```

Verified by `verify-installer.py`, which unpacks the finished installer with
7z, pulls `app.asar` back out and diffs it against the one that was packed.
A stale installer cannot pass that.

---

## Why it's like this

Ropilot's paid surface is entirely client-side. The app has two ways to run a
model:

- **Bring your own** — it drives a Claude Code or Codex CLI you have installed
  and logged into. Inference runs against *your* account.
- **Ropilot Credits** — their hosted route. This is the thing you pay for.

The client ships gates for both. These patches remove them. Nothing about the
app's own features is rewritten; the gates are.

---

## What's here

```
patches/
  patch.py                    pass 1 — neutralise the gates
  patch2.py                   pass 2 — strip the purchase UI
  patch3.py                   pass 3 — onboarding branch and upsell copy
  patch4.py                   pass 4 — sidebar wiring, reimbursement module
  patch5.py                   pass 5 — delete the referral method bodies
  patch6.py                   pass 6 — the no-ChatGPT onboarding branch
  patch7.py                   pass 7 — startup calls about the paid product
  credits-wall.free.js        replacement for src/js/credits/credits-wall.js
  credit-reimbursement.free.js replacement for src/js/credits/credit-reimbursement.js
  installer.nsi               NSIS script for the installer
  build-free.sh               runs all of the above
  verify.mjs                  proves the gates are gone (19 checks)
  verify-installer.py         unpacks the installer and checks what's inside
```

### What the passes do

| # | Target | Change |
|---|--------|--------|
| 1 | `model-catalog.js` | Both hidden-model sets emptied — 8 models were hidden from the picker |
| 1 | `model-catalog.js` | The free-plan allow-list now derives from the whole catalog. A free ChatGPT plan went from 3 of 14 models to 14 of 14 |
| 1 | `app.js` | `isUseRopilotCreditsEnabled()` can only return `false` — the saved flag and `localStorage` are both ignored |
| 1 | `app.js` | `isCodexFreeAccount()` can only return `false` |
| 2 | `credits-wall.js` | Rewritten: was an out-of-credits card with a checkout button, auto top-up against a saved card, a fallback card injected into stored chats, a referral promo and telemetry |
| 2 | `credit-reimbursement.js` | Rewritten to a no-op |
| 2 | `message-renderer.js` | The second `$8` card, the one rendered into stored chats, is now a plain notice |
| 2 | `composer/*` | The "Ropilot Credits" mode toggle removed; upsell copy dropped |
| 2 | `wire-modals.js` | The Buy Credits shortcut to `/pricing` removed |
| 2 | `index.html` | Buy Credits button, referral widget, reimbursement dialog removed |
| 3 | `setup-flow.js` | Free-credits onboarding branch disabled; the "I don't have a ChatGPT account" button says what the build needs instead of calling `/api/ropilot-credit-free-offer` and dead-ending |
| 4 | `settings.js` | Buy Credits wiring and the Referral Program widget removed |
| 5 | `settings.js` | The referral method bodies deleted, not just short-circuited |
| 6 | `setup-flow.js` | The no-ChatGPT branch replaced with one honest sentence |
| 7 | `settings.js` | `refreshManagedAiCredits()` emptied — the `GET /api/ai/credits` on launch |
| 7 | `chat-manager.js` | `repairLatestManagedCreditsTurn()` emptied — the `GET /api/ai/credits/request?turn_id=` lookup |
| 7 | `main.min.js` | The update prompt removed — it checked for a newer version and offered to open the download page, which in a patched build is an invitation to reinstall the paid release |

`resources/app-update.yml` is dropped too. It's vestigial (there's no updater in
`node_modules`), but removing it means nothing can ever go looking for a newer
`app.asar` and quietly undo all of the above.

---

## Using it

You need a Ropilot Studio install to patch, plus `7z`, `node`, `npx`,
`makensis` and `python3`.

Edit the paths at the top of `patches/build-free.sh` — it expects:

```
RP   = your working directory
SRC  = the shipped Electron tree (the app folder from an installed copy)
orig = that tree's resources/app.asar, extracted
```

Then:

```bash
bash build-free.sh          # patch → pack app.asar → verify
bash build-free.sh --exe    # ... then compress the installer (this is slow)
```

---

## What it needs, and what it doesn't do

**It needs your own Claude Code or Codex login.** Install the CLI, sign in, then
pick that provider. That is the whole requirement.

It does not create free inference. There is no inference endpoint in the client
and no server-side key — the app talks to whatever CLI you have logged in. The
credits were the escape hatch from *your* usage limits, not the thing that made
it run. So:

- Models your own ChatGPT/Claude plan doesn't include will now *appear* in the
  picker, and your provider will still refuse them.
- With no CLI logged in there is nothing to run on. That was true of the paid
  build too.

`ropilot-infra.exe` — the Go backend that bridges to Roblox Studio — is left
alone. It is not the paywall; the paywall lives in `app.asar`.

## Verifying

`verify.mjs` imports the patched model catalog for real (it's a pure module, so
the gate sets get counted, not eyeballed) and scans both the working tree and the
packed `app.asar` for purchase paths — a URL that's unreachable but still in the
binary is still a URL.

```
19/19 PASSED
```

`verify-installer.py` unpacks the finished installer with 7z and diffs the
`app.asar` back out against the one that was packed, so a stale artifact can't
ship.

## Leaving it

Dead CSS selectors for the removed widgets (`.invite-widget*`, `.cic-invite*`)
are still in the stylesheets. They have no markup to match. Stripping CSS rule
blocks for a string that isn't reachable wasn't worth the risk of breaking
styling the rest of the UI shares those files with.

Internal route *labels* still say "Ropilot Credits" in a few places. Those name a
route this build cannot take.

## Licence

Ropilot Studio is not mine and these patches don't grant you a licence to it.
You need your own copy. Electron and Chromium licences ship inside the app.
