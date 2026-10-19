// @ts-check
// Composer wiring: chat input, send/image buttons, dropdowns, model/reasoning/credit selectors, playtest and fast-mode controls.
import { initComposerExtras } from '../composer/composer-extras.js';
import { initComposerTooltips } from '../composer/composer-tooltip.js';

export function wireComposer(app) {
  // Chat input
  const input = document.getElementById('input-message');
  const sendBtn = document.getElementById('btn-send');
  const addImageBtn = document.getElementById('btn-add-image');
  const imagePickerInput = document.getElementById('input-image-file');

  input.oninput = () => {
    app.stashPromptDraft(app.activeChat?.id, input.value);
    app.autoResizeTextarea(input);
    app.slashCommandManager.updateForInput(input.value);
    app.messageSender.updateButton();  // Use unified button update logic
  };

  // Typing is saved while the user stays in the same chat. Flush the pending
  // synchronous localStorage write when leaving; an unload cannot await a timer.
  const flushPromptDrafts = () => {
    if (app.promptStashDirtyFlag) app.savePromptStash();
  };
  window.addEventListener('pagehide', flushPromptDrafts);
  window.addEventListener('beforeunload', flushPromptDrafts);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPromptDrafts();
  });

  input.onkeydown = (e) => {
    if (app.slashCommandManager.handleKeyDown(e)) {
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const shouldQueue = e.altKey || e.metaKey;
      app.messageSender.send({ mode: shouldQueue ? 'queue' : 'steer' });
      return;
    }
    // Esc stops the active turn (Enter no longer doubles as stop, so a
    // double-tapped Enter can't send and then immediately kill the turn).
    if (e.key === 'Escape' && app.messageSender.isActiveTurnInProgress(app.activeChat?.id, 'escape_stop')) {
      e.preventDefault();
      app.messageSender.stopInference();
    }
  };

  input.addEventListener('paste', (e) => {
    app.handleComposerPaste(e);
  });

  // Last-chance prewarm: the user is about to type their first prompt. A
  // no-op unless the active chat is still empty, codex, and unprewarmed.
  input.addEventListener('focus', () => {
    app.maybePrewarmActiveCodexSession?.();
  });

  addImageBtn?.addEventListener('click', () => {
    app.openComposerFilePicker();
  });

  imagePickerInput?.addEventListener('change', (e) => {
    app.handleComposerFileSelection(e);
  });

  sendBtn.onclick = (e) => {
    app.createRipple(e, sendBtn);
    app.messageSender.send(true);  // true = from button click
  };

  app.initComposerDropdowns();
  // Synara "+" extras panel above the composer, and the picker tooltips.
  app.composerExtras = initComposerExtras(app);
  initComposerTooltips(document);

  // Model selector
  const modelSelect = document.getElementById('model-select');
  if (modelSelect) {
    modelSelect.onchange = () => {
      if (!modelSelect.value) return;

      if (modelSelect.value === 'add_more_models') {
        // Revert visually to current selection so it doesn't stay on 'add_more_models'
        modelSelect.value = app.selectedModel;
        app.syncComposerFooterControls();
        app.returnToLoginScreen();
        return;
      }

      const selectedProvider = app.getProviderForModel(modelSelect.value) || app.normalizeModelProvider(app.modelProvider);
      app.modelProvider = selectedProvider;
      localStorage.setItem('ropilot_model_provider', app.modelProvider);
      app.selectedModel = app.coerceModelForProvider(app.modelProvider, modelSelect.value);
      app.applyDefaultAutoPlaytestForMode(app.isUseRopilotCreditsEnabled(), app.modelProvider);
      modelSelect.value = app.selectedModel;
      localStorage.setItem('ropilot_selected_model', app.selectedModel);
      app.refreshReasoningOptions();
    };
  }

  const reasoningLevelSelect = document.getElementById('reasoning-level-select');
  if (reasoningLevelSelect) {
    reasoningLevelSelect.onchange = () => {
      const selectedModel = app.coerceModelForProvider(app.modelProvider, app.selectedModel);
      app.setReasoningLevelForModel(selectedModel, reasoningLevelSelect.value);
      reasoningLevelSelect.value = app.getReasoningLevelForModel(selectedModel);
      app.syncComposerFooterControls();
    };
  }

  const creditPrioritySelect = document.getElementById('ropilot-credit-priority-select');
  if (creditPrioritySelect) {
    creditPrioritySelect.onchange = () => {
      app.setRopilotCreditsRoutePriority(creditPrioritySelect.value);
    };
  }

  const autoPlaytestControl = document.getElementById('composer-auto-playtest-control');
  if (autoPlaytestControl) {
    autoPlaytestControl.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      app.toggleAutoPlaytest();
    };
  }

  const fastModeControl = document.getElementById('composer-fast-mode-control');
  if (fastModeControl) {
    fastModeControl.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const selectedModel = app.coerceModelForProvider(app.modelProvider, app.selectedModel);
      if (!app.supportsFastModeForModel(selectedModel)) return;
      app.setCodexFastMode(!app.shouldUseFastModeForModel(selectedModel));
    };
  }

  // Managed Fast (Ropilot Credits): click toggles; hover/focus shows the cost
  // popover via CSS, and Escape dismisses it by blurring the control.
  const creditsFastControl = document.getElementById('composer-credits-fast-control');
  if (creditsFastControl) {
    creditsFastControl.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const selectedModel = app.coerceModelForProvider(app.modelProvider, app.selectedModel);
      if (!app.supportsRopilotCreditsFastModeForModel(selectedModel)) return;
      app.setRopilotCreditsFastMode(!app.shouldUseRopilotCreditsFastModeForModel(selectedModel));
    };
    creditsFastControl.onkeydown = (event) => {
      if (event.key === 'Escape') {
        creditsFastControl.blur();
      }
    };
  }

  const codexFastModeCheckbox = document.getElementById('codex-fast-mode-checkbox');
  if (codexFastModeCheckbox) {
    codexFastModeCheckbox.onchange = () => {
      app.setCodexFastMode(codexFastModeCheckbox.checked);
    };
  }

  const codexFastInfoToggle = document.getElementById('codex-fast-info-toggle');
  if (codexFastInfoToggle) {
    codexFastInfoToggle.onclick = () => app.toggleCodexFastInfoTip();
  }

  // Auto playtest toggle
  const autoPlaytestCheckbox = document.getElementById('auto-playtest-checkbox');
  if (autoPlaytestCheckbox) {
    autoPlaytestCheckbox.onchange = () => {
      app.setAutoPlaytest(autoPlaytestCheckbox.checked);
    };
  }
}
