// @ts-check
// Composer custom dropdowns: the model/reasoning/credit-priority/subagent
// menus that replace the native selects. The model menu is Synara's composer
// model picker (ComposerModelPicker.tsx): a Ropilot Credits / own-subscription
// segmented control, a tab strip (Starred + one icon tab per provider), a
// search row, single-line model rows with Ctrl+N chips and a star toggle, and
// the effort slider card that drives #reasoning-level-select. Extracted from
// app.js; holds the app reference and reaches back through it for state and
// policy.
import { escapeHtml } from '../utils.js';
import * as modelCatalog from '../models/model-catalog.js';
import { getProviderMarkSvg } from '../ui/provider-marks.js';

export function triangleSign(p1, p2, p3) {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}

export function pointInTriangle(pt, a, b, c) {
  const d1 = triangleSign(pt, a, b);
  const d2 = triangleSign(pt, b, c);
  const d3 = triangleSign(pt, c, a);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

// How long a diagonal pointer journey toward the open submenu may cross other
// provider rows before the submenu switches anyway.
const PROVIDER_SWITCH_INTENT_DELAY_MS = 300;

// Synara's picker: the first tab lists starred presets.
export const STARRED_TAB = '__starred';
export const STARRED_MODELS_STORAGE_KEY = 'ropilot_starred_models_v1';
// mod+1…9 address the first nine visible rows (Synara MODEL_PICKER_SHORTCUT_ROW_LIMIT).
export const MODEL_PICKER_SHORTCUT_ROW_LIMIT = 9;

// Tabler icons (MIT), 24px grid.
const ICON = {
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/></svg>',
  starFilled: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.243 7.34l-6.38 .925l-.113 .023a1 1 0 0 0 -.44 1.684l4.622 4.499l-1.09 6.355l-.013 .11a1 1 0 0 0 1.464 .944l5.706 -3l5.693 3l.1 .046a1 1 0 0 0 1.352 -1.1l-1.091 -6.355l4.624 -4.5l.078 -.085a1 1 0 0 0 -.633 -1.62l-6.38 -.926l-2.852 -5.78a1 1 0 0 0 -1.794 0l-2.853 5.78z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5l0 14"/><path d="M5 12l14 0"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.05 11a8 8 0 1 1 .5 4m-.5 5v-5h5"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"/></svg>',
  boltFilled: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2a1 1 0 0 1 .993 .883l.007 .117v6h5a1 1 0 0 1 .868 1.497l-.06 .091l-8 11c-.563 .774 -1.785 .37 -1.805 -.56l-.003 -.028v-6h-5a1 1 0 0 1 -.868 -1.497l.06 -.091l8 -11a1 1 0 0 1 .808 -.412z"/></svg>',
  coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14c0 1.657 2.686 3 6 3s6 -1.343 6 -3s-2.686 -3 -6 -3s-6 1.343 -6 3z"/><path d="M9 14v4c0 1.656 2.686 3 6 3s6 -1.344 6 -3v-4"/><path d="M3 6c0 1.072 1.144 2.062 3 2.598s4.144 .536 6 0c1.856 -.536 3 -1.526 3 -2.598c0 -1.072 -1.144 -2.062 -3 -2.598s-4.144 -.536 -6 0c-1.856 .536 -3 1.526 -3 2.598z"/><path d="M3 6v10c0 .888 .772 1.45 2 2"/><path d="M3 11c0 .888 .772 1.45 2 2"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0z"/><path d="M15 9h.01"/></svg>',
  lock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6" rx="1.5"></rect><path d="M5.5 7V5.6a2.5 2.5 0 0 1 5 0V7"></path></svg>',
};

function isMacPlatform() {
  const platform = typeof navigator !== 'undefined' ? String(navigator.platform || '') : '';
  return /mac/i.test(platform) || document.body?.classList?.contains('platform-darwin') === true;
}

export class ComposerDropdowns {
  constructor(app) {
    this.app = app;
    this.activeComposerModelMenuProvider = null;
    this._preserveComposerModelDropdown = false;
    // Pointer-intent state for the provider submenu: a short trail of recent
    // pointer positions plus at most one deferred provider switch.
    this._composerPointerTrail = [];
    this._pendingProviderSwitch = null;
    // Horizontal side of the submenu, resolved once per open ('right'/'left').
    this._composerSubmenuSide = null;
    // Model picker: search text, live effort drag, and the open-only key hook.
    this._modelPickerQuery = '';
    this._effortDrag = null;
    this._modelPickerShortcutHandler = null;
    this.composerDropdownConfigs = [
      {
        controlId: 'composer-model-control',
        triggerId: 'composer-model-trigger',
        menuId: 'composer-model-menu',
        selectId: 'model-select',
        type: 'model'
      },
      {
        controlId: 'composer-reasoning-control',
        triggerId: 'composer-reasoning-trigger',
        menuId: 'composer-reasoning-menu',
        selectId: 'reasoning-level-select',
        type: 'reasoning',
        groupLabel: 'Reasoning'
      },
      {
        controlId: 'composer-credit-priority-control',
        triggerId: 'composer-credit-priority-trigger',
        menuId: 'composer-credit-priority-menu',
        selectId: 'ropilot-credit-priority-select',
        type: 'credit-priority',
        groupLabel: 'Route'
      },
      {
        controlId: 'codex-playtest-subagent-control',
        triggerId: 'codex-playtest-subagent-trigger',
        menuId: 'codex-playtest-subagent-menu',
        selectId: 'codex-playtest-subagent-select',
        type: 'settings'
      }
    ];
  }

  getComposerDropdownConfigByControlId(controlId) {
    return this.composerDropdownConfigs.find((config) => config.controlId === controlId) || null;
  }

  getComposerDropdownElements(controlId) {
    const config = this.getComposerDropdownConfigByControlId(controlId);
    if (!config) return null;

    const control = document.getElementById(config.controlId);
    const trigger = document.getElementById(config.triggerId);
    const menu = document.getElementById(config.menuId);
    const select = document.getElementById(config.selectId);

    if (!control || !trigger || !menu || !select) return null;

    return { config, control, trigger, menu, select };
  }

  initComposerDropdowns() {
    const outsidePointerHandler = (event) => {
      if (this.composerDropdownConfigs.some(({ controlId }) => {
        const control = document.getElementById(controlId);
        return control?.contains(event.target);
      })) {
        return;
      }
      this.closeComposerDropdowns();
    };

    const escapeHandler = (event) => {
      if (event.key !== 'Escape') return;
      this.closeComposerDropdowns();
    };

    document.addEventListener('pointerdown', outsidePointerHandler);
    document.addEventListener('keydown', escapeHandler);
    window.addEventListener('resize', () => this.closeComposerDropdowns());
    window.addEventListener('blur', () => this.closeComposerDropdowns());

    for (const config of this.composerDropdownConfigs) {
      const { controlId } = config;
      const elements = this.getComposerDropdownElements(controlId);
      if (!elements) continue;

      const { control, trigger, menu, select } = elements;

      trigger.addEventListener('click', () => {
        if (select.disabled) return;
        const isOpen = control.classList.contains('is-open');
        if (isOpen) {
          this.closeComposerDropdowns();
          return;
        }
        this.openComposerDropdown(controlId);
      });

      trigger.addEventListener('keydown', (event) => {
        if (select.disabled) return;
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.openComposerDropdown(controlId);
          this.focusComposerDropdownItem(controlId, 'selected');
        }
      });

      menu.addEventListener('click', (event) => {
        if (event.target.closest('.composer-dropdown-byo-toggle')) {
          event.preventDefault();
          event.stopPropagation();
          const option = event.target.closest('[data-ai-mode]');
          if (option && !option.disabled) {
            this.setBringYourOwnSubscription(option.dataset.aiMode === 'subscription');
          }
          return;
        }

        const star = event.target.closest('.composer-model-star');
        if (star) {
          event.preventDefault();
          event.stopPropagation();
          this.toggleComposerModelStar(star.dataset.model || '', star.dataset.presetEffort);
          return;
        }

        if (event.target.closest('.composer-effort-card')) return;

        const providerTrigger = event.target.closest('.composer-dropdown-provider[data-provider]');
        if (providerTrigger && !providerTrigger.classList.contains('is-disabled')) {
          event.preventDefault();
          this.setActiveComposerModelMenuProvider(providerTrigger.dataset.provider || '');
          return;
        }

        const item = event.target.closest('[data-value]');
        if (!item || item.classList.contains('is-disabled')) return;
        if (config.type === 'model' && item.dataset.presetEffort !== undefined) {
          this.selectComposerModelPreset(item.dataset.value || '', item.dataset.presetEffort || '');
          return;
        }
        this.selectComposerDropdownValue(controlId, item.dataset.value || '');
      });

      // Picker rows never take focus from the search field on a mouse press
      // (Synara keeps typing in the field while the pointer picks).
      menu.addEventListener('mousedown', (event) => {
        if (config.type !== 'model') return;
        if (event.target.closest('input, .composer-effort-slider')) return;
        if (event.target.closest('button, [role="button"], [data-value]')) event.preventDefault();
      });

      menu.addEventListener('pointermove', (event) => {
        if (config.type !== 'model') return;
        this.recordComposerPointer(event);
      });

      menu.addEventListener('mouseover', (event) => {
        // Synara's provider tabs switch on click only; hovering the open list
        // just anchors any pending switch.
        if (config.type === 'model') {
          this.cancelPendingProviderSwitch();
          return;
        }
        const providerTrigger = event.target.closest('.composer-dropdown-provider[data-provider]');
        if (!providerTrigger || providerTrigger.classList.contains('is-disabled')) {
          if (event.target.closest?.('.composer-dropdown-submenu')) {
            this.cancelPendingProviderSwitch();
          }
          return;
        }
        this.requestComposerModelMenuProvider(providerTrigger.dataset.provider || '', event);
      });

      menu.addEventListener('input', (event) => {
        if (config.type !== 'model') return;
        const input = event.target.closest?.('.composer-model-picker-search-input');
        if (!input) return;
        this._modelPickerQuery = input.value || '';
        this.renderComposerModelPickerList(menu);
      });

      menu.addEventListener('keydown', (event) => {
        if (config.type === 'model' && this.handleComposerModelPickerKeydown(event, menu, trigger)) {
          return;
        }

        const items = this.getComposerDropdownEnabledItems(controlId);
        if (!items.length) return;

        const activeItem = document.activeElement?.closest?.('.composer-dropdown-entry');
        const activeIndex = items.indexOf(activeItem);

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          const nextIndex = activeIndex >= 0 ? (activeIndex + 1) % items.length : 0;
          items[nextIndex]?.focus();
          return;
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          const nextIndex = activeIndex >= 0 ? (activeIndex - 1 + items.length) % items.length : items.length - 1;
          items[nextIndex]?.focus();
          return;
        }

        if (event.key === 'Home') {
          event.preventDefault();
          items[0]?.focus();
          return;
        }

        if (event.key === 'End') {
          event.preventDefault();
          items[items.length - 1]?.focus();
          return;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          this.closeComposerDropdowns();
          trigger.focus();
          return;
        }

        if (
          (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight')
          && activeItem?.classList.contains('composer-dropdown-provider')
        ) {
          event.preventDefault();
          this.focusFirstComposerProviderSubmenuItem(activeItem);
        }
      });

      select.addEventListener('change', () => {
        this.syncComposerDropdown(controlId);
      });

      control.addEventListener('focusout', (event) => {
        if (control.contains(event.relatedTarget)) return;
        window.setTimeout(() => {
          if (controlId === 'composer-model-control' && this._preserveComposerModelDropdown) return;
          if (control.contains(document.activeElement)) return;
          // A pointer drag on the effort slider keeps the picker open.
          if (controlId === 'composer-model-control' && this._effortDrag) return;
          this.closeComposerDropdowns();
        }, 0);
      });
    }

    this.syncComposerDropdowns();
  }

  syncComposerDropdowns() {
    for (const { controlId } of this.composerDropdownConfigs) {
      this.syncComposerDropdown(controlId);
    }
  }

  syncComposerDropdown(controlId) {
    const elements = this.getComposerDropdownElements(controlId);
    if (!elements) return;

    const { control, trigger, menu, select, config } = elements;
    const isDisabled = !!select.disabled;

    control.classList.toggle('is-disabled', isDisabled);
    trigger.disabled = isDisabled;
    trigger.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
    menu.classList.toggle('is-model-menu', config.type === 'model');

    if (config.type === 'model') {
      this.renderComposerModelPicker(menu);
      return;
    }

    menu.innerHTML = '';
    const fragment = document.createDocumentFragment();

    if (config.groupLabel) {
      fragment.appendChild(this.createComposerDropdownGroupLabel(config.groupLabel));
    }
    for (const option of Array.from(select.options)) {
      if (option.dataset.actionsHiddenCompatibility === 'true') continue;
      const optionValue = option.value || '';
      const locked = option.dataset.locked === 'true';
      fragment.appendChild(this.createComposerDropdownItem({
        value: optionValue,
        label: option.textContent?.trim() || '',
        selected: !locked && option.value === select.value,
        disabled: !!option.disabled,
        locked,
        lockLabel: option.dataset.lockLabel || 'Upgrade to Plus',
        metaHtml: config.type === 'reasoning'
          ? this.getReasoningCostMetaHtml(optionValue)
          : (config.type === 'credit-priority' ? this.getRopilotCreditPriorityCostMetaHtml(optionValue) : '')
      }));
    }
    if (config.type === 'credit-priority') {
      fragment.appendChild(this.createComposerDropdownNote(
        'Standard route is selected automatically.'
      ));
    } else if (config.type === 'reasoning') {
      const note = this.getComposerReasoningNote();
      if (note) fragment.appendChild(this.createComposerDropdownNote(note));
    }

    menu.appendChild(fragment);
  }

  // Luna's pricing notes, shared by the (hidden) reasoning menu and the
  // picker's effort slider card.
  getComposerReasoningNote() {
    if (this.app.isUseRopilotCreditsEnabled?.() !== true) return '';
    if (this.app.normalizeSelectedModel?.(this.app.selectedModel) !== 'gpt-6-luna') return '';
    const priority = this.app.getRopilotCreditsRoutePriority?.() || 'economy';
    const fastOn = this.isManagedFastModeOnForSelectedModel();
    return fastOn
      ? 'Fast mode uses Ropilot Credits at every reasoning level, including Medium.'
      : priority === 'priority'
        ? 'Priority mode uses Ropilot Credits at every reasoning level.'
        : 'Low and Medium are free. Going above Medium uses Ropilot Credits.';
  }

  createComposerDropdownGroupLabel(text) {
    const label = document.createElement('div');
    label.className = 'composer-dropdown-group-label';
    label.textContent = text;
    return label;
  }

  createComposerDropdownNote(text) {
    const note = document.createElement('div');
    note.className = 'composer-dropdown-note';
    note.textContent = text;
    return note;
  }

  createComposerDropdownSeparator() {
    const separator = document.createElement('div');
    separator.className = 'composer-dropdown-separator';
    separator.setAttribute('aria-hidden', 'true');
    return separator;
  }

  getComposerModelMenuData() {
    const select = document.getElementById('model-select');
    const providerOptions = { ropilot: [], codex: [], claude: [] };
    const providerAccess = {
      ropilot: { locked: false },
      codex: { locked: false },
      claude: {
        locked: this.shouldLockAnthropicManagedCreditProvider(),
        reason: 'Upgrade to Plus to unlock Anthropic models.'
      }
    };
    const useRopilotCredits = this.app.isUseRopilotCreditsEnabled?.() === true;
    let addMoreOption = null;
    if (!select) {
      return { providerOptions, providerAccess, addMoreOption };
    }

    for (const option of Array.from(select.options)) {
      const value = option.value || '';
      const label = option.textContent?.trim() || '';

      if (option.dataset.actionsHiddenCompatibility === 'true') {
        continue;
      }

      if (
        useRopilotCredits
        && modelCatalog.ROPILOT_CREDITS_HIDDEN_MODEL_VALUES.has(value)
      ) {
        continue;
      }

      if (!value) {
        continue;
      }

      if (option.disabled && /^[-\s]+$/.test(label)) {
        continue;
      }

      if (value === 'add_more_models') {
        addMoreOption = {
          value,
          label,
          disabled: false
        };
        continue;
      }

      const provider = this.app.getProviderForModel(value);
      if (!provider || !providerOptions[provider]) continue;
      if (provider === 'ropilot' && !useRopilotCredits) continue;
      if (useRopilotCredits && providerAccess[provider]?.locked === true) continue;
      providerOptions[provider].push({
        value,
        label,
        selected: value === select.value,
        disabled: !!option.disabled,
        provider
      });
    }

    return { providerOptions, providerAccess, addMoreOption };
  }

  shouldLockAnthropicManagedCreditProvider() {
    return this.app.shouldHideAnthropicManagedCreditModels();
  }

  // One icon tab of the picker's strip (Synara PickerTabButton). The provider
  // name rides on the tooltip; the active tab carries the accent underline.
  createComposerDropdownProviderButton(provider, options, access = {}) {
    const providerName = this.getComposerModelProviderLabel(provider);
    const isActive = this.activeComposerModelMenuProvider === provider;
    const isLocked = access.locked === true;
    const costMetaHtml = this.getRopilotCreditsProviderCostMetaHtml(provider);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'composer-dropdown-entry composer-dropdown-provider composer-model-picker-tab';
    trigger.setAttribute('role', 'tab');
    if (costMetaHtml) {
      trigger.classList.add('has-provider-cost');
    }
    trigger.dataset.provider = provider;
    if (isLocked) {
      trigger.classList.add('is-disabled', 'is-locked');
      trigger.disabled = true;
      trigger.setAttribute('aria-disabled', 'true');
      trigger.setAttribute('aria-label', `${providerName} (locked)`);
      trigger.dataset.composerTip = access.reason || 'Upgrade to unlock this provider.';
    } else {
      trigger.setAttribute('aria-label', providerName);
      trigger.dataset.composerTip = providerName;
    }
    trigger.setAttribute('aria-selected', isActive && !isLocked ? 'true' : 'false');
    trigger.tabIndex = -1;
    if (isActive && !isLocked) {
      trigger.classList.add('is-active');
    }

    trigger.innerHTML = `
      <span class="composer-dropdown-provider-name">
        ${this.getComposerDropdownProviderIconHtml(provider)}
        <span class="composer-dropdown-provider-label">${escapeHtml(providerName)}</span>
      </span>
      ${costMetaHtml}
      ${isLocked ? this.getComposerLockedProviderOverlayHtml() : ''}
    `;
    return trigger;
  }

  createComposerStarredTabButton() {
    const isActive = this.activeComposerModelMenuProvider === STARRED_TAB;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'composer-dropdown-entry composer-dropdown-provider composer-model-picker-tab composer-model-picker-tab-starred';
    tab.dataset.provider = STARRED_TAB;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-label', 'Starred');
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.dataset.composerTip = 'Starred';
    tab.tabIndex = -1;
    if (isActive) tab.classList.add('is-active');
    tab.innerHTML = `<span class="composer-model-picker-tab-glyph">${ICON.starFilled}</span>`;
    return tab;
  }

  getComposerLockedProviderOverlayHtml(label = 'Upgrade to Plus') {
    return `
      <span class="composer-dropdown-provider-lock-overlay" aria-hidden="true">
        <span class="composer-dropdown-provider-lock-icon">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3.5" y="7" width="9" height="6" rx="1.5"></rect>
            <path d="M5.5 7V5.6a2.5 2.5 0 0 1 5 0V7"></path>
          </svg>
        </span>
        <span class="composer-dropdown-provider-upgrade">${escapeHtml(label)}</span>
      </span>
    `;
  }

  // Synara's "Add providers" "+" at the end of the tab strip: in subscription
  // mode it opens the sign-in flow for more models (the add_more_models value).
  createComposerDropdownProviderAction(option) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'composer-dropdown-entry composer-dropdown-provider-action composer-model-picker-tab';
    action.dataset.value = option.value;
    action.setAttribute('aria-label', option.label || 'Add more models');
    action.dataset.composerTip = option.label || 'Add more models';
    action.tabIndex = -1;
    action.innerHTML = `<span class="composer-model-picker-tab-glyph">${ICON.plus}</span>`;
    return action;
  }

  // Ropilot Credits vs the user's own ChatGPT/Claude subscription, as
  // Synara's raised-thumb segmented control at the top of the picker.
  createComposerSubscriptionToggle() {
    const subscription = this.app.isBringYourOwnSubscriptionEnabled();
    const wrap = document.createElement('div');
    wrap.className = 'composer-model-picker-mode';
    const group = document.createElement('div');
    group.className = 'composer-dropdown-byo-toggle composer-segmented';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'How Ropilot pays for models');
    group.dataset.active = subscription ? 'subscription' : 'credits';
    group.innerHTML = `
      <span class="composer-segmented-thumb" aria-hidden="true"></span>
      <button type="button" class="composer-segmented-option" role="radio" data-ai-mode="subscription"
        aria-checked="${subscription ? 'true' : 'false'}" tabindex="-1"
        data-composer-tip="Use your own ChatGPT or Claude subscription">
        <span class="composer-segmented-label">${ICON.key}<span>My subscription</span></span>
      </button>
    `;
    // Switching must not close the picker or start a model selection.
    group.addEventListener('pointerdown', (event) => event.stopPropagation());
    group.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const toSubscription = event.key === 'ArrowRight'
        ? true
        : event.key === 'ArrowLeft'
          ? false
          : !this.app.isBringYourOwnSubscriptionEnabled();
      if (toSubscription !== this.app.isBringYourOwnSubscriptionEnabled()) {
        this.setBringYourOwnSubscription(toSubscription);
      }
    });
    wrap.appendChild(group);
    return wrap;
  }

  setBringYourOwnSubscription(enabled) {
    this.setUseRopilotCredits(!enabled);
  }

  activateRopilotCreditsMode(options = {}) {
    const source = typeof options.source === 'string' && options.source.trim()
      ? options.source.trim()
      : 'managed_credits_mode';
    const syncToEdge = options.syncToEdge !== false;
    this.app.preserveRopilotCreditsModeUntilMs = Date.now() + 30000;
    this.app.recordAiModeUserChoice(true);

    if (typeof this.app.settings?.applySettingsValues === 'function') {
      this.app.settings.applySettingsValues({
        use_ropilot_credits: true,
        autoPlaytest: false
      }, source);
    } else {
      const wasEnabled = this.app.isUseRopilotCreditsEnabled() === true;
      this.app.useRopilotCredits = true;
      if (!wasEnabled) {
        this.app.applyRopilotCreditsDefaultModel?.({ updateActiveChat: true });
      }
      this.app.refreshModelOptions?.().catch((err) => {
        console.warn('Failed to refresh models after managed credits mode activation:', err);
      });
      this.syncComposerDropdown?.('composer-model-control');
      this.app.syncComposerFooterControls?.();
    }

    this.forceAutoPlaytestOffForAiModeToggle();
    this.app.refreshReasoningOptions?.();
    this.syncComposerDropdown?.('composer-model-control');
    this.app.syncComposerFooterControls?.();

    if (this.app.latestAccountBalancePayload) {
      this.app.settings?.applyAccountBalancePayload?.(this.app.latestAccountBalancePayload);
    } else if (this.app.latestManagedAiCreditsBalance?.type === 'managed_ai_credits') {
      this.app.accountCreditsBalance = { ...this.app.latestManagedAiCreditsBalance };
      this.app.actionsRemaining = this.app.accountCreditsBalance.remaining;
      this.app.actionsLimit = null;
      this.app.settings?.updateActionsDisplay?.();
      this.app.settings?.updateClaimBonusButton?.();
    } else if (this.app.accountCreditsBalance?.type !== 'managed_ai_credits') {
      this.app.accountCreditsBalance = {
        type: 'managed_ai_credits',
        label: 'Ropilot Credits',
        remaining: this.app.getManagedCreditsRemaining() ?? 0,
        limit: null,
        hasMeter: false
      };
      this.app.actionsRemaining = this.app.accountCreditsBalance.remaining;
      this.app.actionsLimit = null;
      this.app.settings?.updateActionsDisplay?.();
      this.app.settings?.updateClaimBonusButton?.();
    }

    if (syncToEdge) {
      this.app.settings?.syncUseRopilotCreditsToEdge?.(true, {
        preserveLocalOnFailure: true,
        preserveLocalOnConflict: true,
      });
    }

    return this.app.selectedModel;
  }

  setUseRopilotCredits(enabled) {
    const nextValue = !!enabled;
    const wasEnabled = this.app.isUseRopilotCreditsEnabled() === true;
    const modelDropdownWasOpen = document.getElementById('composer-model-control')?.classList.contains('is-open') === true;
    if (modelDropdownWasOpen) {
      this._preserveComposerModelDropdown = true;
    }
    const restoreModelDropdown = () => {
      if (!modelDropdownWasOpen) return;
      const elements = this.getComposerDropdownElements('composer-model-control');
      if (!elements) return;
      const { control, trigger, menu } = elements;
      control.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      menu.hidden = false;
      // The other mode lists other models: land on the selected model's tab.
      if (this.activeComposerModelMenuProvider !== STARRED_TAB) {
        this.activeComposerModelMenuProvider = this.getInitialComposerModelMenuProvider(elements.select.value)
          || this.activeComposerModelMenuProvider;
      }
      this.renderComposerModelPicker(menu);
      this.attachComposerModelPickerShortcuts();
      menu.querySelector('.composer-model-picker-search-input')?.focus?.({ preventScroll: true });
    };

    this.app.useRopilotCredits = nextValue;
    this.app.recordAiModeUserChoice(nextValue);
    if (!nextValue) {
      this.app.preserveRopilotCreditsModeUntilMs = 0;
    }
    if (nextValue && !wasEnabled) {
      this.app.applyRopilotCreditsDefaultModel({ updateActiveChat: true });
    }
    this.forceAutoPlaytestOffForAiModeToggle();
    this.app.refreshReasoningOptions();
    this.app.refreshModelOptions()
      .then(() => restoreModelDropdown())
      .catch((err) => {
        console.warn('Failed to refresh models after use_ropilot_credits toggle:', err);
        restoreModelDropdown();
      })
      .finally(() => {
        window.setTimeout(() => {
          this._preserveComposerModelDropdown = false;
        }, 3000);
      });
    this.syncComposerDropdown('composer-model-control');
    restoreModelDropdown();
    this.app.syncComposerFooterControls();
    if (this.app.latestAccountBalancePayload) {
      this.app.settings?.applyAccountBalancePayload?.(this.app.latestAccountBalancePayload);
    } else {
      this.app.settings?.updateActionsDisplay?.();
      this.app.settings?.updateClaimBonusButton?.();
    }
    this.app.settings?.syncUseRopilotCreditsToEdge?.(nextValue, {
      preserveLocalOnFailure: true,
      preserveLocalOnConflict: true,
    });
  }

  // ---------------------------------------------------------------------
  // Model picker (Synara ComposerModelPicker)
  // ---------------------------------------------------------------------

  // Builds the picker once per menu and refreshes it in place afterwards, so
  // the search field keeps focus and caret and a live slider drag survives
  // the footer re-sync every reasoning change triggers.
  renderComposerModelPicker(menu) {
    if (!menu) return;
    let picker = menu.querySelector(':scope > .composer-model-picker');
    if (!picker) {
      picker = document.createElement('div');
      picker.className = 'composer-model-picker';
      picker.innerHTML = `
        <div class="composer-model-picker-mode-slot"></div>
        <div class="composer-dropdown-model-layout">
          <div class="composer-model-picker-tabs">
            <div class="composer-dropdown-provider-list" role="tablist" aria-label="Model sources"></div>
            <div class="composer-model-picker-tabs-end"></div>
          </div>
          <div class="composer-model-picker-search">
            <span class="composer-model-picker-search-icon" aria-hidden="true">${ICON.search}</span>
            <input type="search" class="composer-model-picker-search-input" aria-label="Search models"
              placeholder="Search models…" autocomplete="off" spellcheck="false">
          </div>
          <div class="composer-model-picker-list-slot"></div>
        </div>
        <div class="composer-model-picker-footer"></div>
      `;
      menu.replaceChildren(picker);
    }

    const data = this.getComposerModelMenuData();
    const { providerOptions, providerAccess, addMoreOption } = data;

    picker.querySelector('.composer-model-picker-mode-slot')
      .replaceChildren(this.createComposerSubscriptionToggle());

    this.activeComposerModelMenuProvider = this.resolveComposerModelPickerTab(this.activeComposerModelMenuProvider, data);
    const isStarredTab = this.activeComposerModelMenuProvider === STARRED_TAB;

    const tabList = picker.querySelector('.composer-dropdown-provider-list');
    const tabs = [this.createComposerStarredTabButton()];
    for (const provider of modelCatalog.COMPOSER_MODEL_PROVIDER_ORDER) {
      const options = providerOptions[provider] || [];
      const access = providerAccess[provider] || {};
      if (!options.length && access.locked !== true) continue;
      tabs.push(this.createComposerDropdownProviderButton(provider, options, access));
    }
    tabList.replaceChildren(...tabs);
    const tabsEnd = picker.querySelector('.composer-model-picker-tabs-end');
    tabsEnd.replaceChildren(...(addMoreOption ? [this.createComposerDropdownProviderAction(addMoreOption)] : []));

    const search = picker.querySelector('.composer-model-picker-search-input');
    if (search) {
      const placeholder = isStarredTab ? 'Search starred…' : 'Search models…';
      if (search.placeholder !== placeholder) search.placeholder = placeholder;
      if (search.value !== this._modelPickerQuery) search.value = this._modelPickerQuery;
    }

    this.renderComposerModelPickerList(menu, data);
    this.renderComposerEffortCard(picker.querySelector('.composer-model-picker-footer'));
    this.syncComposerModelTriggerPlaceholder();
  }

  // Tab to show: the requested one if it can open, else the selected
  // model's provider, else the first provider with models.
  resolveComposerModelPickerTab(requested, data = this.getComposerModelMenuData()) {
    const { providerOptions, providerAccess } = data;
    const canOpen = (provider) => !!providerOptions?.[provider]?.length && providerAccess?.[provider]?.locked !== true;
    if (requested === STARRED_TAB) return STARRED_TAB;
    if (requested && canOpen(requested)) return requested;
    const select = document.getElementById('model-select');
    const selectedProvider = select?.value ? this.app.getProviderForModel?.(select.value) : null;
    if (selectedProvider && canOpen(selectedProvider)) return selectedProvider;
    const first = modelCatalog.COMPOSER_MODEL_PROVIDER_ORDER.find((provider) => canOpen(provider));
    return first || null;
  }

  renderComposerModelPickerList(menu, data = this.getComposerModelMenuData()) {
    const slot = menu?.querySelector('.composer-model-picker-list-slot');
    if (!slot) return;
    const tab = this.activeComposerModelMenuProvider;
    let list;
    if (tab === STARRED_TAB) {
      list = this.createComposerStarredSubmenu(data);
    } else if (tab) {
      list = this.createComposerDropdownSubmenu(tab, data.providerOptions[tab] || []);
    } else {
      list = this.createComposerModelPickerSetupPanel(data);
    }
    slot.replaceChildren(list);
  }

  // No provider can list models yet (subscription mode without a sign-in):
  // Synara's "needs setup" panel in place of the list.
  createComposerModelPickerSetupPanel(data) {
    const panel = document.createElement('div');
    panel.className = 'composer-dropdown-submenu composer-model-picker-setup';
    panel.setAttribute('role', 'tabpanel');
    const canAdd = !!data?.addMoreOption;
    panel.innerHTML = `
      <span class="composer-model-picker-setup-title">No models connected</span>
      <span class="composer-model-picker-setup-text">${canAdd
        ? 'Sign in to ChatGPT or Claude to use your own subscription.'
        : 'Models will appear here once your account is ready.'}</span>
      ${canAdd ? `<button type="button" class="composer-model-picker-setup-button" data-value="${escapeHtml(data.addMoreOption.value)}">Add models</button>` : ''}
    `;
    return panel;
  }

  getComposerModelPickerQuery() {
    return String(this._modelPickerQuery || '').trim().toLowerCase();
  }

  createComposerDropdownSubmenu(provider, options) {
    const submenu = document.createElement('div');
    submenu.className = 'composer-dropdown-submenu';
    submenu.setAttribute('role', 'tabpanel');
    submenu.setAttribute('aria-label', `${this.getComposerModelProviderLabel(provider)} models`);

    const list = document.createElement('div');
    list.className = 'composer-dropdown-submenu-list';

    if (!options.length) {
      const empty = document.createElement('div');
      empty.className = 'composer-dropdown-submenu-empty';
      empty.textContent = 'No models available';
      submenu.appendChild(empty);
      return submenu;
    }

    const query = this.getComposerModelPickerQuery();
    const visibleOptions = query
      ? options.filter((option) => `${option.label} ${option.value}`.toLowerCase().includes(query))
      : options;
    if (!visibleOptions.length) {
      const empty = document.createElement('div');
      empty.className = 'composer-dropdown-submenu-empty';
      empty.textContent = 'No matches';
      submenu.appendChild(empty);
      return submenu;
    }

    const useRopilotCredits = this.app.isUseRopilotCreditsEnabled?.() === true;
    let shortcutIndex = 0;
    for (const option of visibleOptions) {
      const menuMeta = useRopilotCredits
        ? modelCatalog.ROPILOT_CREDITS_MODEL_MENU_META[this.app.normalizeSelectedModel(option.value)]
        : null;
      const selectable = !option.disabled;
      list.appendChild(this.createComposerDropdownItem({
        value: option.value,
        label: option.label,
        selected: option.selected,
        disabled: option.disabled,
        iconHtml: this.getComposerDropdownProviderIconHtml(option.provider),
        metaHtml: this.getComposerDropdownModelMetaHtml(option.value, { useRopilotCredits }),
        subText: menuMeta?.description || '',
        featured: menuMeta?.featured === true,
        modelRow: true,
        shortcutHint: selectable && shortcutIndex < MODEL_PICKER_SHORTCUT_ROW_LIMIT
          ? this.getComposerModelShortcutLabel(shortcutIndex)
          : '',
        starred: this.isComposerModelStarred(option.value)
      }));
      if (selectable) shortcutIndex += 1;
    }

    submenu.appendChild(list);
    if (
      this.app.normalizeModelProvider(provider) === 'codex' &&
      this.app.isCodexFreeAccount() &&
      !useRopilotCredits
    ) {
      submenu.appendChild(this.createComposerDropdownNote(modelCatalog.CODEX_FREE_HIDDEN_MODELS_NOTE));
    }
    return submenu;
  }

  // Starred presets usable in the current mode, resolved to their rows.
  getComposerStarredRows(data = this.getComposerModelMenuData()) {
    const available = new Map();
    for (const provider of Object.keys(data.providerOptions || {})) {
      for (const option of data.providerOptions[provider] || []) {
        available.set(option.value, option);
      }
    }
    return this.readComposerStarredModels()
      .filter((entry) => available.has(entry.model))
      .map((entry) => ({ entry, option: available.get(entry.model) }));
  }

  createComposerStarredSubmenu(data = this.getComposerModelMenuData()) {
    const submenu = document.createElement('div');
    submenu.className = 'composer-dropdown-submenu composer-model-picker-starred';
    submenu.setAttribute('role', 'tabpanel');
    submenu.setAttribute('aria-label', 'Starred models');
    const query = this.getComposerModelPickerQuery();
    const rows = this.getComposerStarredRows(data).filter(({ option }) => !query
      || `${option.label} ${option.value} ${this.getComposerModelProviderLabel(option.provider)}`.toLowerCase().includes(query));

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'composer-dropdown-submenu-empty composer-model-picker-empty-copy';
      empty.textContent = query
        ? 'No matches'
        : 'Star a model to pin it here together with its effort, then pick it in one click.';
      submenu.appendChild(empty);
      return submenu;
    }

    const list = document.createElement('div');
    list.className = 'composer-dropdown-submenu-list';
    const select = document.getElementById('model-select');
    const currentModel = select?.value || '';
    const currentEffort = this.app.getReasoningLevelForModel?.(currentModel) || '';
    rows.forEach(({ entry, option }, index) => {
      const effortLabel = entry.effort
        ? (modelCatalog.REASONING_LEVEL_LABELS[entry.effort] || entry.effort)
        : '';
      const item = this.createComposerDropdownItem({
        value: option.value,
        label: option.label,
        selected: option.value === currentModel && (!entry.effort || entry.effort === currentEffort),
        disabled: option.disabled,
        iconHtml: this.getComposerDropdownProviderIconHtml(option.provider),
        modelRow: true,
        detail: effortLabel,
        shortcutHint: index < MODEL_PICKER_SHORTCUT_ROW_LIMIT ? this.getComposerModelShortcutLabel(index) : '',
        starred: true,
        presetEffort: entry.effort || ''
      });
      item.classList.add('composer-model-row-preset');
      list.appendChild(item);
    });
    submenu.appendChild(list);
    return submenu;
  }

  getComposerModelShortcutLabel(index) {
    return `${isMacPlatform() ? '⌘' : 'Ctrl '}${index + 1}`;
  }

  // --- Starred presets (Synara starredModels): model + its pinned effort, per mode ---

  readComposerStarredModels() {
    const mode = this.app.isUseRopilotCreditsEnabled?.() === true ? 'credits' : 'subscription';
    let raw = [];
    try {
      raw = JSON.parse(localStorage.getItem(STARRED_MODELS_STORAGE_KEY) || '[]');
    } catch {
      raw = [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry) => entry && typeof entry.model === 'string' && entry.mode === mode);
  }

  writeComposerStarredModels(modeEntries) {
    const mode = this.app.isUseRopilotCreditsEnabled?.() === true ? 'credits' : 'subscription';
    let raw = [];
    try {
      raw = JSON.parse(localStorage.getItem(STARRED_MODELS_STORAGE_KEY) || '[]');
    } catch {
      raw = [];
    }
    const others = Array.isArray(raw) ? raw.filter((entry) => entry && entry.mode !== mode) : [];
    try {
      localStorage.setItem(STARRED_MODELS_STORAGE_KEY, JSON.stringify([...others, ...modeEntries]));
    } catch (err) {
      console.warn('Failed to save starred models:', err);
    }
  }

  isComposerModelStarred(model) {
    return this.readComposerStarredModels().some((entry) => entry.model === model);
  }

  // Provider rows: star with the model's current effort, or unstar every
  // preset of that model. Starred rows: remove exactly that preset.
  toggleComposerModelStar(model, presetEffort) {
    if (!model) return;
    const mode = this.app.isUseRopilotCreditsEnabled?.() === true ? 'credits' : 'subscription';
    const entries = this.readComposerStarredModels();
    let next;
    if (presetEffort !== undefined) {
      next = entries.filter((entry) => !(entry.model === model && (entry.effort || '') === presetEffort));
    } else if (entries.some((entry) => entry.model === model)) {
      next = entries.filter((entry) => entry.model !== model);
    } else {
      const effort = this.app.getReasoningLevelForModel?.(model) || null;
      next = [...entries, { model, effort, mode }];
    }
    this.writeComposerStarredModels(next);
    const menu = document.getElementById('composer-model-menu');
    if (menu) this.renderComposerModelPicker(menu);
  }

  selectComposerModelPreset(model, effort) {
    const elements = this.getComposerDropdownElements('composer-model-control');
    if (!elements) return;
    const { select, trigger } = elements;
    if (select.value !== model) {
      select.value = model;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (effort) this.selectComposerReasoningLevel(effort);
    this.closeComposerDropdowns();
    trigger.focus();
  }

  hasComposerEffortLadder() {
    return !!this.getComposerEffortState();
  }

  createComposerDropdownItem({ value, label, selected, disabled, locked = false, lockLabel = 'Upgrade to Plus', iconHtml = '', metaHtml = '', subText = '', featured = false, modelRow = false, shortcutHint = '', starred = null, detail = '', presetEffort = null }) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'composer-dropdown-entry composer-dropdown-item';
    item.setAttribute('role', 'option');
    item.dataset.value = value;
    const isSelected = selected && !locked;
    item.setAttribute('aria-selected', isSelected ? 'true' : 'false');

    if (isSelected) {
      item.classList.add('is-selected');
    }

    if (disabled || locked) {
      item.classList.add('is-disabled');
      item.disabled = true;
      item.setAttribute('aria-disabled', 'true');
    }
    if (locked) {
      item.classList.add('is-locked');
      item.setAttribute('title', lockLabel);
    }

    const trimmedSubText = typeof subText === 'string' ? subText.trim() : '';
    if (trimmedSubText) {
      item.classList.add('composer-dropdown-item-with-sub');
    }
    if (featured) {
      item.classList.add('composer-dropdown-item-featured');
    }

    // With a descriptor, label+meta and the sub stack in a column beside the
    // icon so the sub lines up exactly under the label at any width.
    const bodyHtml = trimmedSubText
      ? `
        <span class="composer-dropdown-item-main">
          <span class="composer-dropdown-item-title">
            <span class="composer-dropdown-item-label">${escapeHtml(label)}</span>
            ${metaHtml}
          </span>
          <span class="composer-dropdown-item-sub">${escapeHtml(trimmedSubText)}</span>
        </span>`
      : `
        <span class="composer-dropdown-item-label">${escapeHtml(label)}</span>
        ${metaHtml}`;

    // Model picker rows: Synara's single-line row — name, muted detail,
    // mod+digit chip, star. The descriptor rides on the row tooltip.
    let trailingHtml = '';
    if (modelRow) {
      item.classList.add('composer-model-row');
      if (isSelected) item.setAttribute('aria-current', 'true');
      if (trimmedSubText) item.dataset.composerTip = trimmedSubText;
      if (presetEffort !== null) item.dataset.presetEffort = presetEffort;
      const starLabel = starred
        ? `Remove ${label} from starred`
        : `Star ${label} with its current effort`;
      trailingHtml = `
        ${detail ? `<span class="composer-model-row-detail">${escapeHtml(detail)}</span>` : '<span class="composer-model-row-spacer"></span>'}
        ${shortcutHint ? `<kbd class="composer-model-kbd" aria-label="${escapeHtml(shortcutHint)}">${escapeHtml(shortcutHint)}</kbd>` : ''}
        ${starred === null ? '' : `<span class="composer-model-star${starred ? ' is-starred' : ''}" role="button" tabindex="-1"
          aria-pressed="${starred ? 'true' : 'false'}" aria-label="${escapeHtml(starLabel)}"
          data-model="${escapeHtml(value)}"${presetEffort !== null ? ` data-preset-effort="${escapeHtml(presetEffort)}"` : ''}>${starred ? ICON.starFilled : ICON.star}</span>`}
      `;
    }

    item.innerHTML = `
      <span class="composer-dropdown-item-indicator" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37"></path>
        </svg>
      </span>
      <span class="composer-dropdown-item-content">
        ${iconHtml}
        ${bodyHtml}
      </span>
      ${trailingHtml}
      ${locked ? this.getComposerLockedProviderOverlayHtml(lockLabel) : ''}
    `;

    return item;
  }

  getComposerDropdownModelMetaHtml(modelValue, options = {}) {
    const normalizedModel = this.app.normalizeSelectedModel(modelValue);
    if (options.useRopilotCredits === true) {
      return this.getRopilotCreditsModelCostMetaHtml(normalizedModel);
    }

    // No "Free" pill on the BYOK menu: it meant "available on ChatGPT Free",
    // which reads as "costs nothing" (customer confusion 2026-09-16).
    return '';
  }

  // Managed Fast (service_tier 'priority') for the currently selected model.
  // Optional-chained so stub apps in menu tests keep working.
  isManagedFastModeOnForSelectedModel() {
    return this.app.shouldUseRopilotCreditsFastModeForModel?.(this.app.selectedModel) === true;
  }

  getRopilotCreditsModelCostMetaHtml(modelValue) {
    const normalizedModel = this.app.normalizeSelectedModel(modelValue);
    // Luna's Free pill only holds on the Standard route with Fast off; the
    // Priority route and managed Fast both make every Luna request paid.
    const isPriorityLuna = normalizedModel === 'gpt-6-luna'
      && (this.app.getRopilotCreditsRoutePriority?.() === 'priority'
        || (this.app.normalizeSelectedModel(this.app.selectedModel) === 'gpt-6-luna'
          && this.isManagedFastModeOnForSelectedModel()));
    // Catalog meta pills win when present; the featured flagship row carries
    // no pill at all — its row treatment outranks any badge. Other badge
    // kinds (Low quality) still fall through.
    const menuMeta = modelCatalog.ROPILOT_CREDITS_MODEL_MENU_META[normalizedModel];
    const modelBadge = isPriorityLuna ? null : menuMeta?.pill
      || (menuMeta?.featured === true ? null : this.app.getRopilotCreditsModelBadgeMeta(normalizedModel));
    const badgeHtml = modelBadge
      ? `<span class="composer-dropdown-item-pill composer-dropdown-item-pill-${modelBadge.kind}" aria-hidden="true">${escapeHtml(modelBadge.label)}</span>`
      : '';
    const filled = isPriorityLuna ? 1 : modelCatalog.ROPILOT_CREDITS_MODEL_COST_TIERS[normalizedModel];
    if (!filled) return badgeHtml;
    const muted = Math.max(0, 4 - filled);
    const model = this.app.getModelConfig(normalizedModel);
    const label = model?.label || normalizedModel;
    return badgeHtml
      + `<span class="composer-dropdown-item-cost model-cost-${filled}" title="${escapeHtml(label)} estimated Ropilot Credits cost">`
      + `<span class="model-cost-filled">${'$'.repeat(filled)}</span>`
      + (muted ? `<span class="model-cost-muted">${'$'.repeat(muted)}</span>` : '')
      + '</span>';
  }

  getRopilotCreditsProviderCostMetaHtml(provider) {
    if (this.app.isUseRopilotCreditsEnabled?.() !== true) return '';
    const normalizedProvider = this.app.normalizeModelProvider(provider);
    const filled = modelCatalog.ROPILOT_CREDITS_PROVIDER_COST_TIERS[normalizedProvider];
    if (!filled) return '';
    const muted = Math.max(0, 4 - filled);
    const label = this.getComposerModelProviderLabel(normalizedProvider);
    return `<span class="composer-dropdown-provider-cost composer-dropdown-item-cost model-cost-${filled}" title="${escapeHtml(label)} estimated Ropilot Credits cost">`
      + `<span class="model-cost-filled">${'$'.repeat(filled)}</span>`
      + (muted ? `<span class="model-cost-muted">${'$'.repeat(muted)}</span>` : '')
      + '</span>';
  }

  // Luna on Ropilot Credits: Low and Medium cost nothing on the Standard
  // route without Fast; anything above Medium (or Priority / Fast) uses credits.
  isComposerReasoningLevelFree(value) {
    const priority = this.app.getRopilotCreditsRoutePriority?.() || 'economy';
    return this.app.isUseRopilotCreditsEnabled?.() === true
      && this.app.normalizeSelectedModel(this.app.selectedModel) === 'gpt-6-luna'
      && priority !== 'priority'
      && !this.isManagedFastModeOnForSelectedModel()
      && (value === 'low' || value === 'medium');
  }

  getReasoningCostMetaHtml(value) {
    if (this.isComposerReasoningLevelFree(value)) {
      return '<span class="composer-dropdown-item-pill composer-dropdown-item-pill-free" title="No Ropilot Credits used">Free</span>';
    }
    const tiers = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4, ultra: 4 };
    const filled = tiers[value];
    if (!filled) return '';
    const muted = 4 - filled;
    const label = modelCatalog.REASONING_LEVEL_LABELS[value] || value;
    return `<span class="composer-dropdown-item-cost reasoning-cost-${value}" title="${escapeHtml(label)} relative cost">`
      + `<span class="reasoning-cost-filled">${'$'.repeat(filled)}</span>`
      + (muted ? `<span class="reasoning-cost-muted">${'$'.repeat(muted)}</span>` : '')
      + '</span>';
  }

  getRopilotCreditPriorityCostMetaHtml(value) {
    const normalized = this.app.normalizeRopilotCreditsRoutePriority(value);
    const tiers = { economy: 1, priority: 4 };
    const filled = tiers[normalized] || tiers.economy;
    const muted = 4 - filled;
    const label = modelCatalog.ROPILOT_CREDITS_ROUTE_PRIORITY_LABELS[normalized] || modelCatalog.ROPILOT_CREDITS_ROUTE_PRIORITY_LABELS.economy;
    return `<span class="composer-dropdown-item-cost route-priority-cost-${normalized}" title="${escapeHtml(label)} relative credit cost">`
      + `<span class="route-priority-cost-filled">${'$'.repeat(filled)}</span>`
      + (muted ? `<span class="route-priority-cost-muted">${'$'.repeat(muted)}</span>` : '')
      + '</span>';
  }

  // ---------------------------------------------------------------------
  // Effort slider card (Synara ComposerEffortSliderCard) — a view over
  // #reasoning-level-select: every visible level is one stop, locked levels
  // are drawn but cannot be committed, and changes commit immediately.
  // ---------------------------------------------------------------------

  getComposerEffortState() {
    const select = document.getElementById('reasoning-level-select');
    if (!select || select.disabled) return null;
    const levels = Array.from(select.options)
      .filter((option) => option.value)
      .map((option) => ({
        value: option.value,
        label: option.textContent?.trim() || option.value,
        locked: option.dataset.locked === 'true'
      }));
    if (levels.length <= 1) return null;
    let index = levels.findIndex((level) => level.value === select.value);
    if (index < 0) index = 0;
    const model = this.app.coerceModelForProvider?.(this.app.modelProvider, this.app.selectedModel) || this.app.selectedModel;
    const defaultLevel = this.app.getDefaultReasoningLevelForModel?.(model) || '';
    const managedFastSupported = this.app.supportsRopilotCreditsFastModeForModel?.(model) === true;
    const personalFastSupported = !managedFastSupported && this.app.supportsFastModeForModel?.(model) === true;
    const fastEnabled = managedFastSupported
      ? this.app.shouldUseRopilotCreditsFastModeForModel?.(model) === true
      : personalFastSupported && this.app.shouldUseFastModeForModel?.(model) === true;
    const lockedLabels = levels.filter((level) => level.locked).map((level) => level.label);
    const lastUnlocked = levels.reduce((last, level, i) => (level.locked ? last : i), 0);
    return {
      select,
      levels,
      index,
      lastUnlocked,
      model,
      defaultLevel,
      fast: {
        supported: managedFastSupported || personalFastSupported,
        managed: managedFastSupported,
        enabled: fastEnabled
      },
      lockedNote: lockedLabels.length
        ? `${lockedLabels.join(' and ')} need${lockedLabels.length === 1 ? 's' : ''} Ropilot Plus.`
        : '',
      pricingNote: this.getComposerReasoningNote()
    };
  }

  renderComposerEffortCard(footer) {
    if (!footer) return;
    const state = this.getComposerEffortState();
    if (!state) {
      footer.replaceChildren();
      footer.hidden = true;
      return;
    }
    footer.hidden = false;
    let card = footer.querySelector('.composer-effort-card');
    if (!card || Number(card.dataset.stops) !== state.levels.length) {
      card = this.createComposerEffortCard(state);
      footer.replaceChildren(card);
    }
    this.updateComposerEffortCard(card, state);
  }

  createComposerEffortCard(state) {
    const card = document.createElement('div');
    card.className = 'composer-effort-card';
    card.dataset.slot = 'effort-slider-card';
    card.dataset.stops = String(state.levels.length);
    const max = state.levels.length - 1;
    const marks = state.levels.map((level, i) => (
      `<span class="composer-effort-mark" data-index="${i}" style="left:${max ? (i / max) * 100 : 0}%"></span>`
    )).join('');
    card.innerHTML = `
      <div class="composer-effort-card-head">
        <span class="composer-effort-fast-slot"></span>
        <span class="composer-effort-label"></span>
        <button type="button" class="composer-effort-icon-button composer-effort-reset" aria-label="Reset effort and speed"
          data-composer-tip="Reset to defaults">${ICON.reset}</button>
      </div>
      <div class="composer-effort-slider" role="slider" tabindex="0" aria-label="Reasoning effort"
        aria-valuemin="0" aria-valuemax="${max}">
        <div class="composer-effort-track">
          <div class="composer-effort-indicator"></div>
          <span class="composer-effort-marks" aria-hidden="true">${marks}</span>
          <div class="composer-effort-thumb"><span></span></div>
        </div>
      </div>
      <div class="composer-effort-zones" aria-hidden="true" hidden>
        <span class="composer-effort-zone is-free">Free</span>
        <span class="composer-effort-zone is-paid">Uses credits</span>
      </div>
      <div class="composer-effort-note" hidden></div>
    `;

    card.querySelector('.composer-effort-reset').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.resetComposerEffort();
    });

    const slider = card.querySelector('.composer-effort-slider');
    const indexFromEvent = (event) => {
      const track = slider.querySelector('.composer-effort-track');
      const rect = track.getBoundingClientRect();
      const thumb = slider.querySelector('.composer-effort-thumb')?.getBoundingClientRect().width || 28;
      const usable = Math.max(1, rect.width - thumb);
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left - thumb / 2) / usable));
      return Math.round(ratio * max);
    };
    slider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      try { slider.setPointerCapture(event.pointerId); } catch { /* jsdom */ }
      this._effortDrag = { pointerId: event.pointerId };
      card.classList.add('is-pressed');
      document.documentElement.style.cursor = 'grabbing';
      this.commitComposerEffortIndex(indexFromEvent(event));
    });
    slider.addEventListener('pointermove', (event) => {
      if (!this._effortDrag || this._effortDrag.pointerId !== event.pointerId) return;
      this.commitComposerEffortIndex(indexFromEvent(event));
    });
    const endDrag = (event) => {
      if (!this._effortDrag || this._effortDrag.pointerId !== event.pointerId) return;
      this._effortDrag = null;
      card.classList.remove('is-pressed');
      document.documentElement.style.cursor = '';
      // A locked stop shows while dragging but never commits: land back on
      // the highest unlocked level.
      const current = this.getComposerEffortState();
      if (current) this.updateComposerEffortCard(card, current);
      document.querySelector('#composer-model-menu .composer-model-picker-search-input')?.focus({ preventScroll: true });
    };
    slider.addEventListener('pointerup', endDrag);
    slider.addEventListener('pointercancel', endDrag);
    slider.addEventListener('keydown', (event) => {
      const current = this.getComposerEffortState();
      if (!current) return;
      let next = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current.index + 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current.index - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = current.lastUnlocked;
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.commitComposerEffortIndex(Math.min(current.lastUnlocked, Math.max(0, next)));
    });
    return card;
  }

  updateComposerEffortCard(card, state, previewIndex = null) {
    const max = state.levels.length - 1;
    const shownIndex = previewIndex ?? state.index;
    const level = state.levels[shownIndex] || state.levels[state.index];
    card.style.setProperty('--effort-p', String(max ? shownIndex / max : 0));
    card.classList.toggle('is-at-min', shownIndex <= 0);
    card.classList.toggle('is-locked-preview', !!level?.locked);
    // Free zone (Luna): the levels that cost nothing sit left of a boundary
    // the legend under the track names, so moving past it reads as "this
    // now uses credits" before the user lets go.
    let freeLast = -1;
    state.levels.forEach((entry, i) => { if (this.isComposerReasoningLevelFree(entry.value)) freeLast = i; });
    const hasFreeZone = freeLast >= 0 && freeLast < max;
    card.classList.toggle('has-free-zone', hasFreeZone);
    card.classList.toggle('is-paid-level', hasFreeZone && shownIndex > freeLast);
    card.style.setProperty('--effort-free-split', hasFreeZone ? String((freeLast + 0.5) / max) : '1');
    const zones = card.querySelector('.composer-effort-zones');
    if (zones) zones.hidden = !hasFreeZone;
    for (const mark of card.querySelectorAll('.composer-effort-mark')) {
      const i = Number(mark.dataset.index);
      mark.classList.toggle('is-filled', i <= shownIndex);
      mark.classList.toggle('is-locked', state.levels[i]?.locked === true);
      mark.classList.toggle('is-free', hasFreeZone && i <= freeLast);
    }

    const label = card.querySelector('.composer-effort-label');
    if (label) {
      label.innerHTML = level?.locked
        ? `<span class="composer-effort-label-text">${escapeHtml(level.label)}</span><span class="composer-effort-label-lock">${ICON.lock}Plus</span>`
        : `<span class="composer-effort-label-text">${escapeHtml(level?.label || 'Effort')}</span>${this.getReasoningCostMetaHtml(level?.value || '')}`;
    }

    const slider = card.querySelector('.composer-effort-slider');
    slider?.setAttribute('aria-valuenow', String(shownIndex));
    slider?.setAttribute('aria-valuetext', level?.label || '');

    const fastSlot = card.querySelector('.composer-effort-fast-slot');
    if (fastSlot) {
      let fast = fastSlot.querySelector('.composer-effort-fast');
      if (!state.fast.supported) {
        fastSlot.replaceChildren();
      } else {
        if (!fast) {
          fast = document.createElement('button');
          fast.type = 'button';
          fast.className = 'composer-effort-icon-button composer-effort-fast';
          fast.setAttribute('aria-label', 'Fast mode');
          fast.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.toggleComposerEffortFast();
          });
          fastSlot.replaceChildren(fast);
        }
        const multiplier = this.app.getRopilotCreditsFastModeCostMultiplier?.() ?? modelCatalog.ROPILOT_CREDITS_FAST_MODE_COST_MULTIPLIER;
        fast.classList.toggle('is-on', state.fast.enabled);
        fast.setAttribute('aria-pressed', state.fast.enabled ? 'true' : 'false');
        fast.dataset.composerTip = `${state.fast.enabled ? 'Fast mode on' : 'Fast mode off'}${state.fast.managed ? ` · ${multiplier}× credits` : ''}`;
        fast.innerHTML = state.fast.enabled ? ICON.boltFilled : ICON.bolt;
      }
    }

    const reset = card.querySelector('.composer-effort-reset');
    if (reset) {
      const defaultLevel = state.levels.find((entry) => entry.value === state.defaultLevel);
      const effortIsDefault = !defaultLevel || defaultLevel.locked || state.levels[state.index]?.value === state.defaultLevel;
      reset.disabled = effortIsDefault && !state.fast.enabled;
    }

    const note = card.querySelector('.composer-effort-note');
    if (note) {
      const text = level?.locked ? state.lockedNote : (state.pricingNote || '');
      note.textContent = text;
      note.hidden = !text;
    }
  }

  commitComposerEffortIndex(index) {
    const state = this.getComposerEffortState();
    if (!state) return;
    const clamped = Math.min(state.levels.length - 1, Math.max(0, index));
    const level = state.levels[clamped];
    const card = document.querySelector('#composer-model-menu .composer-effort-card');
    if (!level) return;
    if (level.locked) {
      // Show the locked stop (and why) while the pointer is on it.
      if (card) this.updateComposerEffortCard(card, state, clamped);
      return;
    }
    if (level.value !== state.select.value) {
      this.selectComposerReasoningLevel(level.value);
    } else if (card) {
      this.updateComposerEffortCard(card, state);
    }
  }

  selectComposerReasoningLevel(value) {
    const select = document.getElementById('reasoning-level-select');
    if (!select || !value) return;
    const option = Array.from(select.options).find((entry) => entry.value === value);
    if (!option || option.dataset.locked === 'true') return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  toggleComposerEffortFast() {
    const state = this.getComposerEffortState();
    if (!state?.fast.supported) return;
    if (state.fast.managed) {
      this.app.setRopilotCreditsFastMode?.(!state.fast.enabled);
    } else {
      this.app.setCodexFastMode?.(!state.fast.enabled);
    }
  }

  resetComposerEffort() {
    const state = this.getComposerEffortState();
    if (!state) return;
    if (state.fast.enabled) this.toggleComposerEffortFast();
    const defaultLevel = state.levels.find((entry) => entry.value === state.defaultLevel);
    if (defaultLevel && !defaultLevel.locked) this.selectComposerReasoningLevel(defaultLevel.value);
  }

  // Synara swaps the open trigger's label for "Select effort" while the
  // slider card owns effort; the frozen label underneath keeps the width.
  syncComposerModelTriggerPlaceholder() {
    const control = document.getElementById('composer-model-control');
    if (!control) return;
    control.classList.toggle('has-effort-slider', this.hasComposerEffortLadder());
  }

  handleComposerModelPickerKeydown(event, menu, trigger) {
    const search = menu.querySelector('.composer-model-picker-search-input');
    const rows = Array.from(menu.querySelectorAll('.composer-dropdown-submenu .composer-dropdown-item:not(.is-disabled)'));
    const inSearch = document.activeElement === search;
    const rowIndex = rows.indexOf(document.activeElement?.closest?.('.composer-dropdown-item'));

    if (event.key === 'Tab') {
      // Tab walks the provider tabs instead of leaving (and closing) the menu.
      event.preventDefault();
      this.cycleComposerModelPickerTab(event.shiftKey ? -1 : 1);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeComposerDropdowns();
      trigger.focus();
      return true;
    }
    if (inSearch) {
      if (event.key === 'Enter') {
        event.preventDefault();
        rows[0]?.click();
        return true;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        rows[0]?.focus();
        return true;
      }
      // Everything else is typing.
      return true;
    }
    if (rowIndex >= 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        (rows[rowIndex + 1] || rows[0])?.focus();
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (rowIndex === 0) search?.focus();
        else rows[rowIndex - 1]?.focus();
        return true;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        rows[0]?.focus();
        return true;
      }
      if (event.key === 'End') {
        event.preventDefault();
        rows[rows.length - 1]?.focus();
        return true;
      }
      return true;
    }
    return event.target.closest?.('.composer-effort-card') ? true : false;
  }

  getComposerModelPickerOpenTabs() {
    const { providerOptions, providerAccess } = this.getComposerModelMenuData();
    return [STARRED_TAB, ...modelCatalog.COMPOSER_MODEL_PROVIDER_ORDER.filter((provider) => (
      providerOptions[provider]?.length && providerAccess[provider]?.locked !== true
    ))];
  }

  cycleComposerModelPickerTab(direction) {
    const tabs = this.getComposerModelPickerOpenTabs();
    const index = tabs.indexOf(this.activeComposerModelMenuProvider);
    const next = tabs[(index + direction + tabs.length) % tabs.length] || STARRED_TAB;
    this.setActiveComposerModelMenuProvider(next);
  }

  // mod+1…9 picks a visible row while the picker is open (window capture, so
  // the app's own chat shortcuts yield).
  attachComposerModelPickerShortcuts() {
    if (this._modelPickerShortcutHandler) return;
    this._modelPickerShortcutHandler = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (!/^[1-9]$/.test(event.key)) return;
      const menu = document.getElementById('composer-model-menu');
      if (!menu || menu.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      const rows = Array.from(menu.querySelectorAll('.composer-dropdown-submenu .composer-dropdown-item:not(.is-disabled)'));
      rows[Number(event.key) - 1]?.click();
    };
    window.addEventListener('keydown', this._modelPickerShortcutHandler, true);
  }

  detachComposerModelPickerShortcuts() {
    if (!this._modelPickerShortcutHandler) return;
    window.removeEventListener('keydown', this._modelPickerShortcutHandler, true);
    this._modelPickerShortcutHandler = null;
  }

  // Synara aligns the 296px popup with the trigger's start edge and lets
  // collision handling pull it back inside the viewport.
  clampComposerModelPickerPosition(menu) {
    if (!menu) return;
    menu.style.transform = '';
    const rect = menu.getBoundingClientRect();
    if (!rect.width) return;
    const padding = 8;
    const overflow = rect.right - (window.innerWidth - padding);
    const room = rect.left - padding;
    const shift = Math.min(Math.max(0, overflow), Math.max(0, room));
    if (shift > 0) menu.style.transform = `translateX(${-Math.round(shift)}px)`;
  }

  getComposerDropdownEnabledItems(controlId) {
    const elements = this.getComposerDropdownElements(controlId);
    if (!elements) return [];
    return Array.from(elements.menu.querySelectorAll('.composer-dropdown-entry:not(.is-disabled)'))
      .filter((item) => item.offsetParent !== null);
  }

  getComposerModelProviderLabel(provider) {
    if (provider === STARRED_TAB) return 'Starred';
    const normalizedProvider = this.app.normalizeModelProvider(provider);
    if (normalizedProvider === 'ropilot') return 'Ropilot';
    if (normalizedProvider === 'codex') return 'OpenAI';
    return 'Anthropic';
  }

  getComposerDropdownProviderIconHtml(provider) {
    const normalizedProvider = this.app.normalizeModelProvider(provider);
    const mark = getProviderMarkSvg(normalizedProvider);
    return `<span class="composer-dropdown-item-icon composer-provider-mark-${escapeHtml(normalizedProvider || 'claude')}" aria-hidden="true">${mark || getProviderMarkSvg('claude')}</span>`;
  }

  recordComposerPointer(event) {
    if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return;
    const trail = this._composerPointerTrail;
    trail.push({ x: event.clientX, y: event.clientY });
    if (trail.length > 6) trail.shift();
  }

  cancelPendingProviderSwitch() {
    if (!this._pendingProviderSwitch) return;
    window.clearTimeout(this._pendingProviderSwitch.timer);
    this._pendingProviderSwitch = null;
  }

  // Safe-triangle pointer intent: while the pointer travels diagonally from a
  // provider row toward the open submenu it inevitably crosses other provider
  // rows. If the current pointer position sits inside the triangle spanned by
  // a recent pointer position and the submenu's near edge, the traversal is
  // intentional — defer the provider switch instead of hijacking the submenu.
  isComposerPointerHeadingToSubmenu(point, submenu) {
    if (!submenu || !point) return false;
    const rect = submenu.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const origin = this._composerPointerTrail[0] || null;
    if (!origin || (origin.x === point.x && origin.y === point.y)) return false;
    const pad = 8;
    const submenuIsLeftOfPointer = rect.right <= origin.x;
    const edgeX = submenuIsLeftOfPointer ? rect.right : rect.left;
    return pointInTriangle(
      point,
      origin,
      { x: edgeX, y: rect.top - pad },
      { x: edgeX, y: rect.bottom + pad }
    );
  }

  requestComposerModelMenuProvider(provider, event = null) {
    if (this.activeComposerModelMenuProvider === provider) {
      this.cancelPendingProviderSwitch();
      return;
    }
    const menu = document.getElementById('composer-model-menu');
    const submenu = menu && !menu.hidden ? menu.querySelector('.composer-dropdown-submenu') : null;
    const point = Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
      ? { x: event.clientX, y: event.clientY }
      : null;
    if (submenu && point && this.isComposerPointerHeadingToSubmenu(point, submenu)) {
      if (this._pendingProviderSwitch?.provider !== provider) {
        this.cancelPendingProviderSwitch();
        this._pendingProviderSwitch = {
          provider,
          timer: window.setTimeout(() => {
            this._pendingProviderSwitch = null;
            this.setActiveComposerModelMenuProvider(provider);
          }, PROVIDER_SWITCH_INTENT_DELAY_MS)
        };
      }
      return;
    }
    this.setActiveComposerModelMenuProvider(provider);
  }

  setActiveComposerModelMenuProvider(provider) {
    this.cancelPendingProviderSwitch();
    if (this.activeComposerModelMenuProvider === provider) return;
    this.activeComposerModelMenuProvider = provider;
    const menu = document.getElementById('composer-model-menu');
    if (!menu || menu.hidden) return;
    this.renderComposerModelPicker(menu);
    menu.querySelector('.composer-model-picker-search-input')?.focus({ preventScroll: true });
  }

  // Legacy flyout placement for the old provider submenu. The Synara picker
  // lists models inline under its tabs, so it no longer calls this; kept for
  // callers and tests that position a free-standing submenu.
  positionComposerModelSubmenu(menu, provider = this.activeComposerModelMenuProvider) {
    if (!menu) return;
    const submenu = menu.querySelector('.composer-dropdown-submenu');

    // Clear legacy inline offsets from any earlier layout pass.
    menu.style.maxHeight = '';
    menu.style.overflowY = '';

    if (submenu) {
      submenu.style.left = '';
      submenu.style.right = '';
      submenu.style.maxHeight = '';
      submenu.style.overflowY = '';
    }

    if (!provider || !submenu) return;

    const viewportPadding = 12;
    const submenuGap = 8;
    const bounds = this.getComposerSubmenuBounds(menu, viewportPadding);
    const placeLeft = () => {
      submenu.style.left = 'auto';
      submenu.style.right = `calc(100% + ${submenuGap}px)`;
      return submenu.getBoundingClientRect();
    };
    let submenuRect = submenu.getBoundingClientRect();

    if (!['right', 'left', 'overlap'].includes(this._composerSubmenuSide)) {
      if (submenuRect.right <= bounds.right) {
        this._composerSubmenuSide = 'right';
      } else {
        submenuRect = placeLeft();
        this._composerSubmenuSide = submenuRect.left >= bounds.left ? 'left' : 'overlap';
        if (this._composerSubmenuSide === 'overlap') {
          submenu.style.left = '';
          submenu.style.right = '';
          submenuRect = submenu.getBoundingClientRect();
        }
      }
    }
    if (this._composerSubmenuSide === 'left') {
      submenuRect = placeLeft();
    } else if (this._composerSubmenuSide === 'overlap') {
      const overflow = submenuRect.right - bounds.right;
      if (overflow > 0) {
        submenu.style.left = `calc(100% + ${submenuGap - overflow}px)`;
        submenuRect = submenu.getBoundingClientRect();
      }
    }

    const availableSubmenuHeight = Math.floor(submenuRect.bottom - viewportPadding);
    if (availableSubmenuHeight > 0 && submenu.scrollHeight > availableSubmenuHeight) {
      submenu.style.maxHeight = `${availableSubmenuHeight}px`;
      submenu.style.overflowY = 'auto';
    }
  }

  // Legacy: shift a flyout menu left so the widest provider list fits beside
  // it. Unused by the inline Synara picker; kept for compatibility.
  reserveComposerSubmenuRoom(menu) {
    menu.style.transform = '';
    const layout = menu.querySelector('.composer-dropdown-model-layout');
    if (!layout) return;
    const { providerOptions, providerAccess } = this.getComposerModelMenuData();
    let widestRight = 0;
    for (const [provider, options] of Object.entries(providerOptions || {})) {
      if (!options?.length || providerAccess?.[provider]?.locked === true) continue;
      const probe = this.createComposerDropdownSubmenu(provider, options);
      probe.style.visibility = 'hidden';
      layout.appendChild(probe);
      widestRight = Math.max(widestRight, probe.getBoundingClientRect().right);
      probe.remove();
    }
    const bounds = this.getComposerSubmenuBounds(menu, 12);
    const overflow = widestRight - bounds.right;
    const room = menu.getBoundingClientRect().left - bounds.left;
    const shift = Math.min(overflow, room);
    if (shift > 0) menu.style.transform = `translateX(${-Math.round(shift)}px)`;
  }

  // Horizontal room for the submenu: the visible chat area (the sidebar sits
  // beside it), within the viewport.
  getComposerSubmenuBounds(menu, padding) {
    const area = menu.closest('.chat-area')?.getBoundingClientRect();
    const hasArea = area && area.width > 0;
    return {
      left: Math.max(hasArea ? area.left : 0, 0) + padding,
      right: Math.min(hasArea ? area.right : window.innerWidth, window.innerWidth) - padding,
    };
  }

  focusFirstComposerProviderSubmenuItem(providerTrigger) {
    const provider = providerTrigger?.dataset?.provider || '';
    this.setActiveComposerModelMenuProvider(provider);
    const menu = document.getElementById('composer-model-menu');
    const submenuItem = menu?.querySelector('.composer-dropdown-submenu .composer-dropdown-item:not(.is-disabled)');
    submenuItem?.focus();
  }

  // The model picker opens on the selected model's provider tab (Synara-style
  // tabs), so its list is visible right away. Locked or empty providers open
  // with no tab selected, as before.
  getInitialComposerModelMenuProvider(selectedValue) {
    const provider = selectedValue ? this.app.getProviderForModel?.(selectedValue) : null;
    if (!provider) return null;
    const { providerOptions, providerAccess } = this.getComposerModelMenuData();
    if (!providerOptions?.[provider]?.length || providerAccess?.[provider]?.locked === true) return null;
    return provider;
  }

  openComposerDropdown(controlId) {
    const elements = this.getComposerDropdownElements(controlId);
    if (!elements) return;

    const { control, trigger, menu, select } = elements;
    if (select.disabled) return;

    if (controlId === 'composer-model-control') {
      // Synara resets to the fastest starting point on every open: presets
      // when there are any, else the selected model's provider.
      this.activeComposerModelMenuProvider = this.getComposerStarredRows().length
        ? STARRED_TAB
        : this.getInitialComposerModelMenuProvider(select.value);
      this._modelPickerQuery = '';
      this._composerSubmenuSide = null;
      this._composerPointerTrail.length = 0;
      this.cancelPendingProviderSwitch();
      this.syncComposerDropdown(controlId);
    }

    this.closeComposerDropdowns(controlId);
    if (controlId === 'composer-model-control') {
      // The picker hangs off this button. Its label (model + effort) changes
      // while the picker stays open — dragging the effort slider, picking a
      // model — so freeze the button's width until it closes; otherwise the
      // whole picker slides sideways under the pointer.
      control.style.width = `${control.getBoundingClientRect().width}px`;
    }
    control.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    if (controlId === 'composer-model-control') {
      this.clampComposerModelPickerPosition(menu);
      this.attachComposerModelPickerShortcuts();
      menu.querySelector('.composer-model-picker-search-input')?.focus({ preventScroll: true });
    }
  }

  closeComposerDropdowns(exceptControlId = null) {
    if (exceptControlId !== 'composer-model-control') {
      this.cancelPendingProviderSwitch();
      this._composerPointerTrail.length = 0;
      this._composerSubmenuSide = null;
      this.detachComposerModelPickerShortcuts();
      this._effortDrag = null;
    }
    for (const { controlId } of this.composerDropdownConfigs) {
      if (controlId === exceptControlId) continue;
      const elements = this.getComposerDropdownElements(controlId);
      if (!elements) continue;
      elements.control.classList.remove('is-open');
      if (controlId === 'composer-model-control') elements.control.style.width = '';
      elements.trigger.setAttribute('aria-expanded', 'false');
      elements.menu.hidden = true;
    }
  }

  toggleComposerDropdown(controlId) {
    const elements = this.getComposerDropdownElements(controlId);
    if (!elements) return;

    const isOpen = elements.control.classList.contains('is-open');
    if (isOpen) {
      this.closeComposerDropdowns();
      return;
    }

    this.openComposerDropdown(controlId);
    this.focusComposerDropdownItem(controlId, 'selected');
  }

  focusComposerDropdownItem(controlId, mode = 'selected') {
    if (controlId === 'composer-model-control') {
      // Synara focuses the search field; arrows walk the rows from there.
      const search = document.querySelector('#composer-model-menu .composer-model-picker-search-input');
      if (search) {
        search.focus();
        return;
      }
    }

    const items = this.getComposerDropdownEnabledItems(controlId);
    if (!items.length) return;

    if (controlId === 'composer-model-control' && !this.activeComposerModelMenuProvider) {
      const firstProvider = items.find((item) => item.classList.contains('composer-dropdown-provider'));
      (firstProvider || items[0]).focus();
      return;
    }

    if (mode === 'selected') {
      const selectedItem = items.find((item) => item.classList.contains('is-selected'));
      (selectedItem || items[0]).focus();
      return;
    }

    items[0].focus();
  }

  selectComposerDropdownValue(controlId, value) {
    const elements = this.getComposerDropdownElements(controlId);
    if (!elements) return;

    const { select, trigger, control, menu } = elements;
    const wasSelected = select.value === value;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));

    // Slider mode (Synara): switching to a model with an effort ladder keeps
    // the panel open so the card can set its effort; picking the current
    // model again is the "done" gesture.
    if (
      controlId === 'composer-model-control'
      && !wasSelected
      && value !== 'add_more_models'
      && control.classList.contains('is-open')
      && select.value === value
      && this.hasComposerEffortLadder()
    ) {
      this.renderComposerModelPicker(menu);
      menu.querySelector('.composer-model-picker-search-input')?.focus({ preventScroll: true });
      return;
    }

    this.closeComposerDropdowns();
    trigger.focus();
  }

  applyDefaultAutoPlaytestForMode(useRopilotCredits = this.app.isUseRopilotCreditsEnabled(), provider = this.app.modelProvider) {
    if (this.app.hasExplicitAutoPlaytestPreference()) return false;
    const nextValue = this.app.getDefaultAutoPlaytestForMode(useRopilotCredits, provider);
    this.app.autoPlaytest = nextValue;
    const autoPlaytestCheckbox = document.getElementById('auto-playtest-checkbox');
    if (autoPlaytestCheckbox) {
      autoPlaytestCheckbox.checked = this.app.autoPlaytest;
    }
    this.app.syncComposerFooterControls?.();
    return true;
  }

  forceAutoPlaytestOffForAiModeToggle() {
    this.app.hasAutoPlaytestPreference = true;
    this.app.autoPlaytest = false;
    localStorage.setItem('ropilot_auto_playtest', 'false');
    localStorage.setItem('ropilot_auto_playtest_user_set', 'true');
    const autoPlaytestCheckbox = document.getElementById('auto-playtest-checkbox');
    if (autoPlaytestCheckbox) {
      autoPlaytestCheckbox.checked = false;
    }
    this.app.syncComposerFooterControls?.();
  }

  setAutoPlaytest(nextValue) {
    const normalizedValue = !!nextValue;
    this.app.hasAutoPlaytestPreference = true;
    this.app.autoPlaytest = normalizedValue;
    localStorage.setItem('ropilot_auto_playtest', this.app.autoPlaytest);
    localStorage.setItem('ropilot_auto_playtest_user_set', 'true');

    const autoPlaytestCheckbox = document.getElementById('auto-playtest-checkbox');
    if (autoPlaytestCheckbox) {
      autoPlaytestCheckbox.checked = this.app.autoPlaytest;
    }

    this.app.syncComposerFooterControls();
    this.app.syncAutoPlaytestToEdge();
  }

  toggleAutoPlaytest() {
    this.setAutoPlaytest(!this.app.autoPlaytest);
  }
}
