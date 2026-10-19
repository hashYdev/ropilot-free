#!/usr/bin/env python3
"""Ninth pass: take the Ropilot account gate off the front of setup.

Version 1.3.2 changed the first-run flow. 1.3.1 opened on the provider
acknowledgement screen and went straight into installing the Claude or Codex
CLI. 1.3.2 opens on a splash and stops there, and it does it in two places:

  * checkClaudeInstallation() — the first gate. Without a Ropilot API key it
    hides every setup screen, shows the login splash and returns.

        // Login is the first action in the new onboarding. If we don't have a
        // Ropilot API key yet, show the splash login screen and stop here. ...
        if (!this.app.apiKey) {
          this._hideAllSetupScreens();
          this.showLoginSplash();
          return;
        }

  * routeAfterProviderReady() — the second. Every route into the app goes
    through it, and it bounces back to the splash if the key is missing, so
    removing only the first gate just moves the wall.

        if (!this.app.apiKey) {
          this.showLoginSplash();
          return;
        }

That is a different gate from the credits paywall the other passes remove.
It is an account gate: without a Ropilot API key the app will not proceed to
provider setup at all, and the splash only offers "Log In" or a manual Ropilot
API key.

With the hosted route already gone, that key has nothing left to authenticate.
What still reads it:

  * localStorage 'ropilot_api_key' — where it is stored
  * ChatSyncService — cloud chat sync to their edge, optional
  * the ws set_api_key frame — only meaningful for the hosted route
  * getEffectiveApiKey — passed to the bridge for the hosted route

None of it is needed to run a local Claude Code or Codex CLI, and the CLI
itself is installed from the vendor's own endpoints (claude.ai/install.ps1,
github.com/openai/codex/releases), not from Ropilot.

So both gates go, and the flow falls through to the provider status check it
was guarding — the same path 1.3.1 took.

continueAfterApiKeySetup() keeps its own check: that one runs after a real
login, so the key is present and the guard never fires. showApiKeyAuth() is
dead code — nothing calls it.
"""
import io
import os
import re
import sys

ROOT = os.environ.get('ROPILOT_APP', os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')))
applied = []

REL = 'src/js/setup-flow.js'


def patch(pattern, replacement, marker, why):
    path = os.path.join(ROOT, REL)
    src = io.open(path, encoding='utf-8').read()
    if marker in src:
        print('  = %-44s already patched' % REL)
        return
    pat = re.compile(pattern)
    hits = pat.findall(src)
    if len(hits) != 1:
        print('  ! %-44s matched %d times — ABORTING' % (REL, len(hits)))
        sys.exit(1)
    out = pat.sub(replacement, src, count=1)
    io.open(path, 'w', encoding='utf-8', newline='').write(out)
    applied.append(REL)
    print('  + %-44s %s' % (REL, why))


# ── the first gate: the entry to setup ───────────────────────────────────────
patch(
    r'[ \t]*// Login is the first action in the new onboarding\.[^\n]*\n'
    r'(?:[ \t]*//[^\n]*\n)*'
    r'[ \t]*if \(!this\.app\.apiKey\) \{\n'
    r'[ \t]*this\._hideAllSetupScreens\(\);\n'
    r'[ \t]*this\.showLoginSplash\(\);\n'
    r'[ \t]*return;\n'
    r'[ \t]*\}\n',
    '    // free build: the Ropilot account gate is gone. Without a Ropilot\n'
    '    // API key this used to stop here on the login splash. The hosted\n'
    '    // route those keys authenticate to has been removed, so the key no\n'
    '    // longer gates anything: fall through to provider setup, which is\n'
    '    // where 1.3.1 started.\n',
    'free build: the Ropilot account gate is gone',
    'the account gate removed from setup entry')

# ── the second gate: the router everything funnels through ───────────────────
patch(
    r'[ \t]*// Login is the first onboarding step now, so the API key should always be\n'
    r'[ \t]*// present by the time we get here\. If it isn\'t \(state corruption, manual\n'
    r'[ \t]*// logout, etc\.\), kick back to the splash rather than dropping the user\n'
    r'[ \t]*// into a half-configured state\.\n'
    r'[ \t]*if \(!this\.app\.apiKey\) \{\n'
    r'[ \t]*this\.showLoginSplash\(\);\n'
    r'[ \t]*return;\n'
    r'[ \t]*\}\n',
    '    // free build: this used to kick back to the login splash when there\n'
    '    // was no Ropilot API key. The hosted route is gone, so there is no\n'
    '    // key to be missing — carry on to the rest of onboarding.\n',
    'free build: this used to kick back to the login splash',
    'the account gate removed from the onboarding router')

print()
print('%d edit(s) applied' % len(applied))
