#!/usr/bin/env python3
"""Sixth pass: the "I don't have a ChatGPT account" branch.

That button existed to claim a starter bundle of Ropilot Credits against a
Ropilot account: it calls GET /api/ropilot-credit-free-offer, and if the offer is
unavailable it leaves the user on "This free starter offer is not available right
now." with nowhere to go.

A free build has no offer endpoint to call and nothing to claim, so the branch
gets one honest sentence naming the thing that actually makes this build work,
and stops phoning home to do it.
"""
import io
import os
import re
import sys

ROOT = os.environ.get('ROPILOT_APP', os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')))
REL = 'src/js/setup-flow.js'

path = os.path.join(ROOT, REL)
src = io.open(path, encoding='utf-8').read()

if 'free build: this branch existed to claim' in src:
    print('  = %s already patched' % REL)
    sys.exit(0)

pat = re.compile(r'\n  async startNoChatGptAccountFlow\(\) \{\n.*?\n  \}\n', re.DOTALL)
found = pat.findall(src)
if len(found) != 1:
    print('  ! startNoChatGptAccountFlow matched %d times — ABORTING' % len(found))
    sys.exit(1)

stub = """
  async startNoChatGptAccountFlow() {
    // free build: this branch existed to claim a starter bundle of Ropilot
    // Credits against a Ropilot account, over GET /api/ropilot-credit-free-offer.
    // There is no offer to fetch and nothing to claim, so it names the thing that
    // actually makes this build run instead of leaving the user on a status line
    // that never resolves.
    const status = document.getElementById('auth-recheck-status');
    if (status) {
      status.textContent =
        'This build runs on your own account. Install the Claude Code or Codex CLI, '
        + 'sign in there, then come back and pick that provider.';
      status.classList.remove('hidden');
      status.classList.add('is-error');
    }
  }
"""

io.open(path, 'w', encoding='utf-8', newline='').write(pat.sub(stub, src, count=1))
print('  + %-44s free-offer claim branch -> one honest sentence' % REL)
print()
print('1 edit(s) applied')
