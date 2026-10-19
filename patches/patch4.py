#!/usr/bin/env python3
"""Fourth pass: the settings sidebar and the reimbursement module.

Passes one to three covered the gates, the purchase UI and the onboarding
branch. What was left is the sidebar wiring in settings.js — the Buy Credits
button, the "Invite your friends" referral widget and its /api/ropilot-referral
fetch — plus credit-reimbursement.js, a whole module whose only job was to
announce returned Ropilot Credits.

The markup for those widgets was already deleted in pass two, so this code was
already inert (every lookup is guarded). Dead code that still names a purchase
path is still a purchase path in the artifact, though, so it goes.

The invite methods are neutralised by an early return rather than deletion: they
are called from several places, some of which branch on their return value, and
a return of null/[]/false preserves every one of those branches.
"""
import io
import os
import re
import shutil
import sys

ROOT = os.environ.get('ROPILOT_APP', os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')))
applied = []


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


def neutralise(rel, signature, ret, why):
    """Insert an early return as the first statement of a method."""
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding='utf-8').read()
    anchor = signature + ' {'
    if src.count(anchor) != 1:
        print('  ! %-44s %s matched %d times — ABORTING' % (rel, signature, src.count(anchor)))
        sys.exit(1)
    if 'return %s; // free build' % ret in src:
        print('  = %-44s already neutralised' % rel)
        return
    body = (
        anchor
        + '\n    // free build: this was the referral / credits surface. The widget'
        + '\n    // markup is gone, so the method reports "nothing here" and callers'
        + '\n    // take their empty branch.'
        + '\n    return %s; // free build' % ret
    )
    io.open(path, 'w', encoding='utf-8', newline='').write(src.replace(anchor, body, 1))
    applied.append(rel)
    print('  + %-44s %s' % (rel, why))


# ── 1. the reimbursement module ──────────────────────────────────────────────
shutil.copyfile(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'credit-reimbursement.free.js'),
                os.path.join(ROOT, 'src/js/credits/credit-reimbursement.js'))
applied.append('src/js/credits/credit-reimbursement.js')
print('  + %-44s full rewrite: never a valid notice' % 'src/js/credits/credit-reimbursement.js')

# ── 2. settings.js: the Buy Credits button in the actions counter ────────────
edit('src/js/settings.js',
     "    const buyCreditsBtn = document.getElementById('btn-buy-credits');\n",
     "",
     'Buy Credits lookup removed')

edit('src/js/settings.js',
     "    buyCreditsBtn?.classList.toggle('hidden', !isManagedCreditsMode);\n",
     "",
     'Buy Credits show/hide removed')

edit('src/js/settings.js',
     "    document.getElementById('btn-buy-credits')?.classList.add('hidden');\n"
     "    document.getElementById('invite-widget')?.classList.add('hidden');\n",
     "",
     'sidebar hide calls removed')

# ── 3. settings.js: the referral widget ─────────────────────────────────────
# The early-return neutralisation from the earlier cut of this pass is gone: it
# left the dead bodies in place, and the dead bodies are where the strings live.
# patch5 replaces the method bodies outright.

print()
print('%d edit(s) applied' % len(applied))
