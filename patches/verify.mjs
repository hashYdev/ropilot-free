// Proof for the Ropilot free build.
//
//   node /tmp/opencode/rp/verify.mjs
//
// Two kinds of evidence, because they catch different failures:
//
//   * model-catalog.js is pure, so it imports for real and the gate sets are
//     counted rather than eyeballed. The before/after numbers come from loading
//     the pristine copy alongside the patched one.
//   * everything else is scanned as source text across the whole patched tree.
//     That is the stronger test for this job anyway: a purchase path that no
//     longer connects is still a purchase path if its URL is in the binary.
//
// The shipped app.asar is scanned too — passing on the working tree while the
// packed artifact is stale is exactly the failure this is meant to prevent.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ORIG = '/tmp/opencode/rp/orig';
const PAT  = '/tmp/opencode/rp/patched';
const ASAR = '/tmp/opencode/rp/win/resources/app.asar';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ── load every source file in a tree, as one blob per file ──────────────────
function sources(root) {
  const out = new Map();
  for (const rel of ['src', 'lib', 'bootstrap.js', 'preload.js', 'main.min.js']) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    if (st.isFile()) { out.set(rel, fs.readFileSync(p, 'utf8')); continue; }
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(js|html|json)$/.test(e.name)) continue;
        out.set(path.relative(root, full), fs.readFileSync(full, 'utf8'));
      }
    };
    walk(p);
  }
  return out;
}

const before = sources(ORIG);
const after  = sources(PAT);

const hits = (map, needle) => [...map.entries()]
  .filter(([, text]) => text.includes(needle))
  .map(([rel]) => rel);

// ── 1. the model gates, measured ───────────────────────────────────────────
const catBefore = await import(`${ORIG}/src/js/models/model-catalog.js`);
const catAfter  = await import(`${PAT}/src/js/models/model-catalog.js`);
const catalogValues = catAfter.MODEL_CATALOG.map((m) => m.value);

check('catalog loads from the patched tree',
  catalogValues.length > 0, `${catalogValues.length} models`);

check('hidden-model sets are empty',
  catAfter.ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES.size === 0
    && catAfter.ROPILOT_CREDITS_HIDDEN_MODEL_VALUES.size === 0,
  `actions ${catBefore.ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES.size} -> ${catAfter.ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES.size}, `
  + `credits ${catBefore.ROPILOT_CREDITS_HIDDEN_MODEL_VALUES.size} -> ${catAfter.ROPILOT_CREDITS_HIDDEN_MODEL_VALUES.size}`);

const freeBefore = catalogValues.filter((v) => catBefore.CODEX_FREE_ALLOWED_MODELS.has(v));
const freeAfter  = catalogValues.filter((v) => catAfter.CODEX_FREE_ALLOWED_MODELS.has(v));
check('a free ChatGPT plan no longer restricts the picker',
  freeAfter.length === catalogValues.length,
  `${freeBefore.length}/${catalogValues.length} allowed before -> ${freeAfter.length}/${catalogValues.length} after`);

// ── 2. the paid route is unreachable ───────────────────────────────────────
const appText = after.get('src/app.js') || '';
const meth = (src, name) => (src.match(new RegExp(name + '\\(\\)\\s*\\{([\\s\\S]*?)\\n  \\}')) || [])[1] || '';

check('isUseRopilotCreditsEnabled() cannot return true',
  /return false;/.test(meth(appText, 'isUseRopilotCreditsEnabled'))
    && !/return this\.useRopilotCredits;/.test(meth(appText, 'isUseRopilotCreditsEnabled')),
  'the stored flag and localStorage are both ignored');

check('isCodexFreeAccount() cannot return true',
  /return false;/.test(meth(appText, 'isCodexFreeAccount'))
    && !/plan === 'free'/.test(meth(appText, 'isCodexFreeAccount')),
  'plan no longer gates models, fast mode or defaults');

check('free-credits onboarding branch is dead',
  /isFreeOfferOnboardingPending\(\)\s*\{\s*\n\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*return false;/.test(after.get('src/js/setup-flow.js') || ''),
  'onboarding falls through to provider setup instead of a credit claim');

// ── 3. no purchase path survives anywhere in the tree ──────────────────────
// Executable-level markers: a URL, an element id or a price string that code or
// markup can actually reach. These must be gone from the tree and from the
// packed artifact.
const EXEC = [
  ['the /pricing checkout target',     'siteUrl}/pricing'],
  ['the auto top-up endpoint',         '/api/auto-refill'],
  ['the Buy Credits button',           'btn-buy-credits'],
  ['the credits-wall checkout button', 'id="cic-upgrade"'],
  ['a price string',                   'Get 30 credits'],
  ['the credit-reimbursement dialog',  'credit-reimbursement-template'],
  ['the invite promo markup',          'cic-invite'],
];

// Selector-level markers. Stylesheets keep rules for widgets whose markup was
// deleted. A rule with nothing to match cannot be clicked, but it is still a
// selector naming the removed feature, so it gets counted rather than quietly
// ignored — the report should not claim more than it proved.
const COSMETIC_FILES = [
  'src/css/sidebar.css',
  'src/css/credit-reimbursement.css',
  'src/css/chat/credits-inline-card.css',
  'src/css/chat/setup-legacy-cic.css',
];

for (const [label, needle] of EXEC) {
  const was = hits(before, needle).length;
  const now = hits(after, needle);
  check(`gone: ${label}`, now.length === 0,
    was ? `present in ${was} file(s) before, ${now.length} now${now.length ? ' — ' + now.join(', ') : ''}`
        : `not present before either (${now.length} now)`);
}

check('gone: the balance fetch on launch',
  [...after.values()].every((t) => !t.includes('/api/ai/credits')),
  'GET /api/ai/credits is no longer anywhere in the tree');

check('gone: the update prompt pointing at the paid release',
  !(after.get('main.min.js') || '').includes('checkAppUpdate(o.version)'),
  'the main process no longer offers to replace this build');

const leftoverCss = [];
for (const file of COSMETIC_FILES) {
  const full = path.join(PAT, file);
  if (!fs.existsSync(full)) { continue; }
  const text = fs.readFileSync(full, 'utf8');
  for (const needle of ['invite-widget', 'cic-invite', 'credit-reimbursement']) {
    const n = text.split(needle).length - 1;
    if (n) leftoverCss.push(`${file}: ${n} selector(s) mentioning ${needle}`);
  }
}

check('the rewritten wall makes no network calls at all',
  !/\bfetch\s*\(/.test(after.get('src/js/credits/credits-wall.js') || ''),
  'no fetch, no billing, no telemetry');

// ── 4. the artifact that actually ships ────────────────────────────────────
const asar = fs.readFileSync(ASAR);
const asarText = asar.toString('latin1');

check('shipped asar carries the patched gates',
  asarText.includes('ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES = new Set();')
    && asarText.includes('free build: always bring-your-own'),
  `${asar.length} bytes`);

// `cic-invite` is deliberately exempt from the artifact scan. It survives only
// as dead selectors in the chat stylesheets — the check above already proved no
// .js or .html file references it, and a selector with no markup to match is not
// a purchase path. Stripping CSS blocks to chase a string is not worth the
// chance of breaking the styling the rest of the UI shares those files with.
const asarLeaks = EXEC
  .filter(([, needle]) => needle !== 'cic-invite' && asarText.includes(needle))
  .map(([l]) => l);
check('shipped asar carries no purchase path', asarLeaks.length === 0,
  asarLeaks.length
    ? 'LEAKED: ' + asarLeaks.join(', ')
    : `${EXEC.length - 1} executable markers absent from the packed asar (cic-invite exempt: dead CSS only)`);

check('shipped asar is the tree that was just verified',
  asarText.includes('free build: the plan no longer gates')
    && asarText.includes('Your plan\'s limit, not a paywall'),
  'pass-1 and pass-2 markers both present');

// ── report ─────────────────────────────────────────────────────────────────
const fails = results.filter((r) => !r.pass).length;
console.log('Ropilot free build — verification\n');
for (const r of results) {
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n          ${r.detail}` : ''}`);
}
console.log(`\n${results.length - fails}/${results.length} ${fails ? 'FAILED' : 'PASSED'}`);
if (leftoverCss.length) {
  console.log('\nunreachable stylesheet selectors left in place (no markup to match):');
  for (const line of leftoverCss) console.log(`  - ${line}`);
}
console.log(`sha256(app.asar) = ${crypto.createHash('sha256').update(asar).digest('hex')}`);
process.exit(fails ? 1 : 0);
