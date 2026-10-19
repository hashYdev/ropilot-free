# Ropilot Studio — free build

The Ropilot Studio desktop client with its paid surface removed, plus the source
it builds from.

This is **not** a patcher and not a replacement app. `app/` is Ropilot's own
client code — 220 files, editable — with the changes applied. `build.sh` turns it
into a working installer. Change a line in `app/`, run the build, get a new
installer.

```
app/                            Ropilot's client source, patched — 220 files
vendor/resources/               the parts that ship as binaries (see below)
patches/                        the seven passes that produced app/, and the verifiers
build.sh                        app/ + Electron → installer
installer.nsi                   the Windows installer
verify.mjs                      19 checks against the source tree
verify-installer.py             opens the finished installer and checks what's inside
Ropilot-Studio-Free-Setup.exe   the built installer
```

---

## Building it

```
bash build.sh          # fetch Electron, stage the runtime, pack app.asar, verify
bash build.sh --exe    # ... then compress the installer and verify that too
```

`build.sh` fetches **Electron 28.3.3** for `win32-x64` and caches it in
`.cache/`. That is the version Ropilot 1.3.2 ships against — from its own
`package.json` `allowScripts` block, which also names `esbuild 0.24.2` as the
bundler behind `main.min.js`. Verified against a real install rather than
assumed: of the files the shipped runtime and the official Electron 28.3.3 zip
have in common, **all 69 are byte-identical**, and the file sets differ only by
Ropilot's own app files and the renamed binary.

Electron is not vendored because its main binary alone is 176 MB — over GitHub's
per-file limit — and it's open source, so the build fetches it. Everything else
needed to build is in this repo.

Needs `node`, `python3`, `7z` and `makensis`.

---

## What actually changed

Ropilot can run a model two ways: **bring your own** — it drives a Claude Code or
Codex CLI you're logged into, and inference runs against *your* account — or
**Ropilot Credits**, their hosted route. The client ships gates for both. This
build removes them.

| # | File | Change |
|---|------|--------|
| 1 | `src/js/models/model-catalog.js` | `ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES` and `ROPILOT_CREDITS_HIDDEN_MODEL_VALUES` emptied — 8 models were hidden from the picker |
| 2 | `src/js/models/model-catalog.js` | `CODEX_FREE_ALLOWED_MODELS` now derives from the whole catalog. A free ChatGPT plan was limited to 3 of 14 models; it's 14 of 14 |
| 3 | `src/app.js` | `isUseRopilotCreditsEnabled()` can only return `false`. The persisted flag and `localStorage` are both ignored, so every call site branching on paid-vs-BYO takes the BYO branch |
| 4 | `src/app.js` | `isCodexFreeAccount()` can only return `false` — plan no longer gates models, fast mode or defaults |
| 5 | `src/js/credits/credits-wall.js` | Rewritten. Was: an out-of-credits card with a checkout button, auto top-up charged against a saved card, a fallback card injected into stored chats, a referral promo and telemetry. Now: a plain "your own plan hit its limit" notice, no network calls at all |
| 6 | `src/js/credits/credit-reimbursement.js` | Rewritten to a no-op. It only announced that Ropilot had returned credits after a billing fault |
| 7 | `src/js/setup-flow.js` | The "claim your free starter credits" onboarding branch disabled; the "I don't have a ChatGPT account" button now says what this build needs instead of calling `/api/ropilot-credit-free-offer` and dead-ending |
| 8 | `src/js/settings.js` | Buy Credits wiring, the Referral Program widget and its `/api/ropilot-referral` fetch removed |
| 9 | `src/js/message-renderer.js` | The second `$8` card, the one rendered into stored chats, is now a plain notice |
| 10 | `src/js/composer/*` | The "Ropilot Credits" mode toggle removed; upsell copy dropped from the empty-picker hint and the priority tooltip |
| 11 | `src/js/wiring/wire-modals.js` | The Buy Credits shortcut to `/pricing` removed |
| 12 | `src/index.html` | Buy Credits button, referral widget and the credit-reimbursement dialog removed |
| 13 | `src/js/settings.js` | `refreshManagedAiCredits()` emptied — the `GET /api/ai/credits` call that ran from message handling and setup |
| 14 | `src/js/chat-manager.js` | `repairLatestManagedCreditsTurn()` emptied — it asked `GET /api/ai/credits/request?turn_id=` what a past turn had been billed |
| 15 | `main.min.js` | The update prompt removed. Two seconds after launch the main process checked `desktop-version.json` and offered to open `siteUrl/download` — in this build, an invitation to install the paid release back over the patch |

`resources/app-update.yml` is dropped as well. It names a publisher and a GitHub
feed for an updater that isn't in `node_modules` — vestigial, but removing it
means nothing can go looking for a newer `app.asar` and quietly undo all of the
above.

### Left alone on purpose

Dead CSS selectors for the removed widgets (`.invite-widget*`, `.cic-invite*`,
`credit-reimbursement.css`) are still in the stylesheets. They have no markup to
match, so they can't be clicked or seen. Stripping CSS rule blocks for a string
that isn't reachable wasn't worth the risk of breaking styling the rest of the UI
shares those files with. `verify.mjs` prints them rather than hiding them.

Internal route *labels* still say "Ropilot Credits" in a few places. Those are
names for a route this build can't take, not paths to it.

### The three things that are still binaries

`main.min.js` is Ropilot's Electron main process, already bundled and minified by
esbuild before shipping. It's readable enough to patch — pass 7 does — but it
won't survive an unbundling into original sources.

`vendor/` holds what has no source at all: `ropilot-infra.exe` and
`ropilot-infra-helper-launcher.exe` are compiled Go, and `elevate.exe` is the
elevation shim. `ropilot-infra.exe` is the Studio bridge, not the paywall — the
paywall lives in `app.asar`, which is exactly what's patched — so it's untouched.
It does self-update from Ropilot's own releases at startup, which is worth
knowing.

There is no TypeScript source, no dev build config, and no git history here.
What's in `app/` is the client as shipped, which for the renderer happens to be
real unminified source: 112 commented JS files across `src/` and `lib/`.

---

## Verifying it

Two layers, because they catch different failures.

**`verify.mjs` — 19 checks against the source.** `model-catalog.js` is a pure
module, so it imports for real and the gate sets are *counted*, not eyeballed.
Everything else is scanned as source text across the whole tree, which is the
stronger test here: a purchase path that no longer connects is still a purchase
path if its URL is in the code. If a pristine `orig/` is present the before/after
numbers are measured against it.

```
19/19 PASSED
  hidden models        8 → 0
  free-plan models     3/14 → 14/14
  no /pricing, no /api/auto-refill, no /api/ai/credits,
  no price string, no Buy Credits button — tree and packed artifact
```

**`verify-installer.py` — the artifact.** Verifying `app/` proves the source is
patched; it proves nothing about the 85 MB of compressed installer that comes
out. So this unpacks the installer with 7z, pulls `app.asar` back out and
compares it byte for byte against the one `build.sh` packed, then re-checks every
marker inside it. A stale installer cannot pass.

```
app.asar inside   88ee88bce84dd62ba310507059819061ee9892c1bc082be8bcb4836d6870c5e7
app.asar built    88ee88bce84dd62ba310507059819061ee9892c1bc082be8bcb4836d6870c5e7
                  match — the installer carries the verified build
```

---

## The ceiling

It does not conjure free inference. There's no inference endpoint in the client
and no server-side key to find — it talks to whatever CLI you have logged in.
The credits were the escape hatch from *your* usage limits, not the thing that
made it run.

So: models your own ChatGPT or Claude plan doesn't include will now **appear** in
the picker, and your provider will still refuse them. The client stopped hiding
them to avoid the error. That's the trade. With no CLI logged in there's nothing
to run on, which was equally true of the paid build.

---

## Moving to a newer version

`app/` is committed already patched, so `patches/` is only needed to re-derive
it. Point `apply-patches.sh` at a copy of `app.asar` from an install you already
have:

```
bash patches/apply-patches.sh ~/ropilot/resources/app.asar
bash build.sh --exe
```

The stock `app.asar` lives at
`%LOCALAPPDATA%\Programs\ropilot\resources\app.asar`. Nothing here downloads
Ropilot. The passes run in order, each against the tree the previous one
produced, from a fresh extraction every time — so it's idempotent.

Passes: 1 neutralises the gates, 2 strips the purchase UI, 3 fixes the onboarding
branch and upsell copy, 4 and 5 take out the sidebar referral wiring, 6 handles
the no-ChatGPT branch, 7 removes the two startup calls that only existed for the
paid product.

---

## Install layout

Installs as **Ropilot Studio Free** to `%LOCALAPPDATA%\Programs\Ropilot Studio
Free`, so it sits alongside a paid install without either clobbering the other.
They share `%APPDATA%\ropilot`, which is where projects, chats and provider
logins live — deliberately left alone on uninstall.

---

## Credits and licences

Ropilot Studio isn't mine and this build redistributes it. Electron and Chromium
licences ship inside the app (`LICENSE.electron.txt`, `LICENSES.chromium.html`).
Patches remove a paywall from a client; they don't grant a licence to the
software. Private repo, personal use.
