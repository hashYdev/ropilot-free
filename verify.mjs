// Proof for the Ropilot free build.
//
//   node verify.mjs
//
// Two kinds of evidence, because they catch different failures:
//
//   * app/src/js/models/model-catalog.js is pure, so it imports for real and the
//     gate sets are counted rather than eyeballed. If a pristine copy of the
//     stock asar is extracted at ./orig, the before/after numbers are measured
//     against it; otherwise the checks still run, without the comparison.
//   * everything else is scanned as source text across the whole app/ tree. That
//     is the stronger test for this job anyway: a purchase path that no longer
//     connects is still a purchase path if its URL is in the code.
//
// The staged app.asar is scanned too, when it exists. Passing on app/ while the
// packed artifact is stale is exactly the failure this is meant to prevent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(ROOT, 'app');
const ORIG = path.join(ROOT, 'orig');
const ASAR = path.join(ROOT, 'build/stage/resources/app.asar');

const hasOrig = fs.existsSync(path.join(ORIG, 'src/js/models/model-catalog.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ── load every source file in a tree ────────────────────────────────────────
function sources(root) {
  const out = new Map();
  for (const rel of ['src', 'lib', 'bootstrap.js', 'preload.js', 'main.min.js']) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isFile()) { out.set(rel, fs.readFileSync(p, 'utf8')); continue; }
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

const after = sources(APP);
const before = hasOrig ? sources(ORIG) : null;

const hits = (map, needle) => [...map.entries()]
  .filter(([, text]) => text.includes(needle))
  .map(([rel]) => rel);

// ── 1. the model gates, measured ───────────────────────────────────────────
const catAfter = await import(path.join(APP, 'src/js/models/model-catalog.js'));
const catalogValues = catAfter.MODEL_CATALOG.map((m) => m.value);

check('catalog loads from app/', catalogValues.length > 0, `${catalogValues.length} models`);

check('hidden-model sets are empty',
  catAfter.ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES.size === 0
    && catAfter.ROPILOT_CREDITS_HIDDEN_MODEL_VALUES.size === 0,
  'no model is hidden from the picker, on any plan');

const freeAfter = catalogValues.filter((v) => catAfter.CODEX_FREE_ALLOWED_MODELS.has(v));
check('a free ChatGPT plan no longer restricts the picker',
  freeAfter.length === catalogValues.length,
  `${freeAfter.length}/${catalogValues.length} models allowed on a free plan`);

if (hasOrig) {
  const catBefore = await import(path.join(ORIG, 'src/js/models/model-catalog.js'));
  const freeBefore = catalogValues.filter((v) => catBefore.CODEX_FREE_ALLOWED_MODELS.has(v));
  check('measured against the stock build',
    catBefore.ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES.size > 0 && freeBefore.length < catalogValues.length,
    `stock: ${freeBefore.length}/${catalogValues.length} allowed on a free plan, `
    + `${catBefore.ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES.size + catBefore.ROPILOT_CREDITS_HIDDEN_MODEL_VALUES.size} hidden`);
}

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
  /isFreeOfferOnboardingPending\(\)\s*\{\s*\n\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*return false;/
    .test(after.get('src/js/setup-flow.js') || ''),
  'onboarding falls through to provider setup instead of a credit claim');

// ── 3. no purchase path survives anywhere ──────────────────────────────────
// Executable-level markers: a URL, an element id or a price string that code or
// markup can actually reach. These must be gone from the tree.
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
  const was = before ? hits(before, needle).length : null;
  const now = hits(after, needle);
  check(`gone: ${label}`, now.length === 0,
    was === null
      ? `${now.length} file(s)`
      : `present in ${was} file(s) before, ${now.length} now${now.length ? ' — ' + now.join(', ') : ''}`);
}

check('gone: the balance fetch on launch',
  [...after.values()].every((t) => !t.includes('/api/ai/credits')),
  'GET /api/ai/credits is no longer anywhere in the tree');

check('gone: the update prompt pointing at the paid release',
  !(after.get('main.min.js') || '').includes('checkAppUpdate(o.version)'),
  'the main process no longer offers to replace this build');

const leftoverCss = [];
for (const file of COSMETIC_FILES) {
  const full = path.join(APP, file);
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

// ── 4. the artifact that actually ships, if it has been staged ─────────────
let asar = null;
if (fs.existsSync(ASAR)) {
  asar = fs.readFileSync(ASAR);
  const asarText = asar.toString('latin1');

  check('staged asar carries the patched gates',
    asarText.includes('ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES = new Set();')
      && asarText.includes('free build: always bring-your-own'),
    `${asar.length} bytes`);

  // `cic-invite` is deliberately exempt from the artifact scan. It survives only
  // as dead selectors in the chat stylesheets — the check above already proved
  // no .js or .html file references it, and a selector with no markup to match
  // is not a purchase path. Stripping CSS blocks to chase a string is not worth
  // the chance of breaking styling the rest of the UI shares those files with.
  const asarLeaks = EXEC
    .filter(([, needle]) => needle !== 'cic-invite' && asarText.includes(needle))
    .map(([l]) => l);
  check('staged asar carries no purchase path', asarLeaks.length === 0,
    asarLeaks.length ? 'LEAKED: ' + asarLeaks.join(', ')
      : `${EXEC.length - 1} executable markers absent (cic-invite exempt: dead CSS only)`);

  check('staged asar is the tree that was just verified',
    asarText.includes('free build: the plan no longer gates')
      && asarText.includes("Your plan's limit, not a paywall"),
    'pass-1 and pass-2 markers both present');
} else {
  check('staged asar not built yet', true, 'run build.sh to stage it');
}

// ── report ─────────────────────────────────────────────────────────────────
const fails = results.filter((r) => !r.pass).length;
console.log('Ropilot free build — verification' + (hasOrig ? '' : '  (no ./orig, before/after skipped)\n'));
for (const r of results) {
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n          ${r.detail}` : ''}`);
}
console.log(`\n${results.length - fails}/${results.length} ${fails ? 'FAILED' : 'PASSED'}`);
if (leftoverCss.length) {
  console.log('\nunreachable stylesheet selectors left in place (no markup to match):');
  for (const line of leftoverCss) console.log(`  - ${line}`);
}
if (asar) console.log(`sha256(app.asar) = ${crypto.createHash('sha256').update(asar).digest('hex')}`);
process.exit(fails ? 1 : 0);
