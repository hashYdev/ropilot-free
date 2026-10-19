#!/usr/bin/env python3
"""Tenth pass: OpenCode as a third provider.

Ropilot drives two CLIs: Claude Code and Codex. Both are spawned by the local
bridge and their output is streamed back over the websocket. OpenCode is a
third one, and it is the one that matters here — it is the only provider on
this machine that is already configured, already authenticated, and already
able to write files.

OpenCode's CLI is the integration point:

    opencode run --format json --agent <agent> --model <provider/model> <prompt>

--format json emits NDJSON, one object per event:

    {"type":"text","part":{"type":"text","text":"..."}}
    {"type":"reasoning","part":{"type":"reasoning","text":"..."}}
    {"type":"error","error":{"message":"..."}}
    {"type":"step_start", ...}
    {"type":"step_finish", ...}

which is the same shape the bridge already parses for Claude Code, so the
bridge needed one provider branch and a parser case.

On the client side the provider is a first-class entry in the model catalog.
Four places, all in this tree:

  1. MODEL_CATALOG gets the opencode entries.
  2. DEFAULT_MODEL_BY_PROVIDER gets opencode's default.
  3. COMPOSER_MODEL_PROVIDER_ORDER gets 'opencode', so the model picker's
     provider tabs include it.
  4. normalizeModelProvider() learns the name. It is a whitelist with a
     fallback to 'claude', so without this every opencode value would be
     silently rewritten to claude and the bridge would never be asked for it.

Plus the two UI bits that would otherwise render an empty icon and the wrong
label: provider-marks.js and the composer's provider label.
"""
import io
import os
import re
import sys

ROOT = os.environ.get('ROPILOT_APP', os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')))
applied = []


def edit(rel, old, new, why, count=1):
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding='utf-8').read()
    if new in src and old not in src:
        print('  = %-46s already patched' % rel)
        return
    hits = src.count(old)
    if hits != count:
        print('  ! %-46s matched %d times (expected %d) — ABORTING'
              % (rel, hits, count))
        sys.exit(1)
    io.open(path, 'w', encoding='utf-8', newline='').write(src.replace(old, new, count))
    applied.append(rel)
    print('  + %-46s %s' % (rel, why))


CAT = 'src/js/models/model-catalog.js'

# ── 1. the catalog entries ───────────────────────────────────────────────────
# The values are the opencode CLI's own model ids, so the bridge can pass them
# straight through with --model.
edit(
    CAT,
    """  {
    value: 'gpt-5.3-codex-spark',
    label: 'GPT 5.3 Spark',
    provider: 'codex',
    supportsFastMode: false
  }
];""",
    """  {
    value: 'gpt-5.3-codex-spark',
    label: 'GPT 5.3 Spark',
    provider: 'codex',
    supportsFastMode: false
  },
  // OpenCode. The value is the opencode CLI's own model id, so the bridge
  // can hand it to `opencode run --model` unchanged. The label is what the
  // picker shows.
  {
    value: 'apmix/claude-sonnet-4-6-free',
    label: 'Claude Sonnet 4.6 (OpenCode)',
    provider: 'opencode',
    supportsFastMode: false
  },
  {
    value: 'apinex/free/gpt-6-luna',
    label: 'GPT 6 Luna (OpenCode)',
    provider: 'opencode',
    supportsFastMode: false
  },
  {
    value: 'gpt-uni/auto',
    label: 'GPT-Uni (OpenCode)',
    provider: 'opencode',
    supportsFastMode: false
  }
];""",
    'opencode models added to the catalog')

# ── 2. the provider default ─────────────────────────────────────────────────
edit(
    CAT,
    """  claude: 'claude-opus-5-5[1m]',
  codex: 'gpt-6.1-sol',
  ropilot: 'ropilot-blaze'
};""",
    """  claude: 'claude-opus-5-5[1m]',
  codex: 'gpt-6.1-sol',
  ropilot: 'ropilot-blaze',
  opencode: 'apmix/claude-sonnet-4-6-free'
};""",
    'opencode default model')

# ── 3. the provider tabs ─────────────────────────────────────────────────────
edit(
    CAT,
    "export const COMPOSER_MODEL_PROVIDER_ORDER = ['ropilot', 'codex', 'claude'];",
    "export const COMPOSER_MODEL_PROVIDER_ORDER = ['ropilot', 'codex', 'claude', 'opencode'];",
    'opencode added to the composer provider order')

# ── 4. the whitelist ─────────────────────────────────────────────────────────
# This is the one that matters. normalizeModelProvider falls back to 'claude',
# so an unrecognised provider is not an error — it is a silent rewrite.
edit(
    CAT,
    """  if (value === 'ropilot' || value === 'google' || value === 'gemini') return 'ropilot';
  if (value === 'codex' || value === 'openai') return 'codex';
  return 'claude';""",
    """  if (value === 'ropilot' || value === 'google' || value === 'gemini') return 'ropilot';
  if (value === 'codex' || value === 'openai') return 'codex';
  if (value === 'opencode' || value === 'oc') return 'opencode';
  return 'claude';""",
    'opencode accepted by normalizeModelProvider')

# ── 4b. the model-id normaliser ──────────────────────────────────────────────
# normalizeSelectedModel lowercases the value and then matches it against the
# legacy Claude aliases. An OpenCode model id is the CLI's own provider/model
# string, and it can contain one of those aliases by accident — "apmix/
# claude-sonnet-4-6-free" contains "claude-sonnet-4-6" — so it gets silently
# rewritten to claude-opus-5-5[1m] and the picker cannot hold an OpenCode
# model at all. A catalogued OpenCode value is returned unchanged.
edit(
    CAT,
    """export function normalizeSelectedModel(model) {
  const value = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!value) return DEFAULT_MODEL_BY_PROVIDER.claude;""",
    """export function normalizeSelectedModel(model) {
  const value = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!value) return DEFAULT_MODEL_BY_PROVIDER.claude;
  // OpenCode model ids are the CLI's own provider/model strings, and they can
  // contain a legacy Claude alias by accident. A catalogued OpenCode value is
  // not an alias and must not be rewritten to one.
  if (MODEL_CATALOG.some((m) => m.provider === 'opencode' && m.value === value)) {
    return value;
  }""",
    'opencode model ids exempted from the alias normaliser')

# ── 5. the provider mark ─────────────────────────────────────────────────────
edit(
    'src/js/ui/provider-marks.js',
    """export function getProviderMarkSvg(provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'codex' || p === 'openai') return OPENAI_MARK;""",
    """// OpenCode's own mark: the stacked-layers glyph from its logo.
const OPENCODE_MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 21 8 12 13 3 8 12 3Z"/><path d="M3 12 12 17 21 12"/><path d="M3 16 12 21 21 16"/></svg>';

export function getProviderMarkSvg(provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'opencode' || p === 'oc') return OPENCODE_MARK;
  if (p === 'codex' || p === 'openai') return OPENAI_MARK;""",
    'opencode provider mark')

# ── 6. the composer's provider label ─────────────────────────────────────────
edit(
    'src/js/composer/composer-dropdowns.js',
    """    if (normalizedProvider === 'ropilot') return 'Ropilot';
    if (normalizedProvider === 'codex') return 'OpenAI';
    return 'Anthropic';""",
    """    if (normalizedProvider === 'ropilot') return 'Ropilot';
    if (normalizedProvider === 'codex') return 'OpenAI';
    if (normalizedProvider === 'opencode') return 'OpenCode';
    return 'Anthropic';""",
    'opencode provider label')

# ── 7. the auth map ──────────────────────────────────────────────────────────
# refreshModelOptions only offers a provider's models when the auth map says
# that provider is authenticated, and the map is built from the Claude and
# Codex status IPCs. There is no IPC for a third CLI, but the bridge is ours
# and it already knows which binaries are on PATH — and the renderer can reach
# it over HTTP, because it is CORS-enabled and the renderer already knows the
# port from getWsUrl().
edit(
    'src/js/composer/composer-footer.js',
    """    return {
      claude: claudeAuthenticated,
      codex: codexAuthenticated
    };
  }""",
    """    // OpenCode has no status IPC, so ask the bridge — it reports which
    // provider CLIs are actually installed. The ws URL already carries the
    // port, so the same host serves it. The host has to be localhost and not
    // 127.0.0.1: the page's connect-src allows http://localhost:* and not
    // the loopback address, and the CSP refusal is silent in the UI.
    let opencodeAuthenticated = false;
    try {
      const wsUrl = await electronAPI().getWsUrl?.();
      const port = wsUrl ? (new URL(wsUrl).port || '8765') : '8765';
      const res = await fetch(`http://localhost:${port}/providers`);
      const info = await res.json();
      opencodeAuthenticated = !!info?.opencode;
    } catch (err) {
      console.warn('Failed to fetch OpenCode availability for models:', err);
    }

    return {
      claude: claudeAuthenticated,
      codex: codexAuthenticated,
      opencode: opencodeAuthenticated
    };
  }""",
    'opencode added to the model auth map')

print()
print('%d edit(s) applied' % len(applied))
