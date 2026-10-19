// @ts-check
// Composer footer: model/reasoning option lists and the footer control row
// (model name + badge, reasoning label, fast-mode + credit-priority +
// auto-playtest pills). Extracted from app.js; holds the app reference and
// reaches back through it for model-selection state and policy helpers.
import { electronAPI } from '../core/platform.js';
import * as modelCatalog from '../models/model-catalog.js';
import { isModelAvailableOnPlatform } from '../models/release-availability.js';
import { getProviderMarkSvg } from '../ui/provider-marks.js';

export class ComposerFooter {
  constructor(app) {
    this.app = app;
  }

  async getModelAuthMap() {
    let claudeAuthenticated = false;
    let codexAuthenticated = false;
    let hasCodexAccountPlan = false;

    try {
      const status = await electronAPI().getClaudeCliStatus?.();
      claudeAuthenticated = !!status?.authenticated;
    } catch (err) {
      console.warn('Failed to fetch Claude auth status for models:', err);
    }

    try {
      const status = await electronAPI().getCodexCliStatus?.();
      codexAuthenticated = !!status?.authenticated;
      hasCodexAccountPlan = this.app.updateCodexAccountPlanFromStatus(status) || hasCodexAccountPlan;
    } catch (err) {
      console.warn('Failed to fetch Codex auth status for models:', err);
    }

    try {
      const status = await this.app.setupFlow?.getGoSetup?.('/setup/codex-account/status');
      if (status?.success && status?.found) {
        hasCodexAccountPlan = this.app.updateCodexAccountPlanFromStatus(status) || hasCodexAccountPlan;
      }
    } catch (err) {
      console.warn('Failed to fetch Codex account status for models:', err);
    }

    if (!codexAuthenticated && !hasCodexAccountPlan) {
      this.app.clearCodexAccountPlan();
    }

    return {
      claude: claudeAuthenticated,
      codex: codexAuthenticated
    };
  }

  async refreshModelOptions() {
    const modelSelect = document.getElementById('model-select');
    if (!modelSelect) return;

    const currentProvider = this.app.normalizeModelProvider(this.app.modelProvider);
    const useRopilotCredits = this.app.isUseRopilotCreditsEnabled();
    const authMap = useRopilotCredits ? null : await this.getModelAuthMap();
    let allowedModels = useRopilotCredits
      ? this.app.getRopilotCreditsModels()
      : modelCatalog.MODEL_CATALOG.filter((model) => (
        isModelAvailableOnPlatform(model.value) &&
        authMap[this.app.normalizeModelProvider(model.provider)] === true &&
        !modelCatalog.ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES.has(model.value)
      ));
    if (!useRopilotCredits && this.app.isCodexFreeAccount()) {
      allowedModels = allowedModels.filter((model) => {
        const provider = this.app.normalizeModelProvider(model.provider);
        return provider !== 'codex' || modelCatalog.CODEX_FREE_ALLOWED_MODELS.has(model.value);
      });
    }

    const selectedModel = this.app.normalizeSelectedModel(this.app.selectedModel);
    const selectedHiddenModel = !useRopilotCredits
      && modelCatalog.ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES.has(selectedModel)
      ? modelCatalog.getModelConfig(selectedModel)
      : null;
    const canPreserveSelectedHiddenModel = selectedHiddenModel
      && authMap?.[this.app.normalizeModelProvider(selectedHiddenModel.provider)] === true;

    modelSelect.innerHTML = '';

    if (allowedModels.length === 0 && !canPreserveSelectedHiddenModel) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Unavailable';
      option.disabled = true;
      option.selected = true;
      modelSelect.appendChild(option);
      modelSelect.dataset.emptyProviderState = 'true';
      if (!useRopilotCredits) {
        const addMoreOption = document.createElement('option');
        addMoreOption.value = 'add_more_models';
        addMoreOption.textContent = 'Add more models';
        modelSelect.appendChild(addMoreOption);
      }
      modelSelect.disabled = false;
      this.syncComposerFooterControls();
      return;
    }

    delete modelSelect.dataset.emptyProviderState;
    modelSelect.disabled = false;
    for (const model of allowedModels) {
      const option = document.createElement('option');
      option.value = model.value;
      option.textContent = model.label;
      modelSelect.appendChild(option);
    }
    if (canPreserveSelectedHiddenModel) {
      const option = document.createElement('option');
      option.value = selectedHiddenModel.value;
      option.textContent = selectedHiddenModel.label;
      option.hidden = true;
      option.dataset.actionsHiddenCompatibility = 'true';
      modelSelect.appendChild(option);
    }

    if (!useRopilotCredits) {
      const addMoreOption = document.createElement('option');
      addMoreOption.value = 'add_more_models';
      addMoreOption.textContent = 'Add more models';
      modelSelect.appendChild(addMoreOption);
    }

    const selectedModelIsAllowed = allowedModels.some((model) => model.value === selectedModel)
      || canPreserveSelectedHiddenModel;
    if (!selectedModelIsAllowed) {
      const preferredDefault = useRopilotCredits
        ? this.app.getDefaultRopilotCreditsModel()
        : this.app.getDefaultModelForProvider(currentProvider);
      this.app.selectedModel = allowedModels.some((model) => model.value === preferredDefault)
        ? preferredDefault
        : allowedModels[0].value;
    }
    const providerForSelectedModel = this.app.getProviderForModel(this.app.selectedModel) || currentProvider;
    this.app.modelProvider = providerForSelectedModel;
    this.refreshReasoningOptions();
    modelSelect.value = this.app.selectedModel;
    this.syncComposerFooterControls();
  }

  refreshReasoningOptions() {
    const reasoningSelect = document.getElementById('reasoning-level-select');
    const codexFastToggle = document.getElementById('codex-fast-toggle');
    const codexFastCheckbox = document.getElementById('codex-fast-mode-checkbox');
    if (!reasoningSelect) return;

    const selectedModel = this.app.coerceModelForProvider(this.app.modelProvider, this.app.selectedModel);
    const provider = this.app.normalizeModelProvider(this.app.modelProvider);
    const modelConfig = this.app.getModelConfig(selectedModel);
    const useRopilotCredits = this.app.isUseRopilotCreditsEnabled?.() === true;
    const supportedReasoningLevels = this.app.getSupportedReasoningLevelsForModel(selectedModel, { useRopilotCredits });
    const visibleReasoningLevels = this.app.getVisibleReasoningLevelsForModel(selectedModel, { useRopilotCredits });
    const level = this.app.getReasoningLevelForModel(selectedModel, { useRopilotCredits });
    reasoningSelect.innerHTML = '';
    for (const reasoningLevel of visibleReasoningLevels) {
      const locked = this.app.isRopilotCreditsReasoningLevelLocked(reasoningLevel);
      const option = document.createElement('option');
      option.value = reasoningLevel;
      option.textContent = modelCatalog.REASONING_LEVEL_LABELS[reasoningLevel] || reasoningLevel;
      option.disabled = locked;
      if (locked) {
        option.dataset.locked = 'true';
        option.dataset.lockLabel = 'Upgrade to Plus';
      }
      reasoningSelect.appendChild(option);
    }
    this.app.setReasoningLevelForModel(selectedModel, level, { useRopilotCredits });
    reasoningSelect.value = level;
    reasoningSelect.disabled = supportedReasoningLevels.length <= 1;
    if (provider === 'codex') {
      reasoningSelect.title = `Controls ${modelConfig?.label || 'Codex'} reasoning effort budget.`;
    } else if (provider === 'ropilot') {
      reasoningSelect.title = `Controls ${modelConfig?.label || 'Ropilot'} reasoning effort.`;
    } else {
      reasoningSelect.title = 'Controls Claude Code effort level.';
    }
    const supportsFastMode = this.app.supportsFastModeForModel(selectedModel);
    if (codexFastToggle) {
      codexFastToggle.classList.toggle('hidden', !supportsFastMode);
      if (!supportsFastMode) {
        this.app.hideCodexFastInfoTip();
      }
    }
    if (codexFastCheckbox) {
      codexFastCheckbox.checked = this.app.shouldUseFastModeForModel(selectedModel);
      codexFastCheckbox.disabled = !supportsFastMode;
      codexFastCheckbox.title = supportsFastMode
        ? 'Enable Codex fast mode via service_tier="fast".'
        : `Fast mode is unavailable for ${modelConfig?.label || 'this model'}.`;
    }
    this.syncComposerFooterControls();
  }

  // Synara's trigger glyph: the provider mark at full strength (Anthropic's
  // mark keeps its own colour, OpenAI's follows the text).
  getComposerProviderIconSvg(provider = this.app.modelProvider) {
    const normalizedProvider = this.app.normalizeModelProvider(provider);
    const key = normalizedProvider === 'ropilot' || normalizedProvider === 'codex' ? normalizedProvider : 'claude';
    return `<span class="composer-provider-logo composer-provider-logo-${key}">${getProviderMarkSvg(key)}</span>`;
  }

  getComposerModelDisplayLabel(modelValue = this.app.selectedModel) {
    const normalizedModel = this.app.normalizeSelectedModel(modelValue);
    const displayLabels = {
      'gpt-6-astra': 'GPT-6 Astra',
      'gpt-6.1-sol': 'GPT-6.1 Sol',
      'gpt-6-sol': 'GPT-6 Sol',
      'gpt-6-luna': 'GPT-6 Luna',
      'gpt-5.6-sol': 'GPT-5.6 Sol',
      'gpt-5.6-terra': 'GPT-5.6 Terra',
      'gpt-5.6-luna': 'GPT-5.6 Luna',
      'gpt-5.5': 'GPT-5.5',
      'gpt-5.4': 'GPT-5.4',
      'gpt-5.4-mini': 'GPT-5.4 mini',
      'gpt-5.3-codex': 'GPT-5.3 Codex',
      'gpt-5.2-codex': 'GPT-5.2 Codex',
      'gpt-5.3-codex-spark': 'GPT-5.3 Spark',
      'ropilot-blaze': 'Ropilot Blaze',
      'claude-opus-5-5[1m]': 'Claude Opus 5.5',
      'claude-fable-5-1[1m]': 'Claude Fable 5.1',
      'claude-sonnet-5-5': 'Claude Sonnet 5.5'
    };
    return displayLabels[normalizedModel] || modelValue || 'Model';
  }

  // Managed Fast pill (Ropilot Credits only): bolt + "Fast". The 2.5x cost
  // lives in the hover/focus popover and the accessible label, shown before
  // enabling and while enabled.
  getRopilotCreditsFastModeCopy(modelLabel, enabled, modelValue = '') {
    const multiplier = this.app.getRopilotCreditsFastModeCostMultiplier?.() ?? modelCatalog.ROPILOT_CREDITS_FAST_MODE_COST_MULTIPLIER;
    const multiplierLabel = `${multiplier}×`;
    // Luna Medium is free on the Standard route, so "2.5× the normal rate"
    // would read as 2.5× nothing. Say plainly that Fast is always paid.
    const isLuna = this.app.normalizeSelectedModel(modelValue) === 'gpt-6-luna';
    const cost = isLuna
      ? `${multiplierLabel} ${modelLabel}'s paid credit rate per request`
      : `${multiplierLabel} the normal ${modelLabel} credits per request`;
    const note = isLuna
      ? 'Fast is never free, even on Medium. Same model at priority; typically ~1.5× faster, not guaranteed.'
      : 'Same model, served at priority. Typically ~1.5× faster, but speed varies per request.';
    return {
      multiplierLabel,
      title: enabled ? 'Fast mode is on' : 'Fast mode is off',
      cost,
      note,
      ariaLabel: `Fast mode ${enabled ? 'on' : 'off'}. Costs ${cost}.`
    };
  }

  syncRopilotCreditsFastControl() {
    const wrap = document.getElementById('composer-credits-fast');
    const control = document.getElementById('composer-credits-fast-control');
    if (!wrap || !control) return;
    const separator = document.getElementById('composer-credits-fast-separator');
    const tipTitle = document.getElementById('composer-credits-fast-tip-title');
    const tipCost = document.getElementById('composer-credits-fast-tip-cost');
    const tipNote = document.getElementById('composer-credits-fast-tip-note');

    const selectedModel = this.app.coerceModelForProvider(this.app.modelProvider, this.app.selectedModel);
    const supported = this.app.supportsRopilotCreditsFastModeForModel?.(selectedModel) === true;
    const enabled = supported && this.app.shouldUseRopilotCreditsFastModeForModel?.(selectedModel) === true;

    wrap.classList.toggle('hidden', !supported);
    separator?.classList.toggle('hidden', !supported);
    if (!supported) {
      control.classList.remove('is-active');
      control.classList.add('is-inactive');
      control.setAttribute('aria-pressed', 'false');
      return;
    }

    const copy = this.getRopilotCreditsFastModeCopy(this.getComposerModelDisplayLabel(selectedModel), enabled, selectedModel);
    control.classList.toggle('is-active', enabled);
    control.classList.toggle('is-inactive', !enabled);
    control.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    control.setAttribute('aria-label', copy.ariaLabel);
    // No native title: the popover below is the tooltip.
    control.removeAttribute('title');
    if (tipTitle) tipTitle.textContent = copy.title;
    if (tipCost) tipCost.textContent = copy.cost;
    if (tipNote) tipNote.textContent = copy.note;
    // Extras-panel row: Synara's dimmed secondary carries the price.
    const secondary = document.getElementById('composer-credits-fast-secondary');
    if (secondary) secondary.textContent = `${copy.multiplierLabel} credits`;
  }

  syncComposerFooterControls() {
    const modelSelect = document.getElementById('model-select');
    const modelLabel = document.getElementById('composer-model-label');
    const modelIcon = document.getElementById('composer-model-icon');
    const modelControl = document.getElementById('composer-model-control');
    const reasoningSelect = document.getElementById('reasoning-level-select');
    const reasoningLabel = document.getElementById('composer-reasoning-label');
    const reasoningControl = document.getElementById('composer-reasoning-control');
    const fastModeControl = document.getElementById('composer-fast-mode-control');
    const fastModeLabel = document.getElementById('composer-fast-mode-label');
    const attachFastSeparator = document.getElementById('composer-attach-fast-separator');
    const fastModeSeparator = document.getElementById('composer-fast-mode-separator');
    const creditPrioritySelect = document.getElementById('ropilot-credit-priority-select');
    const creditPriorityLabel = document.getElementById('composer-credit-priority-label');
    const creditPriorityControl = document.getElementById('composer-credit-priority-control');
    const creditPrioritySeparator = document.getElementById('composer-credit-priority-separator');
    const autoPlaytestLabel = document.getElementById('composer-auto-playtest-label');
    const autoPlaytestControl = document.getElementById('composer-auto-playtest-control');
    const useRopilotCredits = this.app.isUseRopilotCreditsEnabled?.() === true;

    if (modelSelect && modelLabel) {
      const hasNoProviderModels = modelSelect.dataset.emptyProviderState === 'true';
      const selectedModelValue = hasNoProviderModels
        ? ''
        : (modelSelect.value || this.app.selectedModel);
      const isLowQualityModel = this.app.isLowQualityRopilotCreditsModel(selectedModelValue);
      const isRecommendedModel = this.app.isRecommendedRopilotCreditsModel(selectedModelValue);
      const modelName = document.createElement('span');
      modelName.className = 'composer-model-name';
      modelName.textContent = hasNoProviderModels
        ? 'Unavailable'
        : this.getComposerModelDisplayLabel(selectedModelValue);
      modelLabel.replaceChildren(modelName);
      const modelBadge = hasNoProviderModels ? null : this.app.getRopilotCreditsModelBadgeMeta(selectedModelValue);
      if (modelBadge && modelBadge.kind !== 'recommended') {
        const badge = document.createElement('span');
        badge.className = `composer-model-badge composer-model-badge-${modelBadge.kind}`;
        badge.textContent = modelBadge.label;
        modelLabel.appendChild(badge);
      }
      if (modelIcon) {
        modelIcon.innerHTML = this.getComposerProviderIconSvg(this.app.modelProvider);
      }
      modelControl?.classList.toggle('is-disabled', !!modelSelect.disabled);
      modelControl?.classList.toggle('has-empty-provider-state', hasNoProviderModels);
      modelControl?.classList.toggle('has-low-quality-warning', isLowQualityModel);
      modelControl?.classList.toggle('has-recommended-badge', isRecommendedModel);
    }

    if (reasoningSelect && reasoningLabel) {
      const selectedModel = this.app.coerceModelForProvider(this.app.modelProvider, this.app.selectedModel);
      const level = this.app.getReasoningLevelForModel(selectedModel);
      const supportsFastMode = this.app.supportsFastModeForModel(selectedModel);
      reasoningLabel.textContent = modelCatalog.REASONING_LEVEL_LABELS[level] || level || 'Reasoning';
      reasoningControl?.classList.toggle('is-disabled', !!reasoningSelect.disabled);

      const effortLabel = document.getElementById('composer-model-effort');
      if (effortLabel) {
        // Synara's muted effort beside the model name; models without an
        // effort ladder show none.
        const hasLadder = !reasoningSelect.disabled
          && Array.from(reasoningSelect.options).filter((option) => option.value).length > 1;
        effortLabel.textContent = hasLadder ? (modelCatalog.REASONING_LEVEL_LABELS[level] || level || '') : '';
      }
      const fastBadge = document.getElementById('composer-model-fast-badge');
      if (fastBadge) {
        const anyFastOn = (supportsFastMode && this.app.shouldUseFastModeForModel(selectedModel))
          || this.app.shouldUseRopilotCreditsFastModeForModel?.(selectedModel) === true;
        fastBadge.classList.toggle('hidden', !anyFastOn);
      }

      if (fastModeControl && fastModeLabel) {
        const fastModeEnabled = supportsFastMode && this.app.shouldUseFastModeForModel(selectedModel);
        fastModeLabel.textContent = 'Fast mode';
        const fastModeSecondary = document.getElementById('composer-fast-mode-secondary');
        if (fastModeSecondary) fastModeSecondary.textContent = `Turn fast mode ${fastModeEnabled ? 'off' : 'on'}`;
        fastModeControl.classList.toggle('hidden', !supportsFastMode);
        attachFastSeparator?.classList.toggle('hidden', !supportsFastMode);
        fastModeSeparator?.classList.toggle('hidden', !supportsFastMode);
        fastModeControl.classList.toggle('is-active', fastModeEnabled);
        fastModeControl.classList.toggle('is-inactive', !fastModeEnabled);
        fastModeControl.setAttribute('aria-pressed', fastModeEnabled ? 'true' : 'false');
        // Extras-panel row: the dimmed secondary already says on/off.
        fastModeControl.removeAttribute('title');
      }
    }

    this.syncRopilotCreditsFastControl();

    if (creditPriorityControl && creditPrioritySelect && creditPriorityLabel) {
      const canUsePriority = useRopilotCredits && this.app.hasRopilotPlusAccess();
      const routePriority = this.app.getRopilotCreditsRoutePriority();
      const routeLabel = modelCatalog.ROPILOT_CREDITS_ROUTE_PRIORITY_LABELS[routePriority] || modelCatalog.ROPILOT_CREDITS_ROUTE_PRIORITY_LABELS.economy;
      creditPrioritySelect.value = routePriority;
      creditPrioritySelect.disabled = !canUsePriority;
      creditPriorityLabel.textContent = routeLabel;
      creditPriorityControl.classList.toggle('hidden', !canUsePriority);
      creditPrioritySeparator?.classList.toggle('hidden', !canUsePriority);
      creditPriorityControl.classList.toggle('is-disabled', !canUsePriority);
      creditPriorityControl.setAttribute(
        'title',
        canUsePriority ? 'Select the route priority.' : 'Priority routing is not available in this build.'
      );
    }

    if (autoPlaytestLabel) {
      autoPlaytestLabel.textContent = 'Auto Playtest';
      autoPlaytestControl?.classList.toggle('is-active', !!this.app.autoPlaytest);
      autoPlaytestControl?.classList.toggle('is-inactive', !this.app.autoPlaytest);
      autoPlaytestControl?.setAttribute('aria-pressed', this.app.autoPlaytest ? 'true' : 'false');
      autoPlaytestControl?.setAttribute('title', this.app.autoPlaytest ? 'Auto playtest is on' : 'Auto playtest is off');
    }

    this.app.syncComposerDropdowns();
    this.app.maybeSendDiscordPresence();
  }
}
