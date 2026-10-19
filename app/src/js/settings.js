import { showCreditReimbursement } from './credits/credit-reimbursement.js';
// Settings - handles settings modal and plugin management
import {
  clearApiKeyValidation,
  isApiKeyValidated,
  resolveEdgeUrlForApiKey,
  resolveSiteUrlForApiKey,
  validateApiKeyAtStartup
} from './api-validation.js';
import { installPluginWithGoFallback } from './plugin-install-fallback.js';
import { persistPluginBootstrapKey } from './plugin-bootstrap.js';
import { electronAPI } from './core/platform.js';
import { createLocalAPIWebSocket } from './local-api-auth.js';
import { isHideThinkingEnabled, setHideThinkingEnabled } from './thinking-block.js';
import * as modelCatalog from './models/model-catalog.js';

const STUDIO_TREE_ALLOWED_ROOT_SERVICES = new Set([
  'Workspace',
  'Players',
  'Lighting',
  'MaterialService',
  'ReplicatedFirst',
  'ReplicatedStorage',
  'ServerScriptService',
  'ServerStorage',
  'StarterGui',
  'StarterPack',
  'StarterPlayer',
  'Teams',
  'SoundService',
  'TextChatService',
  'TestService'
]);

const DEFAULT_SETTINGS_LOAD_TIMEOUT_MS = 0;

export class Settings {
  constructor(app) {
    this.app = app;
    this.app.edgeSettingsValues = this.app.edgeSettingsValues || {};
    this._startupTransparency = null;
    this._transparencyHandlerBound = false;
    this._discordRpcHandlerBound = false;
    this._hideThinkingHandlerBound = false;
    this._addRopilotMCPServerHandlerBound = false;
    this._codexPlaytestSubagentLabelSyncBound = false;
    this._autoPlaytestSyncInFlight = false;
    this._queuedAutoPlaytestValue = undefined;
    this._confirmedAutoPlaytestValue = typeof this.app.autoPlaytest === 'boolean'
      ? this.app.autoPlaytest
      : true;
    this._useRopilotCreditsSyncInFlight = false;
    this._queuedUseRopilotCreditsValue = undefined;
    this._confirmedUseRopilotCreditsValue = typeof this.app.useRopilotCredits === 'boolean'
      ? this.app.useRopilotCredits
      : false;
    this._inviteWidgetBound = false;
    this._inlineInvitePromoBound = false;
    this._inviteWidgetSummary = null;
    this._inviteWidgetApiKey = '';
    this._inviteWidgetFailedForKey = '';
    this._inviteWidgetPromise = null;
    this._inviteWidgetCopyResetTimer = null;
  }

  edgeUrlForApiKey(apiKey) {
    return resolveEdgeUrlForApiKey(apiKey, this.app.config?.edgeUrl);
  }

  siteUrlForApiKey(apiKey) {
    return resolveSiteUrlForApiKey(apiKey, this.app.config?.siteUrl);
  }

  applyAutoPlaytestSetting(value, source = 'edge') {
    if (typeof value !== 'boolean') return;
    if (source === 'edge' || source.startsWith('edge_')) {
      this._confirmedAutoPlaytestValue = value;
    } else if (source === 'ui_optimistic' || source === 'ui_revert') {
      this.app.hasAutoPlaytestPreference = true;
      localStorage.setItem('ropilot_auto_playtest_user_set', 'true');
    }
    this.app.autoPlaytest = value;
    localStorage.setItem('ropilot_auto_playtest', value);
    const checkbox = document.getElementById('auto-playtest-checkbox');
    if (checkbox) checkbox.checked = value;
    this.app.syncComposerFooterControls?.();
    console.log(`Applied autoPlaytest from ${source}:`, value);
  }

  applyUseRopilotCreditsSetting(value, source = 'edge') {
    if (typeof value !== 'boolean') return;
    if (value === false && this.app.shouldPreserveLocalRopilotCreditsModeDowngrade?.(source) === true) {
      console.warn('Ignoring stale use_ropilot_credits=false while preserving local managed credits mode.');
      this._confirmedUseRopilotCreditsValue = true;
      this.app.edgeSettingsValues = {
        ...(this.app.edgeSettingsValues || {}),
        use_ropilot_credits: true
      };
      return;
    }
    if (this.app.shouldPreserveLocalAiModeChoice?.(source, value) === true) {
      const localValue = this.app.aiModeUserChoiceValue === true;
      console.warn(`Ignoring stale use_ropilot_credits=${value} from ${source}; preserving recent user AI mode choice.`);
      this._confirmedUseRopilotCreditsValue = localValue;
      this.app.edgeSettingsValues = {
        ...(this.app.edgeSettingsValues || {}),
        use_ropilot_credits: localValue
      };
      return;
    }
    const wasEnabled = this.app.isUseRopilotCreditsEnabled?.() === true
      || this.app.useRopilotCredits === true;
    if (source === 'edge' || source.startsWith('edge_')) {
      this._confirmedUseRopilotCreditsValue = value;
    }
    this.app.useRopilotCredits = value;
    localStorage.setItem('ropilot_use_ropilot_credits', value ? 'true' : 'false');
    localStorage.setItem('ropilot_byo_subscription', value ? 'false' : 'true');
    if (value && !wasEnabled) {
      this.app.applyRopilotCreditsDefaultModel?.({ updateActiveChat: true });
    }
    const clearedManagedBalance = !value && this.app.accountCreditsBalance?.type === 'managed_ai_credits';
    if (!value && this.app.accountCreditsBalance?.type === 'managed_ai_credits') {
      this.app.accountCreditsBalance = null;
      this.app.actionsRemaining = null;
      this.app.actionsLimit = null;
      this.hideActionsDisplay();
    }
    this.app.refreshModelOptions?.().catch((err) => {
      console.warn('Failed to refresh models after use_ropilot_credits changed:', err);
    });
    this.app.syncComposerDropdown?.('composer-model-control');
    this.app.syncComposerFooterControls?.();
    if (this.app.latestAccountBalancePayload) {
      const latestPayloadMode = this.getAccountPayloadManagedMode(this.app.latestAccountBalancePayload);
      if (latestPayloadMode === null || latestPayloadMode === value) {
        this.applyAccountBalancePayload(this.app.latestAccountBalancePayload);
      } else if (!clearedManagedBalance) {
        this.updateActionsDisplay();
      }
    } else {
      if (!clearedManagedBalance) this.updateActionsDisplay();
    }
    if (value) {
      this.refreshManagedAiCredits().catch((err) => {
        console.warn('Failed to refresh managed AI credits after mode change:', err);
      });
    } else {
      this.refreshActions().catch((err) => {
        console.warn('Failed to refresh actions after mode change:', err);
      });
    }
    console.log(`Applied use_ropilot_credits from ${source}:`, value);
  }

  applySettingsValues(nextValues, source = 'edge') {
    if (!nextValues || typeof nextValues !== 'object') return;

    this.app.edgeSettingsValues = {
      ...(this.app.edgeSettingsValues || {}),
      ...nextValues
    };

    const hasAutoPlaytest = Object.prototype.hasOwnProperty.call(nextValues, 'autoPlaytest');
    const hasUseRopilotCredits = Object.prototype.hasOwnProperty.call(nextValues, 'use_ropilot_credits');
    const nextUseRopilotCredits = hasUseRopilotCredits
      ? nextValues.use_ropilot_credits === true
      : this.app.isUseRopilotCreditsEnabled?.() === true;

    if (hasUseRopilotCredits) {
      this.applyUseRopilotCreditsSetting(nextValues.use_ropilot_credits, source);
    }
    if (hasAutoPlaytest) {
      const defaultAutoPlaytestValue = this.app.getDefaultAutoPlaytestForMode?.(
        nextUseRopilotCredits,
        this.app.modelProvider
      );
      const isEdgeDefaultAutoPlaytest = source === 'edge_load'
        && nextValues.autoPlaytest === true
        && defaultAutoPlaytestValue === false
        && this.app.hasExplicitAutoPlaytestPreference?.() !== true;
      if (isEdgeDefaultAutoPlaytest) {
        this.app.applyDefaultAutoPlaytestForMode?.(nextUseRopilotCredits, this.app.modelProvider);
      } else {
        this.applyAutoPlaytestSetting(nextValues.autoPlaytest, source);
      }
    }
  }

  toFiniteNumber(value) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
  }

  getAccountPayloadManagedMode(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.use_managed_ai_credits === 'boolean') {
      return payload.use_managed_ai_credits;
    }
    const providerMode = typeof payload.ai_provider_mode === 'string'
      ? payload.ai_provider_mode.trim()
      : '';
    if (providerMode) {
      if (providerMode === 'managed' || providerMode === 'managed_ai_credits') return true;
      if (providerMode === 'bring_your_own') return false;
    }
    const accountBalance = payload.account_credits && typeof payload.account_credits === 'object'
      ? payload.account_credits
      : null;
    const accountBalanceType = typeof accountBalance?.balance_type === 'string'
      ? accountBalance.balance_type.trim()
      : '';
    if (accountBalanceType) return accountBalanceType === 'managed_ai_credits';
    return null;
  }

  normalizeAccountBalancePayload(payload, options = {}) {
    if (!payload || typeof payload !== 'object') return null;
    const managedBalance = payload.managed_ai_credits && typeof payload.managed_ai_credits === 'object'
      ? payload.managed_ai_credits
      : null;
    const actionBalance = payload.action_balance && typeof payload.action_balance === 'object'
      ? payload.action_balance
      : null;
    const accountBalance = payload.account_credits && typeof payload.account_credits === 'object'
      ? payload.account_credits
      : null;
    const accountBalanceType = typeof accountBalance?.balance_type === 'string'
      ? accountBalance.balance_type.trim()
      : '';
    const payloadManagedMode = typeof options.managedModeOverride === 'boolean'
      ? options.managedModeOverride
      : this.getAccountPayloadManagedMode(payload);
    const hasPayloadMode = payloadManagedMode !== null;
    const useManagedCredits = hasPayloadMode
      ? payloadManagedMode
      : this.app.useRopilotCredits === true;
    const actionAccountBalance = accountBalance && accountBalanceType !== 'managed_ai_credits'
      ? accountBalance
      : null;
    const balance = useManagedCredits
      ? (managedBalance || (accountBalanceType === 'managed_ai_credits' ? accountBalance : null) || payload.usage)
      : (actionBalance || actionAccountBalance || payload.usage);
    if (!balance || typeof balance !== 'object') {
      if (useManagedCredits) {
        const existingManagedBalance = this.app.accountCreditsBalance?.type === 'managed_ai_credits'
          ? this.app.accountCreditsBalance
          : null;
        return {
          type: 'managed_ai_credits',
          label: 'Ropilot Credits',
          remaining: existingManagedBalance?.remaining ?? 0,
          limit: null,
          hasMeter: false
        };
      }

      const legacyRemaining = this.toFiniteNumber(payload.actionsRemaining);
      const legacyLimit = this.toFiniteNumber(payload.actionsLimit ?? payload.creditsMax);
      const existingActionBalance = this.app.accountCreditsBalance?.type !== 'managed_ai_credits'
        ? this.app.accountCreditsBalance
        : null;
      if (legacyRemaining === null && legacyLimit === null) {
        return existingActionBalance || null;
      }
      return {
        type: 'ropilot_actions',
        label: 'Ropilot Actions',
        remaining: legacyRemaining ?? existingActionBalance?.remaining ?? 0,
        limit: legacyLimit ?? existingActionBalance?.limit ?? this.app.actionsLimit ?? 500,
        hasMeter: true
      };
    }

    const balanceType = typeof balance.balance_type === 'string' && balance.balance_type.trim()
      ? balance.balance_type.trim()
      : 'ropilot_actions';
    const label = typeof balance.label === 'string' && balance.label.trim()
      ? balance.label.trim()
      : (balanceType === 'managed_ai_credits' ? 'Ropilot Credits' : 'Ropilot Actions');
    const remaining = this.toFiniteNumber(balance.credits_remaining ?? balance.remaining ?? payload.actionsRemaining) ?? 0;
    const limit = this.toFiniteNumber(balance.monthly_allocation ?? balance.cap ?? payload.actionsLimit ?? payload.creditsMax);
    const hasMeter = balanceType !== 'managed_ai_credits' && limit !== null && limit > 0;

    return {
      type: balanceType,
      label,
      remaining,
      limit: hasMeter ? limit : null,
      hasMeter
    };
  }

  applyAccountBalancePayload(payload) {
    const previousBalance = this.app.accountCreditsBalance || null;
    const payloadManagedMode = this.getAccountPayloadManagedMode(payload);
    const preserveLocalMode = payloadManagedMode !== null
      && this.app.shouldPreserveLocalAiModeChoice?.('edge_balance', payloadManagedMode) === true;
    const normalized = this.normalizeAccountBalancePayload(
      payload,
      preserveLocalMode ? { managedModeOverride: this.app.aiModeUserChoiceValue === true } : {}
    );
    if (!normalized) return false;

    this.applyManagedAiAccessPayload(payload);
    if (preserveLocalMode) {
      const localValue = this.app.aiModeUserChoiceValue === true;
      console.warn(`Ignoring stale account payload AI mode (${payloadManagedMode}); preserving recent user choice (${localValue}).`);
      this._confirmedUseRopilotCreditsValue = localValue;
    } else if (payloadManagedMode !== null) {
      this._confirmedUseRopilotCreditsValue = payloadManagedMode;
      this.app.useRopilotCredits = payloadManagedMode;
      localStorage.setItem('ropilot_use_ropilot_credits', payloadManagedMode ? 'true' : 'false');
      localStorage.setItem('ropilot_byo_subscription', payloadManagedMode ? 'false' : 'true');
    }
    this.app.applyPendingRopilotCreditsDefaultMigration?.();
    this.app.latestAccountBalancePayload = payload;
    this.app.accountCreditsBalance = normalized;
    this.app.actionsRemaining = normalized.remaining;
    this.app.actionsLimit = normalized.limit ?? this.app.actionsLimit;
    this.app.userTier = payload.tier || this.app.userTier || 'free';
    this.app.bonusClaimed = payload.bonusClaimed || this.app.bonusClaimed || false;
    this.updateActionsDisplay();
    this.updateClaimBonusButton();
    this.app.handleAccountBalanceUpdated?.(previousBalance, normalized, payload);
    return true;
  }

  applyManagedAiAccessPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const managedAiCredits = payload.managed_ai_credits && typeof payload.managed_ai_credits === 'object'
      ? payload.managed_ai_credits
      : null;
    const access = payload.managed_ai_credit_access && typeof payload.managed_ai_credit_access === 'object'
      ? payload.managed_ai_credit_access
      : null;
    const acquisition = payload.acquisition && typeof payload.acquisition === 'object'
      ? payload.acquisition
      : null;
    const plusPayload = (
      payload.ropilot_plus ||
      payload.ropilotPlus ||
      access?.ropilot_plus ||
      access?.ropilotPlus ||
      managedAiCredits?.ropilot_plus ||
      managedAiCredits?.ropilotPlus ||
      null
    );
    const hasPlusPayload = !!plusPayload && typeof plusPayload === 'object';
    const plusActive = hasPlusPayload
      ? plusPayload.active === true
      : (payload.ropilot_plus_active === true || access?.ropilot_plus_active === true);
    const payloadLockedReasoningLevels = Array.isArray(payload.locked_reasoning_levels)
      ? payload.locked_reasoning_levels
      : (Array.isArray(access?.locked_reasoning_levels)
        ? access.locked_reasoning_levels
        : (Array.isArray(managedAiCredits?.locked_reasoning_levels)
          ? managedAiCredits.locked_reasoning_levels
          : null));
    const hasExplicitAnthropicAccessFlag = Object.prototype.hasOwnProperty.call(payload, 'has_rpcredits_anthropic_models_explicitly_allowed')
      || Object.prototype.hasOwnProperty.call(payload, 'anthropic_models_explicitly_allowed')
      || (!!access && (
        Object.prototype.hasOwnProperty.call(access, 'has_rpcredits_anthropic_models_explicitly_allowed')
        || Object.prototype.hasOwnProperty.call(access, 'anthropic_models_explicitly_allowed')
      ))
      || (!!managedAiCredits && (
        Object.prototype.hasOwnProperty.call(managedAiCredits, 'has_rpcredits_anthropic_models_explicitly_allowed')
        || Object.prototype.hasOwnProperty.call(managedAiCredits, 'anthropic_models_explicitly_allowed')
      ));
    const explicitAnthropicAccessAllowed = hasExplicitAnthropicAccessFlag
      && (
        payload.has_rpcredits_anthropic_models_explicitly_allowed === true
        || payload.anthropic_models_explicitly_allowed === true
        || access?.has_rpcredits_anthropic_models_explicitly_allowed === true
        || access?.anthropic_models_explicitly_allowed === true
        || managedAiCredits?.has_rpcredits_anthropic_models_explicitly_allowed === true
        || managedAiCredits?.anthropic_models_explicitly_allowed === true
      );
    const hasTopLevelFlag = Object.prototype.hasOwnProperty.call(payload, 'hide_anthropic_models')
      || Object.prototype.hasOwnProperty.call(payload, 'hideAnthropicModels');
    const hasAccessFlag = !!access
      && (
        Object.prototype.hasOwnProperty.call(access, 'hide_anthropic_models')
        || Object.prototype.hasOwnProperty.call(access, 'hideAnthropicModels')
      );
    const hasManagedCreditsFlag = !!managedAiCredits
      && (
        Object.prototype.hasOwnProperty.call(managedAiCredits, 'hide_anthropic_models')
        || Object.prototype.hasOwnProperty.call(managedAiCredits, 'hideAnthropicModels')
      );
    const hasNestedFlag = !!acquisition
      && (
        Object.prototype.hasOwnProperty.call(acquisition, 'hide_anthropic_models')
        || Object.prototype.hasOwnProperty.call(acquisition, 'hideAnthropicModels')
      );

    if (!hasTopLevelFlag && !hasAccessFlag && !hasManagedCreditsFlag && !hasNestedFlag && !hasPlusPayload && !payloadLockedReasoningLevels && !hasExplicitAnthropicAccessFlag) return false;

    const hideAnthropic = hasTopLevelFlag || hasAccessFlag || hasManagedCreditsFlag || hasNestedFlag
      ? (
        payload.hide_anthropic_models === true
        || payload.hideAnthropicModels === true
        || access?.hide_anthropic_models === true
        || access?.hideAnthropicModels === true
        || managedAiCredits?.hide_anthropic_models === true
        || managedAiCredits?.hideAnthropicModels === true
        || acquisition?.hide_anthropic_models === true
        || acquisition?.hideAnthropicModels === true
      )
      // No flag in the payload: Anthropic stays open regardless of Plus.
      : false;
    const effectiveHideAnthropic = explicitAnthropicAccessAllowed ? false : hideAnthropic;
    const lockedReasoningLevels = payloadLockedReasoningLevels
      ? payloadLockedReasoningLevels
        .map((level) => String(level || '').trim().toLowerCase())
        .filter(Boolean)
      : (plusActive ? [] : ['high', 'xhigh']);
    const previousHideAnthropic = this.app.hideAnthropicManagedCreditModels === true;
    const previousPlusActive = this.app.ropilotPlusActive === true;
    const previousLockedReasoningLevels = JSON.stringify(this.app.lockedRopilotCreditsReasoningLevels || []);
    this.app.managedAiCreditAccess = {
      hideAnthropicModels: effectiveHideAnthropic,
      hasRopilotCreditsAnthropicModelsExplicitlyAllowed: explicitAnthropicAccessAllowed,
      lockedReasoningLevels,
      ropilotPlus: hasPlusPayload ? plusPayload : { active: plusActive },
      acquisition
    };
    this.app.hideAnthropicManagedCreditModels = effectiveHideAnthropic;
    this.app.ropilotPlusActive = plusActive;
    this.app.lockedRopilotCreditsReasoningLevels = lockedReasoningLevels;
    this.app.hasAuthoritativeManagedAiAccess = true;
    localStorage.setItem('ropilot_hide_anthropic_managed_credit_models', effectiveHideAnthropic ? 'true' : 'false');
    localStorage.setItem('ropilot_plus_active', plusActive ? 'true' : 'false');
    localStorage.setItem('ropilot_locked_reasoning_levels', JSON.stringify(lockedReasoningLevels));

    const accessChanged = previousHideAnthropic !== effectiveHideAnthropic
      || previousPlusActive !== plusActive
      || previousLockedReasoningLevels !== JSON.stringify(lockedReasoningLevels);

    if (accessChanged) {
      this.app.refreshModelOptions?.().catch((err) => {
        console.warn('Failed to refresh models after managed AI access changed:', err);
      });
      this.app.refreshReasoningOptions?.();
      this.app.syncComposerDropdown?.('composer-model-control');
      this.app.syncComposerDropdown?.('composer-reasoning-control');
      this.app.syncComposerFooterControls?.();
    }

    return accessChanged;
  }

  applyManagedAiCreditsPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const remaining = this.toFiniteNumber(payload.credits_remaining ?? payload.remaining);
    if (remaining === null) return false;
    const previousManagedBalance = this.app.latestManagedAiCreditsBalance || null;
    const managedBalance = {
      type: 'managed_ai_credits',
      label: 'Ropilot Credits',
      remaining,
      limit: null,
      hasMeter: false
    };
    this.app.latestManagedAiCreditsBalance = managedBalance;
    this.app.latestManagedAiCreditsPayload = payload;
    this.applyManagedAiAccessPayload(payload);
    if (this.app.isUseRopilotCreditsEnabled?.() !== true) {
      this.app.applyPendingRopilotCreditsDefaultMigration?.();
      this.app.handleManagedAiCreditsBalanceUpdated?.(previousManagedBalance, managedBalance, payload);
      return true;
    }
    return this.applyAccountBalancePayload({
      account_credits: {
        balance_type: 'managed_ai_credits',
        label: 'Ropilot Credits',
        credits_remaining: remaining
      }
    });
  }

  syncActiveApiKeyToServerBridge() {
    if (!this.app.wsManager) return;
    const apiKey = this.app.getEffectiveApiKey() || '';

    this.app.wsManager.send({
      type: 'set_api_key',
      api_key: apiKey
    });
  }

  formatPluginLabel(hashOrVersion) {
    if (!hashOrVersion) return 'unknown';
    return String(hashOrVersion).slice(0, 16);
  }

  applyDiffTheme(theme) {
    document.body.dataset.diffTheme = theme || 'studio';
    localStorage.setItem('ropilot_diff_theme', theme || 'studio');
  }

  _bindThemePicker() {
    const cards = document.querySelectorAll('.theme-card[data-theme]');
    cards.forEach(card => {
      card.addEventListener('click', () => {
        cards.forEach(c => c.classList.remove('is-selected'));
        card.classList.add('is-selected');
        this.applyDiffTheme(card.dataset.theme);
      });
    });
  }

  syncCodexPlaytestSubagentSelect() {
    const select = document.getElementById('codex-playtest-subagent-select');
    if (!select) return;

    const options = this.app.getCodexPlaytestSubagentModelOptions?.() || [];
    const currentValue = this.app.getEffectiveCodexPlaytestSubagentModelPreference?.()
      || this.app.normalizeCodexPlaytestSubagentModelPreference?.(this.app.codexPlaytestSubagentModel)
      || 'auto';

    select.innerHTML = '';
    for (const optionData of options) {
      const option = document.createElement('option');
      option.value = optionData.value;
      option.textContent = optionData.label;
      select.appendChild(option);
    }
    if (
      currentValue !== modelCatalog.DEFAULT_CODEX_PLAYTEST_SUBAGENT_MODEL
      && !options.some((option) => option.value === currentValue)
    ) {
      const compatibilityModel = modelCatalog.getModelConfig(currentValue);
      if (compatibilityModel?.provider === 'codex') {
        const option = document.createElement('option');
        option.value = compatibilityModel.value;
        option.textContent = compatibilityModel.label;
        option.hidden = true;
        option.dataset.actionsHiddenCompatibility = 'true';
        select.appendChild(option);
      }
    }
    select.value = currentValue;
    this.syncCodexPlaytestSubagentSelectLabel();
    this.app.syncComposerDropdown?.('codex-playtest-subagent-control');
  }

  syncCodexPlaytestSubagentSelectLabel() {
    const select = document.getElementById('codex-playtest-subagent-select');
    const label = document.getElementById('codex-playtest-subagent-selected-label');
    if (!select || !label) return;

    const selectedOption = select.selectedOptions?.[0]
      || Array.from(select.options).find((option) => option.value === select.value)
      || select.options[0]
      || null;

    label.textContent = selectedOption?.textContent?.trim() || 'Auto';
  }

  bindCodexPlaytestSubagentSelectLabelSync() {
    if (this._codexPlaytestSubagentLabelSyncBound) return;
    const select = document.getElementById('codex-playtest-subagent-select');
    if (!select) return;

    select.addEventListener('change', () => {
      this.syncCodexPlaytestSubagentSelectLabel();
    });
    this._codexPlaytestSubagentLabelSyncBound = true;
  }

  async open() {
    document.getElementById('settings-modal').classList.remove('hidden');
    document.getElementById('input-api-key').value = this.app.apiKey;
    document.getElementById('input-custom-prompt').value = localStorage.getItem('ropilot_custom_prompt') || '';
    const taskNotificationsCheckbox = document.getElementById('task-completion-notifications-checkbox');
    if (taskNotificationsCheckbox) {
      taskNotificationsCheckbox.checked = this.app.taskNotificationManager?.enabled !== false;
    }
    const taskCompletionSoundCheckbox = document.getElementById('task-completion-sound-checkbox');
    if (taskCompletionSoundCheckbox) {
      taskCompletionSoundCheckbox.checked = this.app.taskNotificationManager?.soundEnabled !== false;
    }
    const hideThinkingCheckbox = document.getElementById('collapse-thinking-checkbox');
    if (hideThinkingCheckbox) {
      hideThinkingCheckbox.checked = isHideThinkingEnabled();
      this._bindHideThinkingHandler();
    }
    this.bindCodexPlaytestSubagentSelectLabelSync();
    this.syncCodexPlaytestSubagentSelect();
    document.getElementById('input-api-key').focus();

    // Load diff theme setting
    const currentTheme = localStorage.getItem('ropilot_diff_theme') || 'ropilot';
    const themeCards = document.querySelectorAll('.theme-card[data-theme]');
    themeCards.forEach(c => {
      c.classList.toggle('is-selected', c.dataset.theme === currentTheme);
    });
    this._bindThemePicker();

    // Load transparency setting
    const transparencyCheckbox = document.getElementById('transparency-checkbox');
    if (transparencyCheckbox) {
      const current = await electronAPI().getTransparencySetting?.() ?? false;
      transparencyCheckbox.checked = current;
      if (this._startupTransparency === null) {
        this._startupTransparency = current;
      }
      this._updateTransparencyRestartMsg(current);
      this._bindTransparencyHandler();
    }

    // Load Discord Rich Presence setting (on by default)
    const discordRpcCheckbox = document.getElementById('discord-rpc-checkbox');
    if (discordRpcCheckbox) {
      discordRpcCheckbox.checked = this.app.isDiscordRpcEnabled?.() !== false;
      this._bindDiscordRpcHandler();
    }

    const addRopilotMCPServerCheckbox = document.getElementById('add-ropilot-mcp-server-checkbox');
    if (addRopilotMCPServerCheckbox) {
      addRopilotMCPServerCheckbox.checked = this.app.isAddRopilotMCPServerEnabled?.() !== false;
      this._bindAddRopilotMCPServerHandler();
    }

    // Check plugin status
    this.updatePluginStatus();
    await this.updateAdvancedInputAction();
  }

  close() {
    this.app.closeComposerDropdowns?.();
    document.getElementById('settings-modal').classList.add('hidden');
    // Clear validation state when closing
    clearApiKeyValidation('input-api-key', 'api-key-error');
  }

  async updateAdvancedInputAction() {
    const group = document.getElementById('advanced-input-settings-group');
    if (!group) return;

    const isCompleted = this.app.setupFlow?.isAdvancedInputCompleted?.();
    let connected = false;

    try {
      connected = await this.app.setupFlow?.getAdvancedInputConnectionStatus?.();
    } catch (_) {
      connected = false;
    }

    // Show the Settings entry whenever the user has not completed the setup
    // yet, or when advanced input still is not connected/working.
    const shouldShow = !isCompleted || !connected;
    group.classList.toggle('hidden', !shouldShow);
  }

  openAdvancedInputSetup() {
    this.close();
    this.app.setupFlow?.showAdvancedInputSetup?.();
  }

  async updatePluginStatus() {
    const statusEl = document.getElementById('plugin-status');
    const btnEl = document.getElementById('btn-install-plugin');

    statusEl.className = 'plugin-status';
    statusEl.innerHTML = '<span class="plugin-status-text">Checking...</span>';

    try {
      const status = await electronAPI().getPluginStatus();

      if (status.installed) {
        const localLabel = this.formatPluginLabel(status.localHash || status.localVersion);
        const latestLabel = this.formatPluginLabel(status.latestHash || status.latestVersion);

        if (status.updateAvailable) {
          statusEl.classList.add('update-available');
          statusEl.innerHTML = `<span class="plugin-status-text">hash ${localLabel} installed (hash ${latestLabel} available)</span>`;
          btnEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>Update Plugin`;
        } else {
          statusEl.classList.add('installed');
          statusEl.innerHTML = `<span class="plugin-status-text">hash ${localLabel} installed</span>`;
          btnEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>Reinstall Plugin`;
        }
      } else {
        statusEl.classList.add('not-installed');
        statusEl.innerHTML = '<span class="plugin-status-text">Not installed</span>';
        btnEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>Install Plugin`;
      }
    } catch (err) {
      statusEl.classList.add('not-installed');
      statusEl.innerHTML = '<span class="plugin-status-text">Unable to check status</span>';
    }
  }

  async installPlugin() {
    const btnEl = document.getElementById('btn-install-plugin');
    const originalContent = btnEl.innerHTML;

    btnEl.classList.add('loading');
    btnEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 6v6l4 2"/>
    </svg>Installing...`;

    try {
      await persistPluginBootstrapKey(this.app.getEffectiveApiKey());
      const result = await installPluginWithGoFallback(this.app);

      if (result.success) {
        if (result.installer === 'go-fallback') {
          const statusEl = document.getElementById('plugin-status');
          if (statusEl) {
            statusEl.className = 'plugin-status installed';
            statusEl.innerHTML = '<span class="plugin-status-text">Installed</span>';
          }
          btnEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 6L9 17l-5-5"/>
          </svg>Installed`;
        } else {
          this.updatePluginStatus();
        }
      } else {
        btnEl.innerHTML = originalContent;
        this.app.showAppAlertModal('Plugin Install Failed', `Failed to install plugin: ${result.error}`, '#btn-install-plugin');
      }
    } catch (err) {
      btnEl.innerHTML = originalContent;
      this.app.showAppAlertModal('Plugin Install Failed', `Failed to install plugin: ${err.message}`, '#btn-install-plugin');
    } finally {
      btnEl.classList.remove('loading');
    }
  }

  async fetchStudioTree() {
    let localError = null;

    try {
      const tree = await this._fetchStudioTreeFromLocalProxy();
      this.app.noteStudioTreeUpdated(tree);
      return tree;
    } catch (err) {
      localError = err;
      console.warn('Failed to load studio tree from local proxy:', err);
    }

    const apiKey = this.app.getEffectiveApiKey();
    if (!apiKey) {
      throw localError || new Error('Please connect Roblox Studio or set your API key first.');
    }

    try {
      const tree = await this._fetchStudioTreeFromEdge(apiKey);
      this.app.noteStudioTreeUpdated(tree);
      return tree;
    } catch (edgeErr) {
      if (localError) {
        throw new Error(`Local Studio tree fetch failed: ${localError.message}. Edge fallback failed: ${edgeErr.message}`);
      }
      throw edgeErr;
    }
  }

  async _fetchStudioTreeFromLocalProxy() {
    const response = await this._callStudioProxyTool('search_game_tree', {
      max_depth: 10,
      head_limit: 1000
    });

    return this._parseLocalStudioTreeResponse(response);
  }

  async _fetchStudioTreeFromEdge(apiKey) {
    const response = await fetch(`${this.edgeUrlForApiKey(apiKey)}/studio-tree`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    const payload = await this._readStudioTreeResponse(response);
    if (!response.ok) {
      throw new Error(this._getStudioTreeErrorMessage(response, payload));
    }

    return payload && typeof payload === 'object' && payload.tree && typeof payload.tree === 'object'
      ? payload.tree
      : payload;
  }

  async _callStudioProxyTool(tool, args = {}) {
    const ws = await createLocalAPIWebSocket('ws://localhost:13469/proxy');
    return new Promise((resolve, reject) => {
      const requestId = `studio-tree-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      let settled = false;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        callback();
        try {
          ws.close();
        } catch (closeErr) {
          console.warn('Failed closing Studio proxy websocket:', closeErr);
        }
      };

      const timeoutId = window.setTimeout(() => {
        finish(() => reject(new Error('Timed out waiting for Studio tree from the local plugin connection.')));
      }, 15000);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ requestId, tool, arguments: args }));
      });

      ws.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch (err) {
          window.clearTimeout(timeoutId);
          finish(() => reject(new Error('Studio proxy returned invalid JSON.')));
          return;
        }

        if (message.requestId && message.requestId !== requestId) {
          return;
        }

        window.clearTimeout(timeoutId);
        if (message.error) {
          finish(() => reject(new Error(message.error.message || 'Studio proxy request failed.')));
          return;
        }

        finish(() => resolve(message.result));
      });

      ws.addEventListener('error', () => {
        window.clearTimeout(timeoutId);
        finish(() => reject(new Error('Could not connect to the local Studio proxy.')));
      });

      ws.addEventListener('close', () => {
        if (!settled) {
          window.clearTimeout(timeoutId);
          finish(() => reject(new Error('The local Studio proxy closed before returning a tree.')));
        }
      });
    });
  }

  async save() {
    const inputEl = document.getElementById('input-api-key');
    const newApiKey = inputEl.value.trim();

    // Don't save if key is invalid
    if (inputEl.classList.contains('input-invalid')) {
      inputEl.focus();
      return;
    }

    // Key must be validated (has input-valid class) to save
    const isValidated = inputEl.classList.contains('input-valid');

    const apiKeyChanged = newApiKey !== this.app.apiKey;

    // Save custom prompt
    const customPrompt = document.getElementById('input-custom-prompt').value;
    const durablePromptSaved = await this.app.projectManager?.syncManager?.saveGoSettings?.({ customPrompt });
    if (durablePromptSaved !== false) {
      localStorage.setItem('ropilot_custom_prompt', customPrompt);
      this.app.customPrompt = customPrompt;
    } else {
      console.warn('[STORAGE] Durable custom prompt save failed; keeping the previous prompt');
    }

    const codexPlaytestSubagentSelect = document.getElementById('codex-playtest-subagent-select');
    if (codexPlaytestSubagentSelect) {
      this.app.setCodexPlaytestSubagentModelPreference(codexPlaytestSubagentSelect.value);
    }

    const taskNotificationsCheckbox = document.getElementById('task-completion-notifications-checkbox');
    if (taskNotificationsCheckbox) {
      this.app.taskNotificationManager?.setEnabled(taskNotificationsCheckbox.checked);
    }
    const taskCompletionSoundCheckbox = document.getElementById('task-completion-sound-checkbox');
    if (taskCompletionSoundCheckbox) {
      this.app.taskNotificationManager?.setSoundEnabled(taskCompletionSoundCheckbox.checked);
    }

    const addRopilotMCPServerCheckbox = document.getElementById('add-ropilot-mcp-server-checkbox');
    if (addRopilotMCPServerCheckbox) {
      this.app.setAddRopilotMCPServerEnabled?.(addRopilotMCPServerCheckbox.checked);
    }

    this.app.apiKey = newApiKey;
    localStorage.setItem('ropilot_api_key', this.app.apiKey);
    if (this.app.apiKey) {
      persistPluginBootstrapKey(this.app.apiKey).catch((err) => {
        console.warn('[plugin-bootstrap] Failed to persist settings key:', err);
      });
    }
    this.close();

    // Remove any API key reminder in the chat since we now have a valid key
    if (isValidated && newApiKey) {
      const reminder = document.querySelector('.api-key-reminder');
      if (reminder) reminder.remove();
    }

    // Trigger re-validation (fire and forget) to update the global validation state
    if (newApiKey) {
      validateApiKeyAtStartup(newApiKey);
    }
    if (apiKeyChanged) {
      this.app.chatSync?.handleApiKeyChange();
    }

    // If API key changed, try to sync with server
    if (apiKeyChanged) {
      console.log('ChatSync: API key changed, syncing with server...');

      this.syncActiveApiKeyToServerBridge();

      if (this.app.apiKey) {
        // Load settings (including actions count) from edge
        this.loadFromEdge();
      }

      console.log('ChatSync: Skipping server-to-client chat merge after API key change');

      // Flush any pending changes
      await this.app.chatSync.flushPendingWork();
    }
  }

  // Sync auto-playtest setting to edge
  async syncAutoPlaytestToEdge() {
    const apiKey = this.app.getEffectiveApiKey();
    if (!apiKey) return;

    this._queuedAutoPlaytestValue = !!this.app.autoPlaytest;
    if (this._autoPlaytestSyncInFlight) return;

    this._autoPlaytestSyncInFlight = true;

    try {
      while (this._queuedAutoPlaytestValue !== undefined) {
        const nextValue = this._queuedAutoPlaytestValue;
        this._queuedAutoPlaytestValue = undefined;
        this.applySettingsValues({ autoPlaytest: nextValue }, 'ui_optimistic');

        try {
          const response = await fetch(`${this.edgeUrlForApiKey(apiKey)}/settings`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache'
            },
            body: JSON.stringify({
              key: 'autoPlaytest',
              value: nextValue
            })
          });
          if (!response.ok) {
            throw new Error(`Edge settings update failed (${response.status})`);
          }

          const payload = await response.json();
          const settingsValues = payload?.settingsValues || payload?.settings;
          const responseValue = settingsValues && typeof settingsValues === 'object'
            ? settingsValues.autoPlaytest
            : nextValue;

          if (typeof responseValue === 'boolean') {
            this._confirmedAutoPlaytestValue = responseValue;
          }

          if (settingsValues && typeof settingsValues === 'object') {
            if (this._queuedAutoPlaytestValue === undefined && this.app.autoPlaytest === nextValue) {
              this.applySettingsValues(settingsValues, 'edge_write_response');
            } else {
              this.app.edgeSettingsValues = {
                ...(this.app.edgeSettingsValues || {}),
                ...settingsValues
              };
            }
          }

          console.log('Settings synced to edge: autoPlaytest =', nextValue);
        } catch (err) {
          if (this._queuedAutoPlaytestValue !== undefined) {
            console.warn('Failed to sync stale autoPlaytest value; retrying latest selection:', err);
            continue;
          }

          if (typeof this._confirmedAutoPlaytestValue === 'boolean') {
            this.applySettingsValues({ autoPlaytest: this._confirmedAutoPlaytestValue }, 'ui_revert');
          }
          console.warn('Failed to sync settings to edge:', err);
        }
      }
    } finally {
      this._autoPlaytestSyncInFlight = false;
    }
  }

  async syncUseRopilotCreditsToEdge(nextValue, options = {}) {
    const apiKey = this.app.getEffectiveApiKey();
    if (!apiKey) return;
    const preserveLocalOnFailure = options?.preserveLocalOnFailure === true;
    const preserveLocalOnConflict = options?.preserveLocalOnConflict === true || preserveLocalOnFailure;

    this._queuedUseRopilotCreditsValue = !!nextValue;
    if (this._useRopilotCreditsSyncInFlight) return;

    this._useRopilotCreditsSyncInFlight = true;

    try {
      while (this._queuedUseRopilotCreditsValue !== undefined) {
        const valueToSync = this._queuedUseRopilotCreditsValue;
        this._queuedUseRopilotCreditsValue = undefined;
        this.applySettingsValues({
          use_ropilot_credits: valueToSync,
          autoPlaytest: false
        }, 'ui_optimistic');

        try {
          const response = await fetch(`${this.edgeUrlForApiKey(apiKey)}/settings`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache'
            },
            body: JSON.stringify({
              use_ropilot_credits: valueToSync,
              autoPlaytest: false
            })
          });
          if (!response.ok) {
            throw new Error(`Edge settings update failed (${response.status})`);
          }

          const payload = await response.json();
          const settingsValues = payload?.settingsValues || payload?.settings;
          const responseValue = settingsValues && typeof settingsValues === 'object'
            ? settingsValues.use_ropilot_credits
            : valueToSync;

          if (typeof responseValue === 'boolean') {
            this._confirmedUseRopilotCreditsValue = responseValue;
          }

          if (settingsValues && typeof settingsValues === 'object') {
            const safeSettingsValues = { ...settingsValues };
            if (
              preserveLocalOnConflict
              && typeof safeSettingsValues.use_ropilot_credits === 'boolean'
              && safeSettingsValues.use_ropilot_credits !== valueToSync
            ) {
              console.warn('Ignoring stale use_ropilot_credits sync response; preserving local managed credits mode.');
              safeSettingsValues.use_ropilot_credits = valueToSync;
              safeSettingsValues.autoPlaytest = false;
              this._confirmedUseRopilotCreditsValue = valueToSync;
            }
            if (this._queuedUseRopilotCreditsValue === undefined && this.app.useRopilotCredits === valueToSync) {
              this.applySettingsValues(safeSettingsValues, 'edge_write_response');
            } else {
              this.app.edgeSettingsValues = {
                ...(this.app.edgeSettingsValues || {}),
                ...safeSettingsValues
              };
            }
          }

          console.log('Settings synced to edge: use_ropilot_credits =', valueToSync);
        } catch (err) {
          if (this._queuedUseRopilotCreditsValue !== undefined) {
            console.warn('Failed to sync stale use_ropilot_credits value; retrying latest selection:', err);
            continue;
          }

          if (preserveLocalOnFailure) {
            this._confirmedUseRopilotCreditsValue = valueToSync;
            this.applySettingsValues({
              use_ropilot_credits: valueToSync,
              autoPlaytest: false
            }, 'ui_preserve');
          } else if (typeof this._confirmedUseRopilotCreditsValue === 'boolean') {
            this.applySettingsValues({ use_ropilot_credits: this._confirmedUseRopilotCreditsValue }, 'ui_revert');
          }
          console.warn('Failed to sync use_ropilot_credits to edge:', err);
        }
      }
    } finally {
      this._useRopilotCreditsSyncInFlight = false;
    }
  }

  // Load settings from edge
  async loadFromEdge(options = {}) {
    const apiKey = this.app.getEffectiveApiKey();
    if (!apiKey) return;

    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(0, Number(options.timeoutMs))
      : DEFAULT_SETTINGS_LOAD_TIMEOUT_MS;
    const refreshManagedCredits = options.refreshManagedCredits !== false;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    };
    let controller = null;
    let timeoutId = null;
    if (timeoutMs > 0 && typeof AbortController !== 'undefined') {
      controller = new AbortController();
      fetchOptions.signal = controller.signal;
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    try {
      const response = await fetch(`${this.edgeUrlForApiKey(apiKey)}/settings`, fetchOptions);
      if (response.ok) {
        const settings = await response.json();
        // Establish Plus/managed-model entitlements before a mode change can
        // migrate and clamp the previous model's reasoning preference.
        this.applyManagedAiAccessPayload(settings);
        const settingsValues = settings?.settingsValues || settings?.settings;
        if (settingsValues && typeof settingsValues === 'object') {
          this.applySettingsValues(settingsValues, 'edge_load');
          console.log('Loaded settings from edge: autoPlaytest =', this.app.autoPlaytest);
        }
        const accountBalanceApplied = this.applyAccountBalancePayload(settings);
        if (accountBalanceApplied) {
          console.log('Loaded account balance from edge:', this.app.accountCreditsBalance);
        } else {
          this.app.applyPendingRopilotCreditsDefaultMigration?.();
        }
        if (refreshManagedCredits && this.app.isUseRopilotCreditsEnabled?.() === true) {
          await this.refreshManagedAiCredits();
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        console.warn(`Timed out loading settings from edge after ${timeoutMs}ms`);
      } else {
        console.warn('Failed to load settings from edge:', err);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  // Update the actions counter display
  updateActionsDisplay() {
    const container = document.getElementById('actions-counter');
    const label = document.getElementById('actions-label');
    const barFill = document.getElementById('actions-bar-fill');
    const bar = barFill?.closest('.actions-bar');
    const text = document.getElementById('actions-text');

    if (!container || !barFill || !text) return;

    const balance = this.app.accountCreditsBalance || {
      type: 'ropilot_actions',
      label: 'Ropilot Actions',
      remaining: this.app.actionsRemaining || 0,
      limit: this.app.actionsLimit || 500,
      hasMeter: true
    };
    const remaining = balance.remaining || 0;
    const limit = balance.limit || this.app.actionsLimit || 500;
    const remainingPercent = limit > 0 ? Math.min((remaining / limit) * 100, 100) : 0;

    // Show the counter
    container.classList.remove('hidden');
    const isManagedCreditsMode = balance.type === 'managed_ai_credits'
      && (this.app.isUseRopilotCreditsEnabled?.() === true || this.app.useRopilotCredits === true);
    container.classList.toggle('is-managed-credits', isManagedCreditsMode);
    this.updateInviteWidgetVisibility(isManagedCreditsMode);
    if (label) label.textContent = balance.label || 'Ropilot Actions';

    const formatNumber = (n, options = {}) => {
      const number = this.toFiniteNumber(n) ?? 0;
      return number.toLocaleString(undefined, options);
    };

    if (isManagedCreditsMode || balance.hasMeter === false) {
      if (bar) bar.classList.add('hidden');
      barFill.style.width = '0%';
      barFill.classList.remove('warning', 'critical');
      text.textContent = formatNumber(remaining, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
      return;
    }

    if (bar) bar.classList.remove('hidden');

    // Update bar width (shows remaining)
    barFill.style.width = `${remainingPercent}%`;

    // Update bar color based on remaining percentage
    barFill.classList.remove('warning', 'critical');
    if (remainingPercent <= 10) {
      barFill.classList.add('critical');
    } else if (remainingPercent <= 25) {
      barFill.classList.add('warning');
    }

    // State that the numerator is available Actions, not usage.
    text.textContent = `${formatNumber(remaining, { maximumFractionDigits: 0 })}/${formatNumber(limit, { maximumFractionDigits: 0 })} left`;
  }

  hideActionsDisplay() {
    document.getElementById('actions-counter')?.classList.add('hidden');
    document.getElementById('claim-bonus-btn')?.classList.add('hidden');
  }

  // Optimistically deduct a just-charged cost from the displayed balance so
  // the counter moves the moment the charge event streams in, instead of
  // seconds later when the post-turn balance refresh returns. The refresh
  // overwrites with the authoritative server value, so drift self-corrects.
  applyOptimisticCharge(cost) {
    const charge = this.toFiniteNumber(cost);
    if (!charge || charge <= 0) return;

    let changed = false;
    const balance = this.app.accountCreditsBalance;
    const balanceRemaining = this.toFiniteNumber(balance?.remaining);
    if (balance && balanceRemaining !== null) {
      balance.remaining = Math.max(0, balanceRemaining - charge);
      changed = true;
    }
    const actionsRemaining = this.toFiniteNumber(this.app.actionsRemaining);
    if (actionsRemaining !== null) {
      this.app.actionsRemaining = Math.max(0, actionsRemaining - charge);
      changed = true;
    }
    if (changed) this.updateActionsDisplay();
  }

  // Refresh actions count from edge (called after successful message)
  async refreshActions() {
    if (this.app.isUseRopilotCreditsEnabled?.() === true) {
      return this.refreshManagedAiCredits();
    }

    const apiKey = this.app.getEffectiveApiKey();
    if (!apiKey) return null;

    try {
      const response = await fetch(`${this.edgeUrlForApiKey(apiKey)}/settings`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });
      if (response.ok) {
        const settings = await response.json();
        this.applyAccountBalancePayload(settings);
        return settings;
      }
    } catch (err) {
      // Silently fail - not critical
    }
    return null;
  }

  async refreshManagedAiCredits() {
    // free build: this asked Ropilot for a credit balance and cached the
    // answer. Nothing here is metered, so there is no balance to hold and no
    // reason to contact them. null is what callers already expect from a
    // failed request.
    return null;
  }

  getInviteWidgetElements() {
    // free build: stub — the invite widget markup was deleted in pass two
    return null;
  }

  getInlineInvitePromoElements() {
    // free build: stub — the inline promo markup was deleted in pass two
    return [];
  }

  bindInviteWidgetCopy() {
    // free build: stub — nothing to bind a copy handler to
    return undefined;
  }

  toPositiveInteger(value, fallback = 0) {
    const number = this.toFiniteNumber(value);
    if (number === null || number < 0) return fallback;
    return Math.floor(number);
  }

  formatInviteCreditAmount(value, fallback) {
    const number = this.toFiniteNumber(value) ?? fallback;
    if (!Number.isFinite(number)) return String(fallback);
    return Number.isInteger(number)
      ? number.toLocaleString()
      : number.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  getInviteSummaryDetails(summary) {
    const maxInvites = Math.max(1, this.toPositiveInteger(summary?.max_invites, 3));
    const remainingInvites = Math.max(0, this.toPositiveInteger(summary?.remaining_invites, maxInvites));
    const invitedCount = Math.max(
      0,
      Math.min(maxInvites, this.toPositiveInteger(summary?.invited_count, maxInvites - remainingInvites))
    );
    return {
      maxInvites,
      remainingInvites,
      invitedCount,
      referrerCredits: this.formatInviteCreditAmount(summary?.referrer_reward_credits, 10),
      inviteeCredits: this.formatInviteCreditAmount(summary?.invitee_reward_credits ?? summary?.reward_credits, 5)
    };
  }

  hideInlineInvitePromos() {
    for (const els of this.getInlineInvitePromoElements()) {
      els.widget.classList.add('hidden');
      if (els.button) els.button.disabled = true;
    }
  }

  setInviteWidgetLoading() {
    // free build: stub — the Referral Program widget does not exist here
    return undefined;
  }

  setInviteWidgetUnavailable(message = 'Invite link unavailable right now.') {
    const els = this.getInviteWidgetElements();
    if (els) {
      if (els.badge) els.badge.textContent = '0 / 3';
      if (els.sub) els.sub.textContent = message;
      if (els.button) els.button.disabled = true;
      if (els.buttonLabel) els.buttonLabel.textContent = 'Link unavailable';
    }
    this.hideInlineInvitePromos();
  }

  renderInviteWidgetSummary(summary) {
    const els = this.getInviteWidgetElements();
    const details = this.getInviteSummaryDetails(summary);
    const isManagedCreditsMode = this.app.isUseRopilotCreditsEnabled?.() === true || this.app.useRopilotCredits === true;

    if (els) {
      if (!isManagedCreditsMode || details.invitedCount >= details.maxInvites || details.remainingInvites <= 0) {
        els.widget.classList.add('hidden');
        if (els.button) els.button.disabled = true;
      } else {
        els.widget.classList.remove('hidden');
        if (els.badge) els.badge.textContent = `${details.invitedCount} / ${details.maxInvites}`;
        if (els.sub) {
          els.sub.innerHTML = `You get <b>${details.referrerCredits} credits</b>, your friend gets <b>${details.inviteeCredits}</b> &mdash; for up to <b>${details.maxInvites} friends</b>.`;
        }
        if (els.button) els.button.disabled = !summary?.referral_url;
        if (els.buttonLabel) els.buttonLabel.textContent = summary?.referral_url ? 'Copy link' : 'Link unavailable';
      }
    }

    this.renderInlineInvitePromoSummary(summary, details);
  }

  renderInlineInvitePromoSummary(summary, details = this.getInviteSummaryDetails(summary)) {
    const shouldShow = Boolean(summary?.referral_url)
      && details.invitedCount < details.maxInvites
      && details.remainingInvites > 0;

    for (const els of this.getInlineInvitePromoElements()) {
      if (!shouldShow) {
        els.widget.classList.add('hidden');
        if (els.button) els.button.disabled = true;
        continue;
      }

      els.widget.classList.remove('hidden');
      if (els.badge) els.badge.textContent = `${details.invitedCount} / ${details.maxInvites}`;
      if (els.sub) {
        els.sub.innerHTML = `<b>${details.referrerCredits} credits</b> for you, <b>${details.inviteeCredits}</b> for them`;
      }
      if (els.button) els.button.disabled = false;
      if (els.buttonLabel) els.buttonLabel.textContent = 'Copy link';
    }
  }

  updateInviteWidgetVisibility(isManagedCreditsMode) {
    const els = this.getInviteWidgetElements();
    const hasInlinePromo = this.getInlineInvitePromoElements().length > 0;
    if (!els && !hasInlinePromo) return;
    this.bindInviteWidgetCopy();

    if (!isManagedCreditsMode) {
      els?.widget.classList.add('hidden');
    } else {
      els?.widget.classList.remove('hidden');
    }

    if (this._inviteWidgetSummary) {
      this.renderInviteWidgetSummary(this._inviteWidgetSummary);
      return;
    }
    if (!this._inviteWidgetPromise) {
      this.setInviteWidgetLoading();
      this.refreshInviteWidgetSummary().catch((err) => {
        console.warn('Failed to load invite widget:', err);
      });
    }
  }

  async refreshInviteWidgetSummary(options = {}) {
    // free build: stub — GET /api/ropilot-referral is not contacted by this build
    return null;
  }

  async copyInviteWidgetLink(sourceButton = null) {
    // free build: stub — there is no referral link to copy
    return undefined;
  }

  async copyTextToClipboard(text) {
    const clipboard = globalThis.navigator?.clipboard || globalThis.window?.navigator?.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand?.('copy');
    textarea.remove();
    if (!copied) throw new Error('Clipboard copy unavailable.');
  }

  // Update the claim bonus button visibility (sidebar)
  updateClaimBonusButton() {
    const sidebarBtn = document.getElementById('claim-bonus-btn');

    const balance = this.app.accountCreditsBalance;
    const hasKnownActionBalance = !!balance && balance.type !== 'managed_ai_credits';
    const remaining = hasKnownActionBalance
      ? (this.toFiniteNumber(balance.remaining) ?? 0)
      : (this.toFiniteNumber(this.app.actionsRemaining) ?? 0);
    const limit = hasKnownActionBalance
      ? (this.toFiniteNumber(balance.limit) ?? this.toFiniteNumber(this.app.actionsLimit) ?? 500)
      : (this.toFiniteNumber(this.app.actionsLimit) ?? 500);
    const tier = this.app.userTier || 'free';
    const alreadyClaimed = this.app.bonusClaimed || false;
    const usingManagedCredits = this.app.isUseRopilotCreditsEnabled?.() === true
      || this.app.useRopilotCredits === true;

    // Show button only for FREE tier users with <=50 actions remaining who haven't claimed
    const isFreeUser = tier === 'free' || limit === 500 || limit === 250;
    const isLowOnActions = remaining <= 50;
    const canClaim = hasKnownActionBalance && !usingManagedCredits && isFreeUser && isLowOnActions && !alreadyClaimed;

    if (sidebarBtn) {
      if (canClaim) {
        sidebarBtn.classList.remove('hidden');
      } else {
        sidebarBtn.classList.add('hidden');
      }
    }
  }

  // Show the claim bonus modal
  showClaimBonusModal() {
    const modal = document.getElementById('claim-bonus-modal');
    if (modal) modal.classList.remove('hidden');
  }

  // Hide the claim bonus modal
  hideClaimBonusModal() {
    const modal = document.getElementById('claim-bonus-modal');
    if (modal) modal.classList.add('hidden');
  }

  // Claim the free bonus actions (called from modal button)
  async claimBonus() {
    const btn = document.getElementById('modal-claim-bonus-btn');
    if (!btn) return;

    const apiKey = this.app.getEffectiveApiKey();
    if (!apiKey) {
      this.app.showAppAlertModal('API Key Required', 'Please set your API key first.');
      return;
    }

    // Disable button and show loading state
    btn.disabled = true;
    const originalContent = btn.innerHTML;
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px; margin-right: 6px; animation: spin 1s linear infinite;">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" stroke-linecap="round"/>
      </svg>
      Claiming...
    `;

    try {
      const response = await fetch(`${this.edgeUrlForApiKey(apiKey)}/claim-bonus`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      const result = await response.json();

      if (response.ok && result.success) {
        // Update local state
        this.app.actionsRemaining = result.actionsRemaining;
        this.app.bonusClaimed = true;
        this.updateActionsDisplay();

        // Hide modal and all claim buttons/banners
        this.hideClaimBonusModal();
        this.updateClaimBonusButton();

        // Show success feedback
        this.showClaimSuccess(result.added || 500);
      } else {
        // Show error
        const errorMsg = result.error || 'Failed to claim bonus';
        if (result.alreadyClaimed) {
          this.app.showAppAlertModal('Bonus Already Claimed', 'You have already claimed your free bonus actions.');
          this.app.bonusClaimed = true;
          this.hideClaimBonusModal();
          this.updateClaimBonusButton();
        } else {
          this.app.showAppAlertModal('Claim Failed', errorMsg, '#modal-claim-bonus-btn');
          btn.innerHTML = originalContent;
          btn.disabled = false;
        }
      }
    } catch (err) {
      console.error('Failed to claim bonus:', err);
      this.app.showAppAlertModal('Claim Failed', 'Failed to claim bonus. Please try again.', '#modal-claim-bonus-btn');
      btn.innerHTML = originalContent;
      btn.disabled = false;
    }
  }

  // Bind the transparency checkbox change handler (only once)
  _bindTransparencyHandler() {
    if (this._transparencyHandlerBound) return;
    const checkbox = document.getElementById('transparency-checkbox');
    if (!checkbox) return;
    checkbox.addEventListener('change', async () => {
      const requestedValue = checkbox.checked;
      const persistedValue = await electronAPI().setTransparencySetting?.(requestedValue);
      const effectiveValue = typeof persistedValue === 'boolean' ? persistedValue : requestedValue;
      checkbox.checked = effectiveValue;
      this._updateTransparencyRestartMsg(effectiveValue);
    });
    this._transparencyHandlerBound = true;
  }

  // Bind the Discord Rich Presence checkbox change handler (only once)
  _bindDiscordRpcHandler() {
    if (this._discordRpcHandlerBound) return;
    const checkbox = document.getElementById('discord-rpc-checkbox');
    if (!checkbox) return;
    checkbox.addEventListener('change', () => {
      this.app.setDiscordRpcEnabled?.(checkbox.checked);
    });
    this._discordRpcHandlerBound = true;
  }

  // Render-time hide: flipping the toggle re-renders the active chat so
  // thinking blocks disappear (or come back) immediately.
  _bindHideThinkingHandler() {
    if (this._hideThinkingHandlerBound) return;
    const checkbox = document.getElementById('collapse-thinking-checkbox');
    if (!checkbox) return;
    checkbox.addEventListener('change', () => {
      setHideThinkingEnabled(checkbox.checked);
      this.app.messageRenderer?.render?.({ resetChunk: true });
    });
    this._hideThinkingHandlerBound = true;
  }

  _bindAddRopilotMCPServerHandler() {
    if (this._addRopilotMCPServerHandlerBound) return;
    const checkbox = document.getElementById('add-ropilot-mcp-server-checkbox');
    if (!checkbox) return;
    checkbox.addEventListener('change', () => {
      this.app.setAddRopilotMCPServerEnabled?.(checkbox.checked);
    });
    this._addRopilotMCPServerHandlerBound = true;
  }

  // Show or hide the restart warning based on whether the value differs from startup
  _updateTransparencyRestartMsg(currentValue) {
    const msg = document.getElementById('transparency-restart-msg');
    if (!msg) return;
    if (this._startupTransparency !== null && currentValue !== this._startupTransparency) {
      msg.classList.remove('hidden');
    } else {
      msg.classList.add('hidden');
    }
  }

  // Show success animation/feedback after claiming
  showClaimSuccess(amount) {
    const container = document.getElementById('actions-counter');
    if (!container) return;

    // Add a brief glow effect
    container.style.transition = 'box-shadow 0.3s ease';
    container.style.boxShadow = '0 0 12px rgba(16, 185, 129, 0.5)';

    setTimeout(() => {
      container.style.boxShadow = '';
    }, 1500);
  }

  formatStudioTree(tree) {
    if (Array.isArray(tree)) {
      return this._formatLocalStudioTreeList(tree);
    }

    if (!tree || typeof tree !== 'object') {
      return 'No Roblox game tree data was returned.';
    }

    const filteredTree = this._filterStructuredStudioTreeNode(tree, 0);
    if (!filteredTree) {
      return 'No Roblox game tree data was returned.';
    }

    const lines = [
      this._formatStudioTreeLabel(filteredTree),
      filteredTree.path ? `path: ${filteredTree.path}` : null,
      Number.isFinite(filteredTree.instanceCount) ? `instances: ${filteredTree.instanceCount.toLocaleString()}` : null,
      typeof filteredTree.truncated === 'boolean' ? `truncated: ${filteredTree.truncated ? 'yes' : 'no'}` : null,
      Array.isArray(filteredTree.excludedServices) && filteredTree.excludedServices.length > 0
        ? `excluded services: ${filteredTree.excludedServices.join(', ')}`
        : null,
      ''
    ].filter(line => line !== null);

    const childLines = this._formatStudioTreeChildren(Array.isArray(filteredTree.children) ? filteredTree.children : [], '');
    if (childLines.length === 0) {
      lines.push('(no children returned)');
    } else {
      lines.push(...childLines);
    }

    return lines.join('\n');
  }

  _formatStudioTreeChildren(children, prefix) {
    return children.flatMap((child, index) => {
      const isLast = index === children.length - 1;
      const branch = isLast ? '`- ' : '|- ';
      const childPrefix = `${prefix}${isLast ? '   ' : '|  '}`;
      const lines = [`${prefix}${branch}${this._formatStudioTreeLabel(child)}`];
      const nestedChildren = Array.isArray(child?.children) ? child.children : [];

      if (nestedChildren.length > 0) {
        lines.push(...this._formatStudioTreeChildren(nestedChildren, childPrefix));
      }

      return lines;
    });
  }

  _formatStudioTreeLabel(node) {
    const name = typeof node?.name === 'string' && node.name.trim().length > 0
      ? node.name.trim()
      : typeof node?.path === 'string' && node.path.trim().length > 0
        ? node.path.trim()
        : 'Unknown';

    return node?.className ? `${name} [${node.className}]` : name;
  }

  _formatLocalStudioTreeList(entries) {
    if (entries.length === 0) {
      return 'No Roblox game tree nodes were returned.';
    }

    const noteLines = typeof entries._note === 'string' && entries._note.trim().length > 0
      ? entries._note.trim().split('\n')
      : [];
    const rootNodes = [];
    const nodesByPath = new Map();

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      const rawPath = typeof entry.fullPath === 'string' && entry.fullPath.trim().length > 0
        ? entry.fullPath.trim()
        : typeof entry.path === 'string' && entry.path.trim().length > 0
          ? entry.path.trim()
          : typeof entry.name === 'string' && entry.name.trim().length > 0
            ? entry.name.trim()
            : null;
      if (!rawPath) continue;

      const node = {
        name: typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : rawPath.split('.').pop(),
        className: typeof entry.className === 'string' ? entry.className : '',
        fullPath: rawPath,
        childSummary: typeof entry.childSummary === 'string' ? entry.childSummary : '',
        unexploredChildCount: Number.isFinite(entry.unexploredChildCount) ? entry.unexploredChildCount : null,
        children: []
      };

      nodesByPath.set(rawPath, node);
    }

    const sortedPaths = Array.from(nodesByPath.keys()).sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b));
    for (const fullPath of sortedPaths) {
      const node = nodesByPath.get(fullPath);
      const lastDot = fullPath.lastIndexOf('.');
      const parentPath = lastDot === -1 ? '' : fullPath.slice(0, lastDot);
      const parent = parentPath ? nodesByPath.get(parentPath) : null;

      if (parent) {
        parent.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }

    const lines = [];
    if (noteLines.length > 0) {
      lines.push(...noteLines, '');
    }

    const filteredRootNodes = rootNodes
      .map(node => this._filterLocalStudioTreeNode(node, node.className === 'DataModel' ? 0 : 1))
      .filter(Boolean)
      .sort((a, b) => a.fullPath.localeCompare(b.fullPath));

    for (const node of filteredRootNodes) {
      lines.push(...this._formatLocalTreeNodes([node], ''));
    }

    return lines.join('\n');
  }

  _filterStructuredStudioTreeNode(node, depth) {
    if (!node || typeof node !== 'object') {
      return null;
    }

    if (depth === 1 && !this._isAllowedStudioRootService(node)) {
      return null;
    }

    const filteredChildren = Array.isArray(node.children)
      ? node.children
        .map(child => this._filterStructuredStudioTreeNode(child, depth + 1))
        .filter(Boolean)
      : [];

    return {
      ...node,
      children: filteredChildren
    };
  }

  _filterLocalStudioTreeNode(node, depth) {
    if (!node || typeof node !== 'object') {
      return null;
    }

    if (depth === 1 && !this._isAllowedStudioRootService(node)) {
      return null;
    }

    const filteredChildren = Array.isArray(node.children)
      ? node.children
        .map(child => this._filterLocalStudioTreeNode(child, depth + 1))
        .filter(Boolean)
      : [];

    return {
      ...node,
      children: filteredChildren
    };
  }

  _isAllowedStudioRootService(node) {
    const candidates = [node?.name, node?.path, node?.fullPath]
      .filter(value => typeof value === 'string' && value.trim().length > 0)
      .map(value => value.trim().split('.').pop())
      .map(value => value.replace(/^game\./, '').trim());

    return candidates.some(value => STUDIO_TREE_ALLOWED_ROOT_SERVICES.has(value));
  }

  _formatLocalTreeNodes(nodes, prefix) {
    const sortedNodes = [...nodes].sort((a, b) => a.fullPath.localeCompare(b.fullPath));
    return sortedNodes.flatMap((node, index) => {
      const isLast = index === sortedNodes.length - 1;
      const branch = prefix ? (isLast ? '`- ' : '|- ') : '';
      const childIndent = `${prefix}${isLast ? '   ' : '|  '}`;
      const lines = [`${prefix}${branch}${this._formatLocalTreeLabel(node)}`];

      if (node.childSummary) {
        lines.push(`${childIndent}summary: ${node.childSummary}`);
      }
      if (Number.isFinite(node.unexploredChildCount) && node.unexploredChildCount > 0) {
        lines.push(`${childIndent}unexplored: ${node.unexploredChildCount}`);
      }

      if (node.children.length > 0) {
        lines.push(...this._formatLocalTreeNodes(node.children, `${prefix}${isLast ? '   ' : '|  '}`));
      }

      return lines;
    });
  }

  _formatLocalTreeLabel(node) {
    const label = node.className ? `${node.name} [${node.className}]` : node.name;
    return node.fullPath ? `${label}` : label;
  }

  _parseLocalStudioTreeResponse(result) {
    const text = this._extractProxyTextResult(result);
    if (!text) {
      throw new Error('Local Studio proxy returned an empty tree response.');
    }

    const lines = text.trim().split('\n');
    const jsonStartIndex = lines.findIndex(line => line.trim().startsWith('[') || line.trim().startsWith('{'));
    if (jsonStartIndex === -1) {
      throw new Error(text.trim());
    }

    const note = lines.slice(0, jsonStartIndex).join('\n').trim();
    const jsonText = lines.slice(jsonStartIndex).join('\n').trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error('Local Studio tree response could not be parsed.');
    }

    if (Array.isArray(parsed) && note) {
      parsed._note = note;
    }

    return parsed;
  }

  _extractProxyTextResult(result) {
    if (typeof result === 'string') {
      return result;
    }

    if (!result || typeof result !== 'object') {
      return '';
    }

    if (typeof result.text === 'string') {
      return result.text;
    }

    if (Array.isArray(result.content)) {
      return result.content
        .map(item => typeof item?.text === 'string' ? item.text : '')
        .filter(Boolean)
        .join('\n');
    }

    return '';
  }

  async _readStudioTreeResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }

    return response.text();
  }

  _getStudioTreeErrorMessage(response, payload) {
    if (payload && typeof payload === 'object') {
      if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
        return payload.error;
      }
      if (typeof payload.message === 'string' && payload.message.trim().length > 0) {
        return payload.message;
      }
    }

    if (typeof payload === 'string' && payload.trim().length > 0) {
      return payload.trim();
    }

    return `Failed to load the Roblox game tree (${response.status}).`;
  }
}
