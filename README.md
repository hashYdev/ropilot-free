# Ropilot Studio — free build

The Ropilot Studio desktop client with its paid surface removed, plus the
source it builds from, plus a from-scratch replacement for the local bridge
that Ropilot only ships for x86_64.

This is **not** a patcher and not a replacement app. `app/` is Ropilot's own
client code — 220 files, editable — with the changes applied. `build.sh` turns
it into a working installer. Change a line in `app/`, run the build, get a new
installer.

```
app/                            Ropilot's client source, patched — 220 files
bridge/                         the local bridge, in Go, rebuilt from scratch
vendor/resources/               the parts that ship as binaries (see below)
patches/                        the eleven passes that produced app/, and the verifiers
build.sh                        app/ + Electron 28.3.3 → Windows installer
build-linux-arm64.sh            app/ + Electron 28.3.3 → linux/arm64 tree
installer.nsi                   the Windows installer
verify.mjs                      23 checks against the source tree
verify-installer.py             opens the finished installer and checks what's inside
Ropilot-Studio-Free-Setup.exe   the built installer
```

### The installer

```
Ropilot-Studio-Free-Setup.exe   89,549,578 bytes
sha256                          0bdd4aee7a0241d4275861969bd79568000dd72f7118bdcecf2ab121fa878732
```

Built by `bash build.sh --exe` from the `app/` in this repo, then verified by
`verify-installer.py` — which unpacks it and confirms the `app.asar` inside is
byte-identical to the one the build packed. A stale installer cannot pass that.

---

## Building it

### Windows

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

### linux/arm64

```
bash build-linux-arm64.sh
```

Ropilot's own Linux build is x86_64, and the bridge it ships is x86_64 too, so
neither runs on an arm64 machine. Electron ships linux-arm64 and the client
code is plain JavaScript, and the bridge is rebuilt from `bridge/`, so the
whole thing ports over. See below for what that took.

On a phone or inside a proot container, launch it with:

```
export DISPLAY=:1
./build/stage-linux-arm64/ropilot \
  --no-sandbox --disable-setuid-sandbox \
  --in-process-gpu --disable-gpu --disable-gpu-compositing \
  --disable-dev-shm-usage
```

`--in-process-gpu` is what keeps it alive there: Chromium cannot fork its GPU
child process under proot and aborts with *"GPU process isn't usable"*.

---

## What actually changed

Ropilot can run a model two ways: **bring your own** — it drives a Claude Code
or Codex CLI you're logged into, and inference runs against *your* account — or
**Ropilot Credits**, their hosted route. The client ships gates for both. This
build removes them, and then removes the three account gates that sit in front
of the first one.

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
| **16** | **`main.min.js`** | **The hosted UI is no longer loaded.** See below — this one decides whether any of the others do anything |
| **17** | **`src/js/setup-flow.js`** | **The Ropilot account gate removed.** 1.3.2 opens on a login splash and refuses to proceed without a Ropilot API key; 1.3.1 did not. Both gates — the entry to setup and the router everything funnels through — are gone |
| **18** | **`src/js/message-sender.js`, `src/app.js`** | **The API key no longer gates a local provider.** The send path refused to send *anything* without a Ropilot key, and then validated it against their server. Only the hosted provider still needs one |
| **19** | **`src/js/models/model-catalog.js`, `src/js/ui/provider-marks.js`, `src/js/composer/*`** | **OpenCode added as a third provider.** See below |

`resources/app-update.yml` is dropped as well. It names a publisher and a GitHub
feed for an updater that isn't in `node_modules` — vestigial, but removing it
means nothing can go looking for a newer `app.asar` and quietly undo all of the
above.

### Pass 16, and why it is the important one

A packaged client does not render the tree in `app/`. The main process does:

```js
ie() ? (console.log("Development mode: Loading local UI"), e.loadFile(t))
     : e.loadURL(es())
```

where `ie()` is `process.env.ROPILOT_DEV === "1" || !app.isPackaged` and `es()`
is `${appUrl}/?v=${Date.now()}`. So a production client loads

```
https://app.ropilot.ai/?v=<timestamp>
```

and only falls back to the local `src/index.html` if that request fails.

The hosted bundle is the same app, built and served — and it carries the
paywall. The served `app.min.js` has 20 hits on `isUseRopilotCreditsEnabled`,
18 on "Ropilot Credits", the buy button and the auto-refill endpoint. So
patching the local tree while the client renders the remote one changes nothing
the user can see. The load site is rewritten to always take the local branch.

`ROPILOT_DEV=1` would do the same thing and is not usable: `bootstrap.js` reads
it too and switches the entry point to `./main.js`, a file that only exists in
their dev tree. Setting it makes the app fail to start.

### Passes 17 and 18: the account gates

Version 1.3.2 changed the first-run flow. 1.3.1 opened on the provider
acknowledgement screen and went straight into installing the Claude or Codex
CLI. 1.3.2 opens on a splash and stops there:

```js
if (!this.app.apiKey) {
  this._hideAllSetupScreens();
  this.showLoginSplash();
  return;
}
```

That is a different gate from the credits paywall. It is an account gate, and
it is in two places — the entry to setup, and `routeAfterProviderReady()`,
which every route into the app funnels through, so removing only the first
just moves the wall.

Then there is the send path, which refuses to send *anything* without a Ropilot
key and then validates it against their server:

```js
const effectiveKey = this.app.getEffectiveApiKey();
if (!effectiveKey) { this.app.showApiKeyReminder(); return; }
if (!isApiKeyValidated()) { this.app.showApiKeyReminder('Your API key is invalid...'); return; }
```

With the hosted route already gone, that key has nothing left to authenticate.
What still reads it: `localStorage 'ropilot_api_key'`, the cloud chat sync to
their edge, the `set_api_key` frame, and `getEffectiveApiKey`. None of it is
needed to run a local CLI, and the CLI is installed from the vendor's own
endpoints (`claude.ai/install.ps1`, `github.com/openai/codex/releases`), not
from Ropilot. So the checks now apply only to the `ropilot` provider, which is
unreachable in this build anyway.

### Pass 19: OpenCode as a provider

Ropilot drives two CLIs. OpenCode is a third, and it is the one that matters
here — the only provider on this machine that is already configured, already
authenticated, and already able to write files.

`opencode run --format json --agent <agent> --model <provider/model> <prompt>`
emits NDJSON, which is the same shape the bridge already parses for Claude
Code, so it took one provider branch and one parser case. On the client side
the provider is a first-class catalog entry: the models, the default, the
provider tab order, the mark, the label — and `normalizeModelProvider()`, which
is a whitelist with a fallback to `claude` and so would have silently rewritten
every opencode value to Claude.

Two things that are easy to get wrong and are documented in the passes:

- `normalizeSelectedModel()` lowercases the value and matches it against the
  legacy Claude aliases. `apmix/claude-sonnet-4-6-free` *contains*
  `claude-sonnet-4-6`, so it was rewritten to `claude-opus-5-5[1m]` and the
  picker could not hold an OpenCode model at all. A catalogued opencode value
  is exempt.
- The renderer asks the bridge which CLIs are installed, over HTTP. The host
  has to be `localhost` and not `127.0.0.1`: the page's `connect-src` allows
  `http://localhost:*` and not the loopback address, and the CSP refusal is
  silent in the UI.

### Left alone on purpose

Dead CSS selectors for the removed widgets (`.invite-widget*`, `.cic-invite*`,
`credit-reimbursement.css`) are still in the stylesheets. They have no markup to
match, so they can't be clicked or seen. Stripping CSS rule blocks for a string
that isn't reachable wasn't worth the risk of breaking styling the rest of the UI
shares those files with. `verify.mjs` prints them rather than hiding them.

Internal route *labels* still say "Ropilot Credits" in a few places. Those are
names for a route this build can't take, not paths to it.

### The three things that are still binaries

`main.min.js` is Ropilot's Electron main process, already bundled and minified
by esbuild before shipping. It's readable enough to patch — passes 15 and 16
do — but it won't survive an unbundling into original sources.

`vendor/` holds what has no source at all: `ropilot-infra.exe` and
`ropilot-infra-helper-launcher.exe` are compiled Go, and `elevate.exe` is the
elevation shim. `ropilot-infra.exe` is the Studio bridge, not the paywall — the
paywall lives in `app.asar`, which is exactly what's patched — so it's untouched.

There is no TypeScript source, no dev build config, and no git history here.
What's in `app/` is the client as shipped, which for the renderer happens to be
real unminified source: 112 commented JS files across `src/` and `lib/`.

---

## The bridge

`bridge/` is a from-scratch implementation of the local bridge Ropilot ships as
an x86_64 Go binary. The client gates its entire startup on that process — with
it missing, the app shows *"Ropilot local server failed to become ready"* and
refuses to open — and it is not available for any other architecture.

The client contract, read out of the shipped client:

```
GET  /health              -> 200 {"status":"healthy","ready":true}
GET  /providers           -> {"claude":bool,"codex":bool,"opencode":bool}
GET  /ws                  -> websocket, JSON frames both ways
POST /chat-sync/commit    -> 204
```

Over the websocket the client sends a chat turn as a frame with **no `type`
field at all** — `{prompt, session_id, provider, model, project_dir, ...}` —
and only the control frames carry a type. So the presence of a prompt is what
marks a turn, and the chat id comes back as `session_id`, because that is the
field the client routes on.

The same dependency set as the original: `gorilla/websocket` v1.5.1,
`rs/cors` v1.10.1, `golang.org/x/net` v0.17.0.

It drives `claude`, `codex` and `opencode`, streaming each one's output back as
`agent_text` / `reasoning` / `done`.

---

## What it needs

**Your own Claude Code, Codex or OpenCode login.** Install the CLI, sign in,
then pick that provider in Ropilot. That is the whole requirement.

## What it does not do

It does not conjure free inference. There's no inference endpoint in the client
and no server-side key to find — it talks to whatever CLI you have logged in.
The credits were the escape hatch from *your* usage limits, not the thing that
made it run.

So: models your own ChatGPT or Claude plan doesn't include will now **appear**
in the picker, and your provider will still refuse them. The client stopped
hiding them to avoid the error. That's the trade. With no CLI logged in there's
nothing to run on, which was equally true of the paid build.

---

## Verifying it

Two layers, because they catch different failures.

**`verify.mjs` — 23 checks against the source.** `model-catalog.js` is a pure
module, so it imports for real and the gate sets are *counted*, not eyeballed.
Everything else is scanned as source text across the whole tree, which is the
stronger test here: a purchase path that no longer connects is still a purchase
path if its URL is in the code. If a pristine `orig/` is present the before/after
numbers are measured against it.

```
23/23 PASSED
  hidden models        8 → 0
  free-plan models     3/14 → 14/14
  no /pricing, no /api/auto-refill, no /api/ai/credits,
  no price string, no Buy Credits button — tree and packed artifact
  the local UI is loaded, not the hosted bundle
  the Ropilot account gate is gone
  the API key no longer gates a local provider
  opencode is a provider
```

**`verify-installer.py` — the artifact.** Verifying `app/` proves the source is
patched; it proves nothing about the 85 MB of compressed installer that comes
out. So this unpacks the installer with 7z, pulls `app.asar` back out and
compares it byte for byte against the one `build.sh` packed, then re-checks every
marker inside it. A stale installer cannot pass.

---

## Moving to a newer version

`app/` is committed already patched, so `patches/` is only needed to re-derive
it. Point `apply-patches.sh` at a copy of `app.asar` from an install you
already have:

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
paid product, 8 loads the local UI instead of the hosted bundle, 9 removes the
account gate, 10 adds OpenCode as a provider, 11 removes the API key gate on the
send path.

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
