#!/usr/bin/env python3
"""Second pass: strip the paid surface the first pass left behind.

Pass one neutralised the gates but left unreachable code holding the strings —
a "Get 30 credits · $8" CTA reachable from stored chats, a live Buy Credits
button wired to /pricing, a Ropilot Credits toggle in the composer, and the
referral widget. Dead strings are still shippable strings, so they go too.
"""
import io
import os
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


# ── 1. the wall, rewritten ───────────────────────────────────────────────────
shutil.copyfile(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'credits-wall.free.js'),
                os.path.join(ROOT, 'src/js/credits/credits-wall.js'))
applied.append('src/js/credits/credits-wall.js')
print('  + %-44s full rewrite: no checkout, no auto top-up' % 'src/js/credits/credits-wall.js')

# ── 2. the second $8 card, reachable from stored chats ───────────────────────
edit('src/js/message-renderer.js',
     """    card.innerHTML = `
      <p class="cic-kicker">${escapeHtml(kicker)}</p>
      <div class="cic-card">
        <h2 class="cic-title">Keep building with Ropilot Credits</h2>
        <p class="cic-sub">One-time top-up &middot; applied instantly</p>
        <button type="button" class="cic-cta" id="cic-upgrade">Get 30 credits &middot; <span class="cic-amt">$8</span></button>
      </div>
      ${INLINE_INVITE_PROMO_MARKUP}
    `;
    this.app?.postWallEvent?.('shown', 'chatgpt_limit');
    card.querySelector('#cic-upgrade')?.addEventListener('click', () => {
      this.app?.postWallEvent?.('checkout_opened', 'chatgpt_limit');
    });
    return card;""",
     """    card.innerHTML = `
      <p class="cic-kicker">${escapeHtml(kicker)}</p>
      <div class="cic-card">
        <h2 class="cic-title">Your plan's limit, not a paywall</h2>
        <p class="cic-sub">This build has no credits to sell. It runs on your own login.</p>
      </div>
    `;
    return card;""",
     'stored-chat $8 card -> plain notice')

# ── 3. the Buy Credits button in the sidebar ─────────────────────────────────
edit('src/js/wiring/wire-modals.js',
     """  document.getElementById('btn-buy-credits')?.addEventListener('click', () => {
    electronAPI()?.openExternal(`${app.config.siteUrl}/pricing`);
  });
""",
     "",
     'Buy Credits shortcut removed')

# ── 4. the Ropilot Credits toggle in the composer picker ─────────────────────
edit('src/js/composer/composer-dropdowns.js',
     """      <button type="button" class="composer-segmented-option" role="radio" data-ai-mode="credits"
        aria-checked="${subscription ? 'false' : 'true'}" tabindex="-1"
        data-composer-tip="Pay with your Ropilot Credits balance">
        <span class="composer-segmented-label">${ICON.coins}<span>Ropilot Credits</span></span>
      </button>
""",
     "",
     'Ropilot Credits mode toggle removed')

# ── 5. the note that upsold credits on a Claude plan limit ───────────────────
edit('src/js/message-handler.js',
     "or use Ropilot Credits or a GPT model instead.';",
     "or use a GPT model instead.';",
     'upsell line dropped from the Claude note')

# ── 6. markup: Buy Credits, the referral widget, the reimbursement dialog ────
edit('src/index.html',
     """            <button class="buy-credits-btn hidden" id="btn-buy-credits" type="button">
              <span>Buy Credits</span>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <line x1="7" y1="17" x2="17" y2="7" />
                <polyline points="7 7 17 7 17 17" />
              </svg>
            </button>
""",
     "",
     'Buy Credits button markup removed')

edit('src/index.html',
     """            <div class="invite-widget hidden" id="invite-widget" aria-live="polite">
              <div class="invite-widget-head">
                <svg
                  class="invite-widget-gift"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="20 12 20 22 4 22 4 12" />
                  <rect x="2" y="7" width="20" height="5" />
                  <line x1="12" y1="22" x2="12" y2="7" />
                  <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
                  <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
                </svg>
                <span class="invite-widget-title">Invite your friends!</span>
                <span class="invite-widget-badge" id="invite-widget-badge">0 / 3</span>
              </div>
              <p class="invite-widget-sub" id="invite-widget-sub">
                You get <b>10 credits</b>, your friend gets <b>5</b> &mdash; for up to <b>3 friends</b>.
              </p>
              <button class="invite-widget-copy" id="invite-widget-copy" type="button" disabled>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span id="invite-widget-copy-label">Loading link...</span>
              </button>
            </div>
""",
     "",
     'referral widget markup removed')

edit('src/index.html',
     """<template id="credit-reimbursement-template">
<dialog class="credit-reimbursement" aria-labelledby="reimbursement-title" aria-describedby="reimbursement-description">
  <div class="credit-reimbursement__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="m7 12 3.5 3.5L17 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/></svg></div>
  <p class="credit-reimbursement__eyebrow">A credit adjustment from Ropilot</p>
  <h2 id="reimbursement-title">We\u2019ve returned your credits</h2>
  <p id="reimbursement-description">A technical issue caused some of your recent requests to use more Ropilot credits than they should have.</p>
  <div class="credit-reimbursement__amount"><strong class="credit-reimbursement__value"><span>+</span><img src="../assets/icon.png" alt="" aria-hidden="true"><span data-reimbursement-amount>{amount}</span></strong><span>Ropilot credits added back</span></div>
  <p class="credit-reimbursement__note">Your credits are ready to use\u2014no action needed.<br>We\u2019re sorry for the trouble.</p>
  <form method="dialog"><button class="btn-primary credit-reimbursement__button" autofocus>Got it</button></form>
</dialog>
    </template>
""",
     "",
     'credit-reimbursement dialog removed')

print()
print('%d edit(s) applied' % len(applied))
