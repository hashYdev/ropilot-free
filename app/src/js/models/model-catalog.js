// @ts-check
// Model/provider catalog — the single source of truth for the model and
// provider catalog: which models exist, which provider owns them, default
// models per provider, Ropilot Credits allow-lists/cost tiers, Codex free-plan
// restrictions, and reasoning-level rules. Pure helpers only; anything that
// needs app state (settings, DOM, store) stays in app.js and delegates here.

export const MODEL_CATALOG = [
  {
    value: 'claude-opus-5-5[1m]',
    label: 'Claude Opus 5.5',
    provider: 'claude',
    supportsFastMode: false
  },
  // 2026-10-04: Claude is 1M-context only, and Opus 5, Fable 5 and Sonnet 5
  // are deprecated. normalizeSelectedModel remaps their saved selections and
  // the standard-context values onto the entries below.
  {
    value: 'claude-fable-5-1[1m]',
    label: 'Claude Fable 5.1',
    provider: 'claude',
    supportsFastMode: false
  },
  // Sonnet 5.5 (released 2026-09-28): own-login (Ropilot Actions) only; needs
  // Claude Code >= 2.1.284. Not a Credits model (no managed route serves it).
  {
    value: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    provider: 'claude',
    supportsFastMode: false
  },
  {
    value: 'gpt-6-astra',
    label: 'GPT 6 Astra',
    provider: 'codex',
    supportsFastMode: true
  },
  {
    value: 'gpt-6.1-sol',
    label: 'GPT 6.1 Sol',
    provider: 'codex',
    supportsFastMode: true
  },
  {
    value: 'gpt-6-luna',
    label: 'GPT 6 Luna',
    provider: 'codex',
    supportsFastMode: true
  },
  {
    value: 'gpt-5.6-terra',
    label: 'GPT 5.6 Terra',
    provider: 'codex',
    supportsFastMode: true
  },
  {
    value: 'gpt-5.5',
    label: 'GPT 5.5',
    provider: 'codex',
    supportsFastMode: true
  },
  {
    value: 'ropilot-blaze',
    label: 'Ropilot Blaze',
    provider: 'ropilot',
    supportsFastMode: false
  },
  {
    value: 'gpt-5.4',
    label: 'GPT 5.4',
    provider: 'codex',
    supportsFastMode: true
  },
  {
    value: 'gpt-5.4-mini',
    label: 'GPT 5.4 mini',
    provider: 'codex',
    supportsFastMode: false
  },
  {
    value: 'gpt-5.3-codex',
    label: 'GPT 5.3 Codex',
    provider: 'codex',
    supportsFastMode: true
  },
  {
    value: 'gpt-5.2-codex',
    label: 'GPT 5.2 Codex',
    provider: 'codex',
    supportsFastMode: false
  },
  {
    value: 'gpt-5.3-codex-spark',
    label: 'GPT 5.3 Spark',
    provider: 'codex',
    supportsFastMode: false
  }
];
export const DEFAULT_MODEL_BY_PROVIDER = {
  // 2026-09-23: Opus 5.5 (the catalog's single, 1M-backed entry) is the
  // newest Claude and the provider default, above Opus 5.
  claude: 'claude-opus-5-5[1m]',
  codex: 'gpt-6.1-sol',
  ropilot: 'ropilot-blaze'
};
export const COMPOSER_MODEL_PROVIDER_ORDER = ['ropilot', 'codex', 'claude'];
export const ROPILOT_CREDITS_MODEL_VALUES = new Set([
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-luna',
  'gpt-5.6-terra',
  // 2026-09-23: Opus 5.5 joined Credits (ggwk serves it, priced identically
  // to Opus 5). The catalog's single Opus 5.5 entry is the 1M-backed value.
  'claude-opus-5-5[1m]'
]);
// 2026-09-23: Opus 4.x retired from the catalog entirely (aliases remap to
// Opus 5.5 on BYOK; Credits coerces stale picks to the managed default).
export const ROPILOT_CREDITS_HIDDEN_MODEL_VALUES = new Set();
export const ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES = new Set();
export const ROPILOT_CREDITS_MODEL_COST_TIERS = {
  // 2026-09-30: Astra shown as $$$ (operator).
  'gpt-6-astra': 3,
  'gpt-6.1-sol': 1,
  'gpt-5.6-terra': 1,
  'ropilot-blaze': 1,
  // 2026-09-23: Opus tiers are set by product. After the openlux gross-input
  // netting fix, correctly billed Opus 5.5 lands at about the same credits
  // per output token as Opus 5, so both sit one step above GPT 6 Sol.
  'claude-opus-5-5[1m]': 2
};
export const ROPILOT_CREDITS_PROVIDER_COST_TIERS = {
  ropilot: 1,
  codex: 2,
  claude: 4
};
// Managed Fast mode (service_tier: 'priority' on the Ropilot Credits route).
// Distinct from the personal Codex fast toggle (service_tier: 'fast', BYO
// subscription only) and from the Standard/Priority route selector, which
// controls provider reliability rather than OpenAI's service tier.
export const ROPILOT_CREDITS_FAST_MODE_MODEL_VALUES = new Set([
  'gpt-6-astra',
  'gpt-6.1-sol'
]);
export const ROPILOT_CREDITS_FAST_MODE_COST_MULTIPLIER = 2.5;
export const ROPILOT_CREDITS_FAST_MODE_SERVICE_TIER = 'priority';
export const LOW_QUALITY_ROPILOT_CREDITS_MODEL_VALUES = new Set(['ropilot-blaze']);
export const ROPILOT_CREDITS_DEFAULT_MODEL = 'gpt-6.1-sol';
export const ROPILOT_CREDITS_LEGACY_DEFAULT_MODELS = new Set(['ropilot-blaze', 'gpt-5.5']);
export const CODEX_FREE_DEFAULT_MODEL = 'gpt-5.6-terra';
// free build: a free ChatGPT plan no longer restricts the picker.
export const CODEX_FREE_ALLOWED_MODELS = new Set(MODEL_CATALOG.map((m) => m.value));
export const CODEX_FREE_DEFAULT_REASONING_LEVEL = 'medium';
export const CODEX_FREE_HIDDEN_MODELS_NOTE = 'Some Codex models are hidden on ChatGPT Free. GPT 5.6 Terra and Max are available; Astra, GPT 6.1 Sol, GPT 6 Luna, and Ultra require a paid ChatGPT plan with model access.';
export const ROPILOT_CREDITS_BASE_REASONING_LEVELS = ['low', 'medium'];
export const ROPILOT_CREDITS_PLUS_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'];
export const ROPILOT_CREDITS_REASONING_LEVELS = ROPILOT_CREDITS_BASE_REASONING_LEVELS;
export const RECOMMENDED_ROPILOT_CREDITS_MODEL_VALUES = new Set(['gpt-6.1-sol']);
// Composer model-menu metadata for Ropilot Credits mode: one-line
// descriptors (plus the flagship's featured row).
export const ROPILOT_CREDITS_MODEL_MENU_META = {
  'gpt-6-astra': {
    featured: true,
    description: 'Most capable OpenAI model',
  },
  'gpt-6.1-sol': {
    pill: { kind: 'new', label: 'New' },
    description: 'Close to Astra on coding at a much lower cost \u00b7 the default for most work',
  },
  'gpt-6-luna': {
    pill: { kind: 'free', label: 'Free' },
    description: 'Low and Medium are free on Standard — High, Extra High, Priority and Fast use credits',
  },
  'gpt-5.6-terra': {
    description: 'Fast and cheap — great for smaller tasks',
  },
  'claude-opus-5-5[1m]': {
    description: 'Anthropic\u2019s newest and most capable model \u00b7 best for hard, multi-step builds',
  },
  'claude-sonnet-5-5': {
    description: 'Newest Sonnet \u00b7 near Opus quality, faster and cheaper',
  },
  'ropilot-blaze': {
    description: 'Lightweight starter model',
  },
};
export const DEFAULT_CODEX_PLAYTEST_SUBAGENT_MODEL = 'auto';
export const DEFAULT_CODEX_PLAYTEST_EXECUTION_MODEL = 'gpt-5.6-terra';

// Resolve at the wire boundary so installed helpers with the old automatic
// default cannot silently launch an unsupported GPT-5.4 mini tester.
export function resolveCodexPlaytestExecutionModel(preference) {
  const value = String(preference || '').trim().toLowerCase();
  return ['', 'auto', 'default'].includes(value)
    ? DEFAULT_CODEX_PLAYTEST_EXECUTION_MODEL
    : value;
}
export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const REASONING_LEVEL_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra'
};
export const ROPILOT_CREDITS_ROUTE_PRIORITY_LABELS = {
  economy: 'Standard',
  priority: 'Priority'
};

/**
 * @param {unknown} model
 * @returns {string}
 */
export function normalizeSelectedModel(model) {
  const value = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!value) return DEFAULT_MODEL_BY_PROVIDER.claude;
  // Legacy Claude aliases — the CLI resolves `opus`/`opus[1m]` to the latest.
  // Pin to explicit IDs so labels always match the actual model.
  // 2026-10-04: Claude is 1M-context only. Fable 5 and the standard-context
  // Fable 5.1 land on Fable 5.1 [1m]; Opus 5, Sonnet 5, the standard-context
  // Opus 5.5 and every Opus 4.x / Sonnet 4.6 alias land on Opus 5.5 [1m].
  if (
    value === 'fable' || value === 'fable[1m]' || value === 'claude-fable-5' || value === 'claude-fable-5[1m]' ||
    value === 'fable-5.1' || value === 'fable-5-1' || value === 'claude-fable-5-1' || value === 'claude-fable-5.1' ||
    value === 'fable-5.1[1m]' || value === 'fable-5-1[1m]' || value === 'claude-fable-5-1[1m]' || value === 'claude-fable-5.1[1m]'
  ) {
    return 'claude-fable-5-1[1m]';
  }
  if (
    value === 'opus' || value === 'claude-opus-5' || value === 'claude-opus-5[1m]' ||
    value === 'claude-opus-5-5[1m]' || value === 'claude-opus-5.5[1m]' || value === 'opus-5.5[1m]' || value === 'opus-5-5[1m]' ||
    value === 'claude-opus-5-5' || value === 'claude-opus-5.5' || value === 'opus-5.5' || value === 'opus-5-5' ||
    value === 'opus' || value === 'opus[1m]' || value === 'claude-opus-5' || value === 'claude-opus-5[1m]' ||
    value === 'claude-opus-4-8[1m]' || value === 'claude-opus-4.8[1m]' || value === 'claude-opus-4-8' || value === 'claude-opus-4.8' ||
    value === 'claude-opus-4-7[1m]' || value === 'claude-opus-4.7[1m]' || value === 'claude-opus-4-7' || value === 'claude-opus-4.7' ||
    value === 'claude-opus-4-6[1m]' || value === 'claude-opus-4.6[1m]' || value === 'claude-opus-4-6' || value === 'claude-opus-4.6' ||
    value === 'sonnet' || value === 'claude-sonnet-5' || value === 'claude-sonnet-4-6' || value === 'claude-sonnet-4.6'
  ) {
    return 'claude-opus-5-5[1m]';
  }
  if (value === 'claude-sonnet-5-5' || value === 'claude-sonnet-5.5' || value === 'sonnet-5.5' || value === 'sonnet-5-5' ||
      value === 'claude-sonnet-5-5[1m]' || value === 'claude-sonnet-5.5[1m]') {
    return 'claude-sonnet-5-5';
  }
  // 2026-09-22: GPT 5.6 Sol / Luna are retired from every picker; saved
  // selections land on their GPT-6 twins (same reasoning surface, half price).
  // 2026-09-29: GPT 6.1 Sol replaces GPT 6 Sol (same router pricing), so
  // saved GPT 6 Sol and 5.6 Sol selections land on 6.1 Sol.
  if (value === 'gpt-5.6-sol' || value === 'gpt-5.6' || value === 'gpt-6-sol') {
    return 'gpt-6.1-sol';
  }
  if (value === 'gpt-5.6-luna') {
    return 'gpt-6-luna';
  }
  if (
    value === 'gpt-6-astra' ||
    value === 'gpt-6.1-sol' ||
    value === 'gpt-6-luna' ||
    value === 'gpt-5.6-terra' ||
    value === 'gpt-5.4' ||
    value === 'gpt-5.5' ||
    value === 'gpt-5.4-mini' ||
    value === 'gpt-5.3-codex' ||
    value === 'gpt-5.2-codex' ||
    value === 'gpt-5.3-codex-spark'
  ) {
    return value;
  }
  if (
    value === 'ropilot-blaze' ||
    value === 'gemini-3-flash' ||
    value === 'google/gemini-3-flash-preview' ||
    value === 'gemini-3-flash-openai' ||
    value === 'gemini-flash' ||
    value === 'gemini'
  ) {
    return 'ropilot-blaze';
  }
  return DEFAULT_MODEL_BY_PROVIDER.claude;
}

/**
 * @param {unknown} provider
 * @returns {string}
 */
export function normalizeModelProvider(provider) {
  const value = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (value === 'ropilot' || value === 'google' || value === 'gemini') return 'ropilot';
  if (value === 'codex' || value === 'openai') return 'codex';
  return 'claude';
}

/**
 * @param {unknown} level
 * @returns {string}
 */
export function normalizeReasoningLevel(level) {
  const value = typeof level === 'string' ? level.trim().toLowerCase() : '';
  return REASONING_LEVELS.includes(value) ? value : '';
}

/**
 * Preserve the old managed GPT-5.5 reasoning choice when moving to Sol.
 * Blaze was an older default with different reasoning semantics and continues
 * to migrate to Low, matching its existing behavior.
 *
 * @param {unknown} sourceModel
 * @param {unknown} level
 * @param {boolean} [hasRopilotPlusAccess]
 * @returns {string}
 */
export function getMigratedRopilotCreditsReasoningLevel(sourceModel, level, hasRopilotPlusAccess = false) {
  if (normalizeSelectedModel(sourceModel) !== 'gpt-5.5') {
    return 'low';
  }
  const normalizedLevel = normalizeReasoningLevel(level);
  const allowedLevels = hasRopilotPlusAccess
    ? ROPILOT_CREDITS_PLUS_REASONING_LEVELS
    : ROPILOT_CREDITS_BASE_REASONING_LEVELS;
  return allowedLevels.includes(normalizedLevel) ? normalizedLevel : 'low';
}

/**
 * @param {unknown} modelValue
 * @returns {{ value: string, label: string, provider: string, supportsFastMode: boolean } | null}
 */
export function getModelConfig(modelValue) {
  const normalizedModel = normalizeSelectedModel(modelValue);
  return MODEL_CATALOG.find((model) => model.value === normalizedModel) || null;
}

/**
 * @param {unknown} provider
 * @returns {string}
 */
export function getProviderDisplayName(provider) {
  const normalizedProvider = normalizeModelProvider(provider);
  if (normalizedProvider === 'ropilot') return 'Ropilot';
  if (normalizedProvider === 'codex') return 'Codex';
  return 'Claude Code';
}

/**
 * @param {unknown} modelValue
 * @returns {string | null}
 */
export function getProviderForModel(modelValue) {
  const normalizedModel = normalizeSelectedModel(modelValue);
  const entry = MODEL_CATALOG.find((model) => model.value === normalizedModel);
  return entry ? normalizeModelProvider(entry.provider) : null;
}

/**
 * @param {unknown} provider
 * @returns {Array<{ value: string, label: string, provider: string, supportsFastMode: boolean }>}
 */
export function getModelsForProvider(provider) {
  const normalizedProvider = normalizeModelProvider(provider);
  return MODEL_CATALOG.filter((model) => model.provider === normalizedProvider);
}

/**
 * @param {unknown} provider
 * @param {boolean} [isCodexFreeAccount] resolved from app state by the caller
 * @returns {string}
 */
export function getDefaultModelForProvider(provider, isCodexFreeAccount = false) {
  const normalizedProvider = normalizeModelProvider(provider);
  if (normalizedProvider === 'codex' && isCodexFreeAccount) {
    return CODEX_FREE_DEFAULT_MODEL;
  }
  return DEFAULT_MODEL_BY_PROVIDER[normalizedProvider] || DEFAULT_MODEL_BY_PROVIDER.claude;
}

/**
 * @param {unknown} model
 * @returns {boolean}
 */
export function supportsXHighReasoningForModel(model) {
  const normalizedModel = normalizeSelectedModel(model);
  const provider = getProviderForModel(normalizedModel);
  if (provider === 'claude') {
    return normalizedModel === 'claude-opus-5-5[1m]' ||
      normalizedModel === 'claude-fable-5-1[1m]' ||
      normalizedModel === 'claude-sonnet-5-5';
  }
  if (provider !== 'codex') {
    return false;
  }

  // Codex "spark" is a lighter tier; GPT-5.4+ and full Codex models expose xhigh.
  return /^gpt-6-(?:astra|sol|luna)$/.test(normalizedModel) || normalizedModel === 'gpt-6.1-sol' || /^gpt-5\.6-terra$/.test(normalizedModel) || normalizedModel === 'gpt-5.5' || /^gpt-5\.4(?:-.+)?$/.test(normalizedModel) || /^gpt-\d+(?:\.\d+)?-codex$/.test(normalizedModel);
}

/**
 * @param {unknown} model
 * @param {boolean} [useRopilotCredits] resolved from app state by the caller
 * @param {boolean} [hasRopilotPlusAccess] resolved from app state by the caller
 * @param {boolean} [isCodexFreeAccount] resolved from app state by the caller
 * @returns {string[]}
 */
export function getSupportedReasoningLevelsForModel(model, useRopilotCredits = false, hasRopilotPlusAccess = false, isCodexFreeAccount = false) {
  if (useRopilotCredits) {
    // Luna runs the full Low → Extra High ladder like every credits model;
    // Low and Medium are its free levels on the Standard route.
    return hasRopilotPlusAccess
      ? [...ROPILOT_CREDITS_PLUS_REASONING_LEVELS]
      : [...ROPILOT_CREDITS_BASE_REASONING_LEVELS];
  }
  const normalizedModel = normalizeSelectedModel(model);
  if (normalizedModel === 'ropilot-blaze') {
    return ['low', 'high'];
  }
  if (normalizedModel === 'gpt-6-astra' || normalizedModel === 'gpt-6.1-sol' || normalizedModel === 'gpt-5.6-terra') {
    return REASONING_LEVELS.filter((level) => !(isCodexFreeAccount && level === 'ultra'));
  }
  if (normalizedModel === 'gpt-6-luna') {
    return REASONING_LEVELS.filter((level) => level !== 'ultra');
  }
  const standardReasoningLevels = REASONING_LEVELS.filter((level) => level !== 'max' && level !== 'ultra');
  return supportsXHighReasoningForModel(model)
    ? standardReasoningLevels
    : standardReasoningLevels.filter((level) => level !== 'xhigh');
}

/**
 * @param {unknown} model
 * @param {unknown} level
 * @param {boolean} [useRopilotCredits] resolved from app state by the caller
 * @param {boolean} [hasRopilotPlusAccess] resolved from app state by the caller
 * @param {boolean} [isCodexFreeAccount] resolved from app state by the caller
 * @returns {string}
 */
export function normalizeReasoningLevelForModel(model, level, useRopilotCredits = false, hasRopilotPlusAccess = false, isCodexFreeAccount = false) {
  const normalizedLevel = normalizeReasoningLevel(level);
  if (!normalizedLevel) return '';
  return getSupportedReasoningLevelsForModel(model, useRopilotCredits, hasRopilotPlusAccess, isCodexFreeAccount).includes(normalizedLevel) ? normalizedLevel : '';
}

/**
 * @param {unknown} model
 * @param {boolean} [useRopilotCredits] resolved from app state by the caller
 * @param {unknown} [fallbackProvider] provider used when the model has no catalog entry
 * @returns {string}
 */
export function getDefaultReasoningLevelForModel(model, useRopilotCredits = false, fallbackProvider = '') {
  if (useRopilotCredits) {
    const creditsModel = normalizeSelectedModel(model);
    return creditsModel === 'gpt-6-luna' ? 'medium' : 'low';
  }

  const normalizedModel = normalizeSelectedModel(model);
  if (normalizedModel === 'gpt-6-astra' || normalizedModel === 'gpt-6-luna' || normalizedModel === 'gpt-5.6-terra') {
    return 'medium';
  }
  const provider = getProviderForModel(model) || fallbackProvider;
  if (normalizeModelProvider(provider) === 'codex') {
    return 'low';
  }
  return 'high';
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeCodexAccountPlanRaw(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * @param {unknown} model
 * @param {boolean} [useRopilotCredits] resolved from app state by the caller
 * @returns {boolean}
 */
export function supportsFastModeForModel(model, useRopilotCredits = false) {
  if (useRopilotCredits) {
    return false;
  }
  const config = getModelConfig(model);
  // Fast mode is never offered for Claude, whatever the catalog entry says.
  if (!config || normalizeModelProvider(config.provider) === 'claude') return false;
  return config.supportsFastMode === true;
}

/**
 * Managed Fast (Ropilot Credits + service_tier 'priority'). Only OpenAI
 * models that are both in the managed allow-list and flagged for Fast in the
 * catalog qualify; Anthropic and Ropilot-owned models never do.
 * @param {unknown} model
 * @returns {boolean}
 */
export function supportsRopilotCreditsFastModeForModel(model) {
  const config = getModelConfig(model);
  if (!config || config.supportsFastMode !== true) return false;
  if (normalizeModelProvider(config.provider) !== 'codex') return false;
  return ROPILOT_CREDITS_MODEL_VALUES.has(config.value)
    && ROPILOT_CREDITS_FAST_MODE_MODEL_VALUES.has(config.value);
}

/**
 * @param {unknown} value
 * @param {boolean} [hasRopilotPlusAccess] resolved from app state by the caller
 * @returns {string}
 */
export function normalizeRopilotCreditsRoutePriority(value, hasRopilotPlusAccess = false) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return hasRopilotPlusAccess && normalized === 'priority' ? 'priority' : 'economy';
}
