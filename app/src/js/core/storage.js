// @ts-check
// Typed localStorage access with a registry of every shared ropilot_* key.
//
// The registry exists so key strings stop being scattered literals; the
// strings themselves are load-bearing user data and must never change.
// Boolean values are stored as the strings 'true'/'false' (legacy encoding)
// — getBool/set preserve that exactly.
//
// Keys used by exactly one module (chat-sync pending queue, task
// notification toggles, chat-sync-commit pending store) stay as local
// constants in their module; this registry covers keys read or written from
// more than one place, or from app.js.

export const KEYS = Object.freeze({
  // Identity / session
  apiKey: 'ropilot_api_key',
  activeChat: 'ropilot_active_chat',
  activeProject: 'ropilot_active_project',
  projects: 'ropilot_projects',
  chats: 'ropilot_chats',
  promptStash: 'ropilot_prompt_stash',

  // Model & provider selection
  modelProvider: 'ropilot_model_provider',
  selectedModel: 'ropilot_selected_model',
  useRopilotCredits: 'ropilot_use_ropilot_credits',
  creditsRoutePriority: 'ropilot_credits_route_priority',
  codexFastMode: 'ropilot_codex_fast_mode',
  ropilotCreditsFastMode: 'ropilot_credits_fast_mode',
  codexPlaytestSubagentModel: 'ropilot_codex_playtest_subagent_model',
  lockedReasoningLevels: 'ropilot_locked_reasoning_levels',
  hideAnthropicManagedCreditModels: 'ropilot_hide_anthropic_managed_credit_models',
  aiModeUserChoice: 'ropilot_ai_mode_user_choice',
  byoSubscription: 'ropilot_byo_subscription',
  plusActive: 'ropilot_plus_active',

  // Behavior toggles
  autoPlaytest: 'ropilot_auto_playtest',
  autoPlaytestUserSet: 'ropilot_auto_playtest_user_set',
  discordRpcEnabled: 'ropilot_discord_rpc_enabled',
  addMcpServer: 'ropilot_add_mcp_server',
  customPrompt: 'ropilot_custom_prompt',
  diffTheme: 'ropilot_diff_theme',
  sidebarCollapsed: 'ropilot_sidebar_collapsed',

  // Setup / onboarding
  onboardingComplete: 'ropilot_onboarding_complete',
  setupProvider: 'ropilot_setup_provider',
  pluginSetupSeen: 'ropilot_plugin_setup_seen',
  advancedInputSetupSeen: 'ropilot_advanced_input_setup_seen',
  providerAcknowledged: 'ropilot_provider_acknowledged',
  anthropicAcknowledged: 'ropilot_anthropic_acknowledged',
  studioRestartPromptSeen: 'ropilot_studio_restart_prompt_seen',

  // Announcements
  fable51AnnouncementShown: 'ropilot_fable51_announcement_shown',
  fable5AnnouncementShown: 'ropilot_fable5_announcement_shown',
  opus5AnnouncementShown: 'ropilot_opus5_announcement_shown',
  gpt55AnnouncementShown: 'ropilot_gpt55_announcement_shown',
  opus47AnnouncementShown: 'ropilot_opus47_announcement_shown',
  opus48AnnouncementShown: 'ropilot_opus48_announcement_shown',

  // Free-offer flow
  freeOfferId: 'ropilot_free_offer_id',
  freeOfferPayload: 'ropilot_free_offer_payload',
  freeOfferPending: 'ropilot_free_offer_pending',
  freeOfferClaimed: 'ropilot_free_offer_claimed',
  freeOfferClaimedAt: 'ropilot_free_offer_claimed_at',
  freeOfferClaimId: 'ropilot_free_offer_claim_id',
  freeOfferCheckedAt: 'ropilot_free_offer_checked_at',
  freeOfferClaimUnavailableAt: 'ropilot_free_offer_claim_unavailable_at',
  freeOfferClaimUnavailableReason: 'ropilot_free_offer_claim_unavailable_reason',
});

/**
 * Per-model reasoning-level key. `credits: true` selects the Ropilot
 * Credits variant of the preference.
 * @param {string} model
 * @param {{credits?: boolean}} [opts]
 * @returns {string}
 */
export function reasoningLevelKey(model, { credits = false } = {}) {
  return credits
    ? `ropilot_reasoning_level_credits_${model}`
    : `ropilot_reasoning_level_${model}`;
}

/**
 * Raw read with the exact localStorage.getItem contract (null when absent).
 * Use this when migrating code whose behavior depends on distinguishing
 * "unset" from any stored value.
 * @param {string} key
 * @returns {string|null}
 */
export function getRaw(key) {
  return localStorage.getItem(key);
}

/**
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
export function getString(key, fallback = '') {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value;
}

/**
 * Reads the legacy 'true'/'false' string encoding.
 * @param {string} key
 * @param {boolean} [fallback] returned when the key is unset
 * @returns {boolean}
 */
export function getBool(key, fallback = false) {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value === 'true';
}

/**
 * @param {string} key
 * @param {any} [fallback] returned when unset or unparsable
 * @returns {any}
 */
export function getJSON(key, fallback = null) {
  const value = localStorage.getItem(key);
  if (value === null) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

/**
 * Stores strings as-is and everything else via String() — booleans keep the
 * legacy 'true'/'false' encoding. Objects belong in setJSON.
 * @param {string} key
 * @param {string|number|boolean} value
 */
export function set(key, value) {
  localStorage.setItem(key, typeof value === 'string' ? value : String(value));
}

/**
 * @param {string} key
 * @param {any} value
 */
export function setJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

/**
 * @param {string} key
 */
export function remove(key) {
  localStorage.removeItem(key);
}
