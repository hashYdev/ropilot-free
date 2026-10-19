#!/usr/bin/env python3
"""Seventh pass: the startup network calls that are about the paid product.

Two things still went out over the wire on a normal launch:

  * settings.js::refreshManagedAiCredits() — GET /api/ai/credits with the user's
    key, called from message handling and setup to refresh a balance this build
    does not use. The whole body goes, not just a guard: an early return would
    stop the request but leave the URL sitting in the file, and a URL that is
    still in the artifact is still a URL. It returns null, which is the same
    shape every caller already handles on a failed request.

  * main.min.js — two seconds after the window opens, the main process checks
    releasesUrl/desktop-version.json and, if anything is newer, offers to open
    siteUrl/download. In a patched build that prompt points at the paid release,
    so it would be inviting the user to undo the patch. The call site is removed
    rather than the function, because the function is minified and the call site
    is one unambiguous string.
"""
import io
import os
import re
import sys

ROOT = os.environ.get('ROPILOT_APP', os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')))
applied = []


def replace_method(rel, signature, body, why):
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding='utf-8').read()
    if ('// free build: ' + why) in src:
        print('  = %-44s already patched' % rel)
        return
    pat = re.compile(r'\n  ' + re.escape(signature) + r' \{\n.*?\n  \}\n', re.DOTALL)
    if len(pat.findall(src)) != 1:
        print('  ! %-44s %s matched %d times — ABORTING'
              % (rel, signature, len(pat.findall(src))))
        sys.exit(1)
    stub = '\n  ' + signature + ' {\n' + body + '\n  }\n'
    io.open(path, 'w', encoding='utf-8', newline='').write(pat.sub(stub, src, count=1))
    applied.append(rel)
    print('  + %-44s %s' % (rel, why))


def edit(rel, old, new, why):
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding='utf-8').read()
    if (new and new in src and old not in src) or (not new and old not in src):
        print('  = %-44s already patched' % rel)
        return
    hits = src.count(old)
    if hits != 1:
        print('  ! %-44s matched %d times — ABORTING' % (rel, hits))
        sys.exit(1)
    io.open(path, 'w', encoding='utf-8', newline='').write(src.replace(old, new, 1))
    applied.append(rel)
    print('  + %-44s %s' % (rel, why))


# ── the balance fetch ────────────────────────────────────────────────────────
replace_method(
    'src/js/settings.js',
    'async refreshManagedAiCredits()',
    '    // free build: this asked Ropilot for a credit balance and cached the\n'
    '    // answer. Nothing here is metered, so there is no balance to hold and no\n'
    '    // reason to contact them. null is what callers already expect from a\n'
    '    // failed request.\n'
    '    return null;',
    'GET /api/ai/credits removed entirely')

# ── the update prompt ────────────────────────────────────────────────────────
edit('main.min.js',
     "setTimeout(()=>{let o=pr();Cr.checkAppUpdate(o.version)},2e3),",
     "",
     'update prompt to the paid release removed')

# ── the per-turn credit accounting lookup ───────────────────────────────────
# This one only fires on chats that already carry managed-credits labels, i.e.
# turns taken before the patch. It asks Ropilot what the authoritative cost was
# so it can correct the label in the transcript. There is no balance to correct.
replace_method(
    'src/js/chat-manager.js',
    'async repairLatestManagedCreditsTurn(chat)',
    '    // free build: this is a legacy repair for chats whose turns were billed\n'
    '    // to Ropilot Credits. Nothing here is billed, so there is nothing to\n'
    '    // reconcile and no reason to contact their billing endpoint.\n'
    '    return false;',
    'GET /api/ai/credits/request removed entirely')

print()
print('%d edit(s) applied' % len(applied))
