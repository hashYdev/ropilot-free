#!/usr/bin/env python3
"""Eighth pass: stop the client loading the hosted UI.

This is the pass that decides whether any of the others do anything.

The shipped client does not render the tree in app/. In production the main
process does:

    ie() ? (console.log("Development mode: Loading local UI"), e.loadFile(t))
         : e.loadURL(es())

where ie() is `process.env.ROPILOT_DEV === "1" || !app.isPackaged` and es() is
`${appUrl}/?v=${Date.now()}`. So a packaged client loads

    https://app.ropilot.ai/?v=<timestamp>

and only falls back to the local src/index.html if that request fails.

The consequence: the tree in app/ is the *source* of the hosted bundle, not
what the user sees. The paywall lives in the hosted bundle too — the served
app.min.js carries isUseRopilotCreditsEnabled, "Ropilot Credits", the buy
button and the auto-refill endpoint. Patching the local tree while the client
renders the remote one changes nothing the user can see.

So the load site is rewritten to always take the local branch. The bundled
app/ is the patched one, so the app now renders the tree the other passes
edited.

The predicate is matched by shape rather than by its minified name, because
the two builds disagree on the names: the Windows bundle uses he() and the
Linux one ie().

ROPILOT_DEV cannot be used for this instead. bootstrap.js reads it too, and
switches the entry point to ./main.js — a file that only exists in their dev
tree, not in a shipped build. Setting it makes the app fail to start.
"""
import io
import os
import re
import sys

ROOT = os.environ.get('ROPILOT_APP', os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')))
applied = []


def patch(rel, pattern, replacement, why):
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding='utf-8').read()
    # The marker is the literal text the replacement writes into the bundle, so
    # re-running the pass is a no-op rather than a second edit.
    if 'free build: loading the local UI' in src:
        print('  = %-44s already patched' % rel)
        return
    pat = re.compile(pattern)
    hits = pat.findall(src)
    if len(hits) != 1:
        print('  ! %-44s matched %d times — ABORTING' % (rel, len(hits)))
        sys.exit(1)
    out = pat.sub(replacement, src, count=1)
    io.open(path, 'w', encoding='utf-8', newline='').write(out)
    applied.append(rel)
    print('  + %-44s %s' % (rel, why))


# The load site. The predicate is replaced with a literal true, so the ternary
# keeps its shape and the local branch is the one that runs.
patch(
    'main.min.js',
    r'(\w+)\?\((console\.log\("Development mode: Loading local UI"\)),(\w+)\.loadFile\((\w+)\)\)',
    r'true?(console.log("free build: loading the local UI, not the hosted one"),'
    r'\3.loadFile(\4))',
    'loading the local UI instead of the hosted bundle')

print()
print('%d edit(s) applied' % len(applied))
