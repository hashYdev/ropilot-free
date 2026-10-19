#!/usr/bin/env python3
"""Turn the Ropilot Studio client into a free build.

Everything here is a client-side gate. The three model sets decide which models
the picker offers, and the two predicates decide whether the app routes to
Ropilot's paid managed inference (Credits) or to the user's own Claude Code /
Codex login. Neutralising those five points makes every call site inert without
touching each one, which is the point: the call sites are numerous and this is
the surface they all consult.
"""
import io
import os
import re
import sys

ROOT = os.environ.get('ROPILOT_APP', os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')))
applied = []


def edit(rel, old, new, why):
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding='utf-8').read()
    if new in src and old not in src:
        print('  = %-46s already patched' % rel)
        return
    hits = src.count(old)
    if hits != 1:
        print('  ! %-46s matched %d times — ABORTING' % (rel, hits))
        sys.exit(1)
    io.open(path, 'w', encoding='utf-8', newline='').write(src.replace(old, new, 1))
    applied.append(rel)
    print('  + %-46s %s' % (rel, why))


def empty_set(rel, name, why):
    """Replace `export const NAME = new Set([ ...anything... ]);` with `new Set()`."""
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding='utf-8').read()
    pat = re.compile(
        r'export const ' + name + r' = new Set\(\[.*?\n\]\);',
        re.DOTALL,
    )
    if not pat.search(src):
        print('  ! %-46s %s not found — ABORTING' % (rel, name))
        sys.exit(1)
    if 'export const ' + name + ' = new Set();' in src:
        print('  = %-46s %s already empty' % (rel, name))
        return
    src = pat.sub('export const ' + name + ' = new Set();', src, count=1)
    io.open(path, 'w', encoding='utf-8', newline='').write(src)
    applied.append(rel)
    print('  + %-46s %s' % (rel, why))


CAT = 'src/js/models/model-catalog.js'
APP = 'src/app.js'
WALL = 'src/js/credits/credits-wall.js'

# ── 1. every model visible, regardless of plan ───────────────────────────────
empty_set(CAT, 'ROPILOT_CREDITS_HIDDEN_MODEL_VALUES', 'credits-hidden models unhidden')
empty_set(CAT, 'ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES', 'own-login-hidden models unhidden')

# Allow-list for free ChatGPT plans -> every model in the catalog.
edit(CAT,
     "export const CODEX_FREE_ALLOWED_MODELS = new Set([CODEX_FREE_DEFAULT_MODEL, 'gpt-5.4-mini', 'gpt-5.2-codex']);",
     "// free build: a free ChatGPT plan no longer restricts the picker.\n"
     "export const CODEX_FREE_ALLOWED_MODELS = new Set(MODEL_CATALOG.map((m) => m.value));",
     'free-plan allow-list -> whole catalog')

# ── 2. never route to Ropilot's paid managed inference ───────────────────────
edit(APP,
     """  isUseRopilotCreditsEnabled() {
    if (typeof this.useRopilotCredits === 'boolean') {
      return this.useRopilotCredits;
    }
    return localStorage.getItem('ropilot_use_ropilot_credits') === 'true';
  }""",
     """  isUseRopilotCreditsEnabled() {
    // free build: always bring-your-own (Claude Code / Codex login). Ropilot
    // Credits is the paid managed route; this keeps every call site off it.
    if (typeof this.useRopilotCredits === 'boolean') {
      return false;
    }
    return false;
  }""",
     'locked to bring-your-own')

edit(APP,
     """  isCodexFreeAccount() {
    const plan = this.normalizeCodexAccountPlanRaw(this.codexAccountPlanRaw);
    return plan === 'free' || plan === 'go';
  }""",
     """  isCodexFreeAccount() {
    // free build: the plan no longer gates models, fast mode or defaults.
    return false;
  }""",
     'free-plan gate removed')

# ── 3. no purchase surface anywhere in the credits wall ──────────────────────
edit(WALL,
     "export const INLINE_INVITE_PROMO_MARKUP = `",
     "export const INLINE_INVITE_PROMO_MARKUP = /* free build: referral promo removed */ '';\n"
     "const __invite_promo_unused = `",
     'referral promo suppressed')

edit(WALL,
     """  postWallEvent(event, surface = 'no_actions') {
    try {""",
     """  postWallEvent(event, surface = 'no_actions') {
    // free build: no billing telemetry to their servers.
    return;
    try {""",
     'wall telemetry off')

edit(WALL,
     """  async fetchAutoRefillState() {
    try {""",
     """  async fetchAutoRefillState() {
    // free build: auto top-up is a billing feature; it does not exist here.
    return null;
    try {""",
     'auto top-up removed')

edit(WALL,
     """  async refillNowAndEnable(statusEl) {
    try {""",
     """  async refillNowAndEnable(statusEl) {
    // free build: never charges a saved card.
    return;
    try {""",
     'one-tap refill removed')

edit(WALL,
     """  async renderWallAutoRefillSection(card, authoritativeState) {
    const host = card.querySelector('#cic-auto');
    if (!host) return;""",
     """  async renderWallAutoRefillSection(card, authoritativeState) {
    // free build: this whole section was auto top-up / checkout.
    const host = card.querySelector('#cic-auto');
    if (host) host.innerHTML = '';
    return;
    /* eslint-disable no-unreachable */
    if (!host) return;""",
     'auto top-up section removed')

# The card's buy button and its openExternal to /pricing.
edit(WALL,
     """        <button type="button" class="cic-cta" id="cic-upgrade">
          Get 30 credits &middot; <span class="cic-amt">$8</span>
          <svg class="cic-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
        </button>
""",
     "",
     'buy-credits CTA removed')

edit(WALL,
     """    card.querySelector('#cic-upgrade')?.addEventListener('click', () => {
      this.postWallEvent('checkout_opened', 'no_actions');
      electronAPI()?.openExternal(`${this.app.config.siteUrl}/pricing`);
    });
""",
     "",
     'checkout handler removed')

print()
print('%d edit(s) applied' % len(applied))
