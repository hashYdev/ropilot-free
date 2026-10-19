#!/usr/bin/env python3
"""Third pass: the functional leftovers and the user-facing upsell copy.

Pass one killed the gates and pass two stripped the purchase UI. This pass
handles the two things that could still bite a real user, plus the copy that
would otherwise offer them something this build cannot sell:

  * the free-credits onboarding branch, which swaps the provider setup screen
    for a "claim your credits" screen. With no credits to claim it must never
    win, or a fresh user lands on a dead end.
  * the "or switch to Ropilot Credits" line shown when no models are connected.
"""
import io
import os
import sys

ROOT = '/tmp/opencode/rp/patched'
applied = []


def edit(rel, old, new, why):
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding='utf-8').read()
    if new in src and old not in src:
        print('  = %-44s already patched' % rel)
        return
    hits = src.count(old)
    if hits != 1:
        print('  ! %-44s matched %d times — ABORTING' % (rel, hits))
        sys.exit(1)
    io.open(path, 'w', encoding='utf-8', newline='').write(src.replace(old, new, 1))
    applied.append(rel)
    print('  + %-44s %s' % (rel, why))


# ── the onboarding branch: never divert to a credit claim ────────────────────
edit('src/js/setup-flow.js',
     """  isFreeOfferOnboardingPending() {
    return storage.getRaw(storage.KEYS.freeOfferPending) === '1';
  }""",
     """  isFreeOfferOnboardingPending() {
    // free build: the "claim your free Ropilot Credits" branch is dead — there
    // are no credits to claim and no account to claim them from. Returning
    // false here means onboarding falls through to the provider setup, which
    // is the only thing that actually gets this build working.
    return false;
  }""",
     'free-credits onboarding branch disabled')

# ── copy that offers a route this build does not have ───────────────────────
edit('src/js/composer/composer-dropdowns.js',
     "        ? 'Sign in to ChatGPT or Claude to use your own subscription, or switch to Ropilot Credits.'",
     "        ? 'Sign in to ChatGPT or Claude to use your own subscription.'",
     'credits upsell dropped from the empty picker')

edit('src/js/composer/composer-footer.js',
     "        canUsePriority ? 'Select the Ropilot Credits route priority.' : 'Priority AI requires Ropilot Plus.'",
     "        canUsePriority ? 'Select the route priority.' : 'Priority routing is not available in this build.'",
     'Ropilot Plus upsell dropped from the tooltip')

edit('src/js/message-sender.js',
     "    detailNode.textContent = 'Installing the local runtime used by Ropilot Credits. This only needs to happen once.';",
     "    detailNode.textContent = 'Installing the local runtime. This only needs to happen once.';",
     'credits wording dropped from the setup status')

print()
print('%d edit(s) applied' % len(applied))
