#!/usr/bin/env python3
"""Fifth pass: delete the referral widget's method bodies outright.

Pass four neutralised the invite methods with an early return, which stops them
running but leaves the original body sitting below it — and the body is where
the `[data-cic-invite]` selectors and the /api/ropilot-referral call live. Dead
code is still shipped code, so this pass replaces each body with a stub.

Only the closing brace of these methods is a line that is exactly two spaces and
`}`, which is what makes the match safe: a nested block closes deeper than the
method it belongs to.
"""
import io
import os
import re
import sys

ROOT = os.environ.get('ROPILOT_APP', os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')))
applied = []

STUBS = [
    ('getInviteWidgetElements()', 'null',
     'the invite widget markup was deleted in pass two'),
    ('getInlineInvitePromoElements()', '[]',
     'the inline promo markup was deleted in pass two'),
    ('bindInviteWidgetCopy()', 'undefined',
     'nothing to bind a copy handler to'),
    ('setInviteWidgetLoading()', 'undefined',
     'the Referral Program widget does not exist here'),
    ('renderInviteWidgetSummary(summary)', 'undefined',
     'the Referral Program widget does not exist here'),
    ('updateInviteWidgetVisibility(isManagedCreditsMode)', 'undefined',
     'the Referral Program widget does not exist here'),
    ('async refreshInviteWidgetSummary(options = {})', 'null',
     'GET /api/ropilot-referral is not contacted by this build'),
    ('async copyInviteWidgetLink(sourceButton = null)', 'undefined',
     'there is no referral link to copy'),
]


def replace_method(rel, signature, ret, note):
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding='utf-8').read()
    if ('// free build: stub — ' + note) in src:
        print('  = %-44s already stubbed' % rel)
        return
    pat = re.compile(r'\n  ' + re.escape(signature) + r' \{\n.*?\n  \}\n', re.DOTALL)
    if len(pat.findall(src)) != 1:
        print('  ! %-44s %s matched %d times — ABORTING'
              % (rel, signature, len(pat.findall(src))))
        sys.exit(1)
    stub = (
        '\n  ' + signature + ' {\n'
        '    // free build: stub — ' + note + '\n'
        '    return ' + ret + ';\n'
        '  }\n'
    )
    io.open(path, 'w', encoding='utf-8', newline='').write(pat.sub(stub, src, count=1))
    applied.append(rel)
    print('  + %-44s %s' % (rel, signature))


for sig, ret, note in STUBS:
    replace_method('src/js/settings.js', sig, ret, note)

print()
print('%d method(s) stubbed' % len(applied))
