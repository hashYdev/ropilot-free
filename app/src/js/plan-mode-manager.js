// Plan Mode Manager - handles EnterPlanMode, AskUserQuestion, and ExitPlanMode UI/flows
import { formatMessage } from './message-formatter.js';
import { store } from './state-store.js';

const OTHER_OPTION_KEY = '__other__';

export class PlanModeManager {
  constructor(app) {
    this.app = app;
    this.planReviewModalId = 'plan-review-modal';
    this.wizardState = null; // { questions, toolUseId, sessionId, currentIndex, answers: {} }
    this.wizardStates = new Map(); // chatId -> wizardState
    this.ensurePlanReviewModal();
  }

  // =============================================================
  // Incoming server events
  // =============================================================

	  handlePlanModeEnter(sessionId) {
	    if (!this.app.planModeEnabled) return;
	    const chat = this.getChat(sessionId);
    if (!chat) return;

    this.ensureChatPlanState(chat);
    this.ensureTimeline(chat);

    // Auto-approve plan mode entry so users go straight to planning/questions.
    let changed = false;
    for (const item of chat.timeline || []) {
      if (item.type === 'plan_enter' && item.status === 'pending') {
        item.status = 'approved';
        changed = true;
      }
    }

    const sent = this.sendToServer(
      {
        type: 'plan_mode_response',
        session_id: chat.id,
        action: 'approve',
      },
      chat
    );
    if (!sent) {
      if (changed) {
        this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
      }
      return;
    }

    if (!chat.planModeState.active) {
      chat.planModeState.active = true;
      changed = true;
    }
    if (chat.planModeState.statusText !== 'Planning - Researching') {
      chat.planModeState.statusText = 'Planning - Researching';
      changed = true;
    }

    // The Go server already emits "Entered plan mode." as agent_text.
    // Avoid inserting a second local marker here.

    if (changed) {
      this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
    } else if (this.isActiveChat(chat.id)) {
      this.syncComposerDock();
    }
  }

	  handleAskUserQuestion(sessionId, toolUseId, questions) {
	    if (!this.app.planModeEnabled) return;
	    const chat = this.getChat(sessionId);
    if (!chat) return;

    this.ensureChatPlanState(chat);
    this.ensureTimeline(chat);
    chat.planModeState.active = true;
    if (!chat.planModeState.statusText || chat.planModeState.statusText === 'Planning - Complete') {
      chat.planModeState.statusText = 'Planning - Awaiting your answers';
    }

    const normalized = this.normalizeQuestions(questions);
    if (!toolUseId) {
      this.app.addErrorMessageToChat('Plan mode question payload was missing a tool ID.', chat, this.isActiveChat(chat.id));
      return;
    }

    if (normalized.length === 0) {
      // Ignore empty/malformed duplicate question payloads. Auto-submitting empty
      // answers can close the prompt without user interaction.
      const hasExistingPending = (chat.timeline || []).some(
        item => item.type === 'ask_question' && item.status === 'pending' && item.toolUseId === toolUseId
      );
      if (!hasExistingPending) {
        this.app.addErrorMessageToChat(
          'Plan mode question payload was empty. Waiting for a valid question payload.',
          chat,
          this.isActiveChat(chat.id)
        );
      }
      return;
    }

    // Supersede any existing pending questions except this exact tool_use_id.
    let changed = false;
    for (const item of chat.timeline) {
      if (item.type === 'ask_question' && item.status === 'pending' && item.toolUseId !== toolUseId) {
        item.status = 'superseded';
        changed = true;
      }
    }

    // Upsert pending timeline entry so pending state survives rerenders/chat switches.
    let pendingItem = [...chat.timeline]
      .reverse()
      .find(item => item.type === 'ask_question' && item.status === 'pending' && item.toolUseId === toolUseId);

    if (!pendingItem) {
      this.app.addToTimeline(
        {
          type: 'ask_question',
          sessionId: chat.id,
          toolUseId,
          questions: normalized,
          answers: {},
          answerSummary: {},
          draft: {},
          currentIndex: 0,
          status: 'pending',
        },
        chat
      );
      pendingItem = [...chat.timeline]
        .reverse()
        .find(item => item.type === 'ask_question' && item.status === 'pending' && item.toolUseId === toolUseId);
    } else {
      pendingItem.questions = normalized;
      pendingItem.sessionId = chat.id;
      pendingItem.status = 'pending';
      changed = true;
    }

    const nextWizardState = this.buildWizardStateFromPendingItem(chat, pendingItem);
    this.wizardStates.set(chat.id, nextWizardState);
    this.wizardState = this.isActiveChat(chat.id) ? nextWizardState : this.wizardState;

    if (changed) {
      this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
      return;
    }

    if (this.isActiveChat(chat.id)) {
      this.syncComposerDock();
    }
  }

	  handlePlanModeExit(sessionId, planText) {
	    if (!this.app.planModeEnabled) return;
	    const chat = this.getChat(sessionId);
    if (!chat) return;

    this.ensureChatPlanState(chat);
    chat.planModeState.active = true;
    chat.planModeState.statusText = 'Planning - Plan ready for review';

    const resolvedPlanText = typeof planText === 'string' && planText.trim()
      ? planText
      : 'Plan is ready.';

    this.app.addToTimeline(
      {
        type: 'plan_review',
        sessionId: chat.id,
        planText: resolvedPlanText,
        feedback: '',
        collapsed: false,
        status: 'pending',
      },
      chat
    );

    // Render immediately so the plan-review panel is visible before any
    // subsequent assistant text is appended incrementally.
    this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
  }

  handleWorkingHint(sessionId, label, detail) {
    const chat = this.getChat(sessionId);
    if (!chat) return;
    if (!chat.planModeState?.active) return;

    const nextStatusText = detail ? `${label} - ${detail}` : label;
    if (!nextStatusText || nextStatusText === chat.planModeState.statusText) {
      return;
    }

    chat.planModeState.statusText = nextStatusText;

    if (this.isActiveChat(chat.id)) {
      this.syncComposerDock();
    }
  }

  handleSessionFinished(sessionId, reason = 'done') {
    const chat = this.getChat(sessionId);
    if (!chat) return;

    let changed = false;
    const pendingQuestions = (chat.timeline || []).filter(
      item => item.type === 'ask_question' && item.status === 'pending'
    );

    // For normal completion, keep pending question wizards actionable.
    // Claude can emit a terminal event while still waiting for ask_user_answer.
    if (reason === 'done' && pendingQuestions.length > 0) {
      const latestPending = pendingQuestions[pendingQuestions.length - 1];
      if (!this.wizardStates.has(chat.id) || this.wizardStates.get(chat.id)?.toolUseId !== latestPending.toolUseId) {
        const ws = this.buildWizardStateFromPendingItem(chat, latestPending);
        this.wizardStates.set(chat.id, ws);
        if (this.wizardState?.sessionId === chat.id || this.isActiveChat(chat.id)) {
          this.wizardState = ws;
        }
        changed = true;
      }

      this.ensureChatPlanState(chat);
      if (!chat.planModeState.active) {
        chat.planModeState.active = true;
        changed = true;
      }
      if (!chat.planModeState.statusText || chat.planModeState.statusText === 'Planning - Complete') {
        chat.planModeState.statusText = 'Planning - Awaiting your answers';
        changed = true;
      }

      if (changed) {
        this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
      } else if (this.isActiveChat(chat.id)) {
        this.syncComposerDock();
      }
      return;
    }

    // Session ended: any pending questions for this chat are no longer actionable.
    for (const item of chat.timeline || []) {
      if (item.type === 'ask_question' && item.status === 'pending') {
        item.status = 'superseded';
        changed = true;
      }
    }

    if (this.wizardStates.has(chat.id)) {
      this.wizardStates.delete(chat.id);
      if (this.wizardState?.sessionId === chat.id) {
        this.wizardState = null;
      }
      changed = true;
    }

    if (!chat.planModeState?.active) {
      if (changed) {
        this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
      }
      return;
    }

    const hasPendingReview = (chat.timeline || []).some(
      item => item.type === 'plan_review' && item.status === 'pending'
    );
    if (hasPendingReview) {
      if (changed) {
        this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
      }
      return;
    }

    chat.planModeState.active = false;
    chat.planModeState.statusText = 'Planning - Complete';
    changed = true;

    if (changed) {
      this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
    }
  }

  handlePlanModeResponseDesynced(sessionId) {
    const chat = this.getChat(sessionId);
    if (!chat) return;

    this.ensureChatPlanState(chat);
    this.ensureTimeline(chat);

    let changed = false;
    for (const item of chat.timeline || []) {
      if (item.type === 'plan_enter' && item.status === 'pending') {
        item.status = 'superseded';
        changed = true;
      }
      if (item.type === 'plan_review' && item.status === 'pending') {
        item.status = 'superseded';
        item.collapsed = true;
        delete item.proposeInChat;
        changed = true;
      }
    }

    if (this.wizardStates.has(chat.id)) {
      this.wizardStates.delete(chat.id);
      if (this.wizardState?.sessionId === chat.id) {
        this.wizardState = null;
      }
      changed = true;
    }

    if (chat.planModeState.active || chat.planModeState.statusText !== 'Planning - Complete') {
      chat.planModeState.active = false;
      chat.planModeState.statusText = 'Planning - Complete';
      changed = true;
    }

    if (changed) {
      this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
    } else if (this.isActiveChat(chat.id)) {
      this.syncComposerDock();
    }
  }

  handleAssistantOutput(sessionId, text = '') {
    const chat = this.getChat(sessionId);
    if (!chat) return;

    this.ensureChatPlanState(chat);
    this.ensureTimeline(chat);

    const pendingQuestions = (chat.timeline || []).filter(
      item => item.type === 'ask_question' && item.status === 'pending'
    );

    const normalizedText = typeof text === 'string' ? text.trim().toLowerCase() : '';
    const likelyDismissal =
      normalizedText.includes('dismissed') ||
      normalizedText.includes('timed out') ||
      normalizedText.includes('timeout');

    let changed = false;
    const isProcessing = this.app.isChatProcessing(chat.id);

    // If Claude emitted follow-up text while questions are still pending,
    // those pending prompts are no longer actionable in the wizard.
    if (pendingQuestions.length > 0 && (likelyDismissal || !isProcessing)) {
      for (const item of pendingQuestions) {
        item.status = 'superseded';
      }
      changed = true;

      if (this.wizardStates.has(chat.id)) {
        this.wizardStates.delete(chat.id);
      }
      if (this.wizardState?.sessionId === chat.id) {
        this.wizardState = null;
      }
    }

    const hasPendingPlanEnter = (chat.timeline || []).some(
      item => item.type === 'plan_enter' && item.status === 'pending'
    );
    const hasPendingReview = (chat.timeline || []).some(
      item => item.type === 'plan_review' && item.status === 'pending'
    );
    const hasPendingQuestions = (chat.timeline || []).some(
      item => item.type === 'ask_question' && item.status === 'pending'
    );
    const shouldKeepPlanActive = isProcessing || hasPendingPlanEnter || hasPendingReview || hasPendingQuestions;

    if (chat.planModeState.active && !shouldKeepPlanActive) {
      chat.planModeState.active = false;
      chat.planModeState.statusText = 'Planning - Complete';
      changed = true;
    }

    if (changed) {
      this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
    }
  }

  // =============================================================
  // Rendering
  // =============================================================

  renderStatusPill(chat) {
    if (!chat?.planModeState?.active) return null;

    const pill = document.createElement('div');
    pill.className = 'plan-status-pill';

    const dot = document.createElement('span');
    dot.className = 'plan-status-dot';

    const text = document.createElement('span');
    text.className = 'plan-status-label';
    text.textContent = 'IN PLAN MODE';
    pill.appendChild(dot);
    pill.appendChild(text);
    return pill;
  }

  getWizardComposerKey(ws) {
    if (!ws) return '';
    const question = ws.questions?.[ws.currentIndex] || {};
    const optionsKey = (question.options || [])
      .map(option => `${option.label || ''}:${option.description || ''}`)
      .join('|');
    return [
      'wizard',
      ws.sessionId || '',
      ws.toolUseId || '',
      String(ws.currentIndex || 0),
      String(ws.questions?.length || 0),
      question.header || '',
      question.question || '',
      question.multiSelect ? 'multi' : 'single',
      optionsKey,
    ].join('\u001f');
  }

  getPlanReviewComposerKey(item) {
    if (!item) return '';
    return [
      'review',
      item.sessionId || '',
      item.id || '',
      item.status || '',
      item.planText || '',
      item.proposeInChat ? 'inline' : 'composer',
    ].join('\u001f');
  }

  syncPlanStatusPill(pillSlot, inputArea, chat, visible) {
    if (!pillSlot || !inputArea) return;

    if (!visible) {
      pillSlot.innerHTML = '';
      pillSlot.classList.remove('visible');
      inputArea.classList.remove('plan-mode-active');
      return;
    }

    if (!pillSlot.querySelector('.plan-status-pill')) {
      const pill = this.renderStatusPill(chat);
      if (pill) {
        pillSlot.appendChild(pill);
      }
    }

    pillSlot.classList.add('visible');
    inputArea.classList.add('plan-mode-active');
  }

  renderStableComposerPanel(slot, key, classNames, render) {
    const existingPanel = slot.firstElementChild;
    const isSamePanel = existingPanel?.dataset?.planComposerKey === key;

    slot.classList.remove('replace-chatbar');
    slot.classList.add('visible');
    for (const className of classNames) {
      slot.classList.add(className);
    }

    if (isSamePanel) {
      return existingPanel;
    }

    slot.innerHTML = '';
    const panel = render();
    if (!panel) {
      slot.classList.remove('visible', 'replace-chatbar');
      return null;
    }
    panel.dataset.planComposerKey = key;
    slot.appendChild(panel);
    return panel;
  }

  clearComposerPanel(slot) {
    if (!slot) return;
    slot.classList.remove('visible', 'replace-chatbar');
    slot.innerHTML = '';
  }

  syncComposerDock() {
    const slot = document.getElementById('plan-mode-composer-slot');
    const pillSlot = document.getElementById('plan-mode-pill-slot');
    const inputArea = document.querySelector('.input-area');
    const inputOptionsRow = document.querySelector('.input-area .input-options-row');
    const inputRow = document.querySelector('.input-area .input-row');
    const inputInfo = document.querySelector('.input-area .input-info');
    const slashMenu = document.getElementById('slash-command-menu');
    if (!slot || !pillSlot || !inputRow || !inputArea || !inputInfo) return;

    const activeChat = store.getActiveChat();

    if (!activeChat?.timeline) {
      this.clearComposerPanel(slot);
      this.syncPlanStatusPill(pillSlot, inputArea, activeChat, false);
      inputOptionsRow?.classList.remove('hidden-by-plan-mode');
      inputRow.classList.remove('hidden-by-plan-mode');
      inputInfo.classList.remove('hidden-by-plan-mode');
      slashMenu?.classList.remove('hidden-by-plan-mode');
      this.scheduleComposerClearanceRefresh();
      return;
    }

    this.ensureChatPlanState(activeChat);
    this.ensureTimeline(activeChat);

    const pendingQuestionItem = [...activeChat.timeline]
      .reverse()
      .find(item => item.type === 'ask_question' && item.status === 'pending');

    const hasPendingReview = (activeChat.timeline || []).some(
      item => item.type === 'plan_review' && item.status === 'pending'
    );
    const pendingReviewItem = [...activeChat.timeline]
      .reverse()
      .find(item => item.type === 'plan_review' && item.status === 'pending');

    let activeWizardState = this.wizardStates.get(activeChat.id) || null;
    if (pendingQuestionItem && (!activeWizardState || activeWizardState.toolUseId !== pendingQuestionItem.toolUseId)) {
      activeWizardState = this.buildWizardStateFromPendingItem(activeChat, pendingQuestionItem);
      this.wizardStates.set(activeChat.id, activeWizardState);
    } else if (!pendingQuestionItem && activeWizardState) {
      this.wizardStates.delete(activeChat.id);
      activeWizardState = null;
    }

    this.wizardState = activeWizardState;

    const isProcessing = this.app.isChatProcessing(activeChat.id);
    const shouldShowPlanPill = !!activeChat.planModeState?.active && (
      isProcessing || !!pendingQuestionItem || hasPendingReview
    );

    this.syncPlanStatusPill(pillSlot, inputArea, activeChat, shouldShowPlanPill);

    const shouldReplaceForPlanReview = !!pendingReviewItem && !pendingReviewItem.proposeInChat;
    if (shouldReplaceForPlanReview) {
      this.stashComposerInputForChat(activeChat.id);
      inputOptionsRow?.classList.add('hidden-by-plan-mode');
      inputRow.classList.add('hidden-by-plan-mode');
      inputInfo.classList.add('hidden-by-plan-mode');
      slashMenu?.classList.add('hidden-by-plan-mode');
      this.renderStableComposerPanel(
        slot,
        this.getPlanReviewComposerKey(pendingReviewItem),
        ['replace-chatbar'],
        () => this.renderPlanExecutionPrompt(pendingReviewItem)
      );
      this.app.messageSender.updateButton();
      this.scheduleComposerClearanceRefresh();
      return;
    }

    this.restoreComposerInputForChat(activeChat.id);

    // Wizard mode takes priority — show the question wizard in the composer.
    if (activeWizardState && activeWizardState.sessionId === activeChat.id) {
      inputOptionsRow?.classList.add('hidden-by-plan-mode');
      inputRow.classList.add('hidden-by-plan-mode');
      inputInfo.classList.add('hidden-by-plan-mode');
      slashMenu?.classList.add('hidden-by-plan-mode');
      this.renderStableComposerPanel(
        slot,
        this.getWizardComposerKey(activeWizardState),
        [],
        () => this.renderComposerWizard(activeWizardState)
      );
      this.app.messageSender.updateButton();
      this.scheduleComposerClearanceRefresh();
      return;
    }

    this.clearComposerPanel(slot);
    inputOptionsRow?.classList.remove('hidden-by-plan-mode');
    inputRow.classList.remove('hidden-by-plan-mode');
    inputInfo.classList.remove('hidden-by-plan-mode');
    slashMenu?.classList.remove('hidden-by-plan-mode');

    if (activeChat.planModeState?.active && !shouldShowPlanPill) {
      activeChat.planModeState.active = false;
      activeChat.planModeState.statusText = 'Planning - Complete';
      this.app.projectManager.markChatForFullUpdate(activeChat.id);
      this.app.saveChats();
    }
    this.scheduleComposerClearanceRefresh();
  }

  renderComposerWizard(ws) {
    if (!ws || !ws.questions.length) return null;

    const question = ws.questions[ws.currentIndex];
    if (!question) return null;
    const draft = ws.drafts[question.question] || { selected: [], other: '' };
    ws.drafts[question.question] = draft;
    const totalSteps = ws.questions.length;
    const isFirst = ws.currentIndex === 0;
    const isLast = ws.currentIndex === totalSteps - 1;

    let nextBtnRef = null; // forward ref for local UI updates
    let otherInputRef = null;
    const optionBindings = [];
    const autosizeOtherInput = () => {
      if (!otherInputRef) return;
      otherInputRef.style.height = '0px';
      otherInputRef.style.height = `${otherInputRef.scrollHeight}px`;
    };
    const refreshSelectionUI = () => {
      optionBindings.forEach(({ optionValue, optionEl, indicator }) => {
        const isSelected = draft.selected.includes(optionValue);
        optionEl.classList.toggle('selected', isSelected);
        indicator.textContent = this.getOptionIndicatorSymbol(question.multiSelect, isSelected);
      });

      const otherSelected = draft.selected.includes(OTHER_OPTION_KEY);
      if (otherInputRef) {
        otherInputRef.classList.toggle('visible', otherSelected);
        if (otherSelected) {
          requestAnimationFrame(autosizeOtherInput);
        }
      }

      if (nextBtnRef) {
        const canProceed = draft.selected.length > 0 &&
          !(otherSelected && !draft.other.trim());
        nextBtnRef.disabled = !canProceed;
      }
    };

    const wizard = document.createElement('div');
    wizard.className = 'question-wizard';

    // — Header: progress dots + cancel —
    const header = document.createElement('div');
    header.className = 'question-wizard-header';

    const progress = document.createElement('div');
    progress.className = 'question-wizard-progress';
    for (let i = 0; i < totalSteps; i++) {
      if (i > 0) {
        const connector = document.createElement('span');
        connector.className = 'qw-step-connector';
        if (i <= ws.currentIndex) connector.classList.add('done');
        progress.appendChild(connector);
      }
      const step = document.createElement('span');
      step.className = 'qw-step';
      if (i < ws.currentIndex) step.classList.add('completed');
      else if (i === ws.currentIndex) step.classList.add('active');
      else step.classList.add('upcoming');
      step.textContent = String(i + 1);
      progress.appendChild(step);
    }
    header.appendChild(progress);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'question-wizard-cancel';
    cancelBtn.type = 'button';
    cancelBtn.title = 'Cancel';
    cancelBtn.textContent = '\u2715';
    cancelBtn.addEventListener('click', () => this.cancelWizard(ws));
    header.appendChild(cancelBtn);

    wizard.appendChild(header);

    // — Body: chip, question text, options —
    const body = document.createElement('div');
    body.className = 'question-wizard-body';

    const chip = document.createElement('div');
    chip.className = 'qw-chip';
    chip.textContent = question.header || 'Question';
    body.appendChild(chip);

    const questionText = document.createElement('div');
    questionText.className = 'qw-question';
    questionText.textContent = question.question;
    body.appendChild(questionText);

    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'qw-options';

    // Build option list with "Other..." appended
    const allOptions = [
      ...question.options,
      { label: 'Other...', description: '', isOther: true },
    ];

    allOptions.forEach(option => {
      const optionValue = option.isOther ? OTHER_OPTION_KEY : option.label;
      const selected = draft.selected.includes(optionValue);

      const optionEl = document.createElement('div');
      optionEl.className = 'qw-option';
      if (selected) optionEl.classList.add('selected');
      if (option.isOther) optionEl.classList.add('qw-option-other');

      const indicator = document.createElement('span');
      indicator.className = 'qw-indicator';
      indicator.textContent = this.getOptionIndicatorSymbol(question.multiSelect, selected);
      optionEl.appendChild(indicator);
      optionBindings.push({ optionValue, optionEl, indicator });

      const content = document.createElement('div');
      content.className = 'qw-option-content';

      const label = document.createElement('div');
      label.className = 'qw-option-label';
      label.textContent = option.label;
      content.appendChild(label);

      if (option.description) {
        const desc = document.createElement('div');
        desc.className = 'qw-option-description';
        desc.textContent = option.description;
        content.appendChild(desc);
      }

      optionEl.appendChild(content);
      optionEl.tabIndex = 0;
      optionEl.setAttribute('role', 'button');

      if (option.isOther) {
        const otherInput = document.createElement('textarea');
        otherInput.className = 'qw-other-input';
        if (draft.selected.includes(OTHER_OPTION_KEY)) {
          otherInput.classList.add('visible');
        }
        otherInput.placeholder = 'Type your answer...';
        otherInput.rows = 1;
        otherInput.value = draft.other || '';
        otherInputRef = otherInput;
        autosizeOtherInput();
        otherInput.addEventListener('input', () => {
          draft.other = otherInput.value;
          autosizeOtherInput();
          refreshSelectionUI();
        });
        content.appendChild(otherInput);
      }

      optionEl.addEventListener('click', (e) => {
        // Don't toggle if click originated from the textarea.
        if (e.target.closest('textarea')) return;
        if (question.multiSelect) {
          if (draft.selected.includes(optionValue)) {
            draft.selected = draft.selected.filter(v => v !== optionValue);
          } else {
            draft.selected = [...draft.selected, optionValue];
          }
        } else {
          draft.selected = [optionValue];
        }
        this.syncWizardStateToTimeline(ws);
        refreshSelectionUI();
      });

      optionEl.addEventListener('keydown', (e) => {
        if (e.target.closest('textarea')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          optionEl.click();
        }
      });

      optionsContainer.appendChild(optionEl);
    });

    body.appendChild(optionsContainer);

    wizard.appendChild(body);

    // — Footer: Back / Next|Submit —
    const footer = document.createElement('div');
    footer.className = 'question-wizard-footer';

    const backBtn = document.createElement('button');
    backBtn.className = 'qw-back';
    backBtn.type = 'button';
    backBtn.textContent = 'Back';
    backBtn.disabled = isFirst;
    backBtn.addEventListener('click', () => {
      if (ws.currentIndex > 0) {
        ws.currentIndex--;
        this.syncWizardStateToTimeline(ws);
        this.syncComposerDock();
      }
    });

    const nextBtn = document.createElement('button');
    nextBtn.className = 'qw-next';
    nextBtn.type = 'button';
    nextBtn.textContent = isLast ? 'Submit Answers' : 'Next';
    nextBtnRef = nextBtn;
    refreshSelectionUI();

    nextBtn.addEventListener('click', () => {
      // Save the current question's answer
      this.saveWizardAnswer(ws, question, draft);

      if (isLast) {
        this.submitWizard(ws);
      } else {
        ws.currentIndex++;
        this.syncWizardStateToTimeline(ws);
        this.syncComposerDock();
      }
    });

    footer.appendChild(backBtn);
    footer.appendChild(nextBtn);
    wizard.appendChild(footer);

    return wizard;
  }

  saveWizardAnswer(ws, question, draft) {
    const selected = draft.selected
      .map(v => (v === OTHER_OPTION_KEY ? draft.other.trim() : v))
      .filter(Boolean);
    const answer = question.multiSelect ? selected.join(', ') : (selected[0] || '');

    ws.answers[question.question] = answer;
    ws.answerSummary[question.question] = {
      selectedOptions: selected,
      otherText: draft.selected.includes(OTHER_OPTION_KEY) ? draft.other.trim() : '',
      note: '',
    };
  }

  submitWizard(ws = this.wizardState) {
    if (!ws) return;

    // Re-save all answers from drafts to handle back-navigation edits.
    for (const q of ws.questions) {
      const draft = ws.drafts[q.question];
      if (draft) {
        this.saveWizardAnswer(ws, q, draft);
      }
    }

    const chat = this.getChat(ws.sessionId);
    if (!chat) return;

    const sent = this.sendToServer(
      {
        type: 'ask_user_answer',
        session_id: chat.id,
        tool_use_id: ws.toolUseId,
        answers: ws.answers,
      },
      chat
    );
    if (!sent) return;

    // Convert matching pending question entry to answered summary.
    const pendingItem = [...(chat.timeline || [])]
      .reverse()
      .find(item => item.type === 'ask_question' && item.status === 'pending' && item.toolUseId === ws.toolUseId);

    if (pendingItem) {
      pendingItem.questions = ws.questions;
      pendingItem.answers = { ...ws.answers };
      pendingItem.answerSummary = { ...ws.answerSummary };
      pendingItem.draft = {};
      pendingItem.status = 'answered';
      pendingItem.submittedAt = Date.now();
      pendingItem.currentIndex = 0;
      this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
    } else {
      this.app.addToTimeline(
        {
          type: 'ask_question',
          sessionId: chat.id,
          toolUseId: ws.toolUseId,
          questions: ws.questions,
          answers: ws.answers,
          answerSummary: ws.answerSummary,
          draft: {},
          status: 'answered',
          submittedAt: Date.now(),
        },
        chat
      );
    }

    this.wizardStates.delete(chat.id);
    if (this.wizardState?.sessionId === chat.id) {
      this.wizardState = null;
    }
    if (this.isActiveChat(chat.id)) {
      this.syncComposerDock();
    }
  }

  cancelWizard(ws = this.wizardState) {
    if (!ws) return;

    const chat = this.getChat(ws.sessionId);
    if (!chat) return;

    // Send empty answers to unblock Claude
    const sent = this.sendToServer(
      {
        type: 'ask_user_answer',
        session_id: chat.id,
        tool_use_id: ws.toolUseId,
        answers: {},
      },
      chat
    );
    if (!sent) return;

    const pendingItem = [...(chat.timeline || [])]
      .reverse()
      .find(item => item.type === 'ask_question' && item.status === 'pending' && item.toolUseId === ws.toolUseId);

    if (pendingItem) {
      pendingItem.questions = ws.questions;
      pendingItem.answers = {};
      pendingItem.answerSummary = {};
      pendingItem.draft = {};
      pendingItem.status = 'cancelled';
      pendingItem.currentIndex = 0;
      this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
    } else {
      this.app.addToTimeline(
        {
          type: 'ask_question',
          sessionId: chat.id,
          toolUseId: ws.toolUseId,
          questions: ws.questions,
          answers: {},
          answerSummary: {},
          draft: {},
          status: 'cancelled',
        },
        chat
      );
    }

    this.wizardStates.delete(chat.id);
    if (this.wizardState?.sessionId === chat.id) {
      this.wizardState = null;
    }
    if (this.isActiveChat(chat.id)) {
      this.syncComposerDock();
    }
  }

  renderPlanEnter(item) {
    const panel = document.createElement('div');
    panel.className = 'plan-banner';

    if (item.status === 'approved') {
      panel.classList.add('done');
      panel.innerHTML = `
        <div class="plan-banner-head">
          <span class="plan-badge">PLAN MODE</span>
        </div>
        <div class="plan-banner-text">Planning approved.</div>
      `;
      return panel;
    }

    if (item.status === 'skipped') {
      panel.classList.add('done');
      panel.innerHTML = `
        <div class="plan-banner-head">
          <span class="plan-badge">PLAN MODE</span>
        </div>
        <div class="plan-banner-text">Planning skipped.</div>
      `;
      return panel;
    }

    panel.innerHTML = `
      <div class="plan-banner-head">
        <span class="plan-badge">PLAN MODE</span>
      </div>
      <div class="plan-banner-text">Claude wants to research and plan before making changes.</div>
      <div class="plan-banner-actions">
        <button class="btn-primary" type="button">Allow Planning</button>
        <button class="btn-secondary" type="button">Skip</button>
      </div>
    `;

    const [allowBtn, skipBtn] = panel.querySelectorAll('button');
    allowBtn?.addEventListener('click', () => this.respondToPlanEnter(item, 'approve'));
    skipBtn?.addEventListener('click', () => this.respondToPlanEnter(item, 'reject'));

    return panel;
  }

  renderAskQuestion(item, isLatestPending) {
    const panel = document.createElement('div');
    panel.className = 'question-panel';

    if (item.status === 'answered') panel.classList.add('completed');
    if (item.status === 'superseded') panel.classList.add('completed');
    if (item.status === 'cancelled') panel.classList.add('completed');

    const questions = Array.isArray(item.questions) ? item.questions : [];

    // Pending questions are now handled by the composer wizard — don't render interactive UI here.
    // Only render read-only views for answered/superseded/cancelled items.

    if (questions.length === 0) {
      const text = document.createElement('div');
      text.className = 'question-status';
      text.textContent = 'Question prompt received with no options.';
      panel.appendChild(text);
      return panel;
    }

    questions.forEach((question, index) => {
      if (index > 0) {
        const separator = document.createElement('div');
        separator.className = 'question-separator';
        panel.appendChild(separator);
      }

      const element = this.createReadonlyQuestionBlock(item, question);
      panel.appendChild(element);
    });

    if (item.status === 'answered') {
      const submitted = document.createElement('button');
      submitted.type = 'button';
      submitted.className = 'question-submit submitted';
      submitted.textContent = 'Submitted (done)';
      submitted.disabled = true;
      panel.appendChild(submitted);
    } else if (item.status === 'cancelled') {
      const cancelled = document.createElement('div');
      cancelled.className = 'question-status';
      cancelled.textContent = 'Question was cancelled.';
      panel.appendChild(cancelled);
    } else if (item.status === 'superseded' || item.status === 'pending') {
      const locked = document.createElement('div');
      locked.className = 'question-status';
      locked.textContent = 'This question is no longer active.';
      panel.appendChild(locked);
    }

    return panel;
  }

  renderPlanReview(item) {
    const panel = document.createElement('div');
    panel.className = 'plan-review';

    const title = document.createElement('div');
    title.className = 'plan-review-title';
    title.textContent = item.status === 'pending' ? 'Plan Ready For Review' : 'Plan Review';
    panel.appendChild(title);

    if (item.status === 'pending') {
      const content = document.createElement('div');
      content.className = 'plan-review-content';
      content.innerHTML = formatMessage(item.planText || 'Plan is ready.');
      panel.appendChild(content);
      return panel;
    }

    const isThreadStarted = item.status === 'thread_started';
    const isApproved = item.status === 'approved' || isThreadStarted;
    const isInactive = item.status === 'superseded' || item.status === 'cancelled';
    panel.classList.add(isApproved ? 'approved' : isInactive ? 'done' : 'rejected');
    if (isThreadStarted) {
      panel.classList.add('thread-started');
    }
    const collapsed = item.collapsed !== false;

    const summary = document.createElement('div');
    summary.className = 'plan-review-summary';

    const summaryText = document.createElement('span');
    if (isThreadStarted) {
      summaryText.textContent = 'Plan moved to a new thread for implementation';
    } else if (isInactive) {
      summaryText.textContent = 'Plan review is no longer active';
    } else {
      summaryText.textContent = isApproved ? 'Plan approved' : 'Plan revision requested';
    }
    summary.appendChild(summaryText);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn-secondary plan-review-toggle';
    toggleBtn.textContent = collapsed ? 'Review Plan' : 'Hide Plan';
    toggleBtn.addEventListener('click', () => {
      item.collapsed = !collapsed;
      const chat = this.getChat(item.sessionId);
      if (chat) {
        this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
      }
    });
    summary.appendChild(toggleBtn);

    panel.appendChild(summary);

    if (!collapsed) {
      const content = document.createElement('div');
      content.className = 'plan-review-content';
      content.innerHTML = formatMessage(item.planText || 'Plan is ready.');
      panel.appendChild(content);

      if (item.feedback) {
        const feedback = document.createElement('div');
        feedback.className = 'plan-review-final-feedback';
        feedback.textContent = `Feedback: ${item.feedback}`;
        panel.appendChild(feedback);
      }
    }

    return panel;
  }

  getLatestPendingQuestionId(chat) {
    if (!chat?.timeline) return null;
    for (let i = chat.timeline.length - 1; i >= 0; i--) {
      const item = chat.timeline[i];
      if (item.type === 'ask_question' && item.status === 'pending') {
        return item.id;
      }
    }
    return null;
  }

  // =============================================================
  // Interactive action handlers
  // =============================================================

  respondToPlanEnter(item, action) {
    const chat = this.getChat(item.sessionId);
    if (!chat) return;

    const wsAction = action === 'approve' ? 'approve' : 'reject';
    const sent = this.sendToServer(
      {
        type: 'plan_mode_response',
        session_id: chat.id,
        action: wsAction,
      },
      chat
    );
    if (!sent) return;

    this.ensureChatPlanState(chat);
    item.status = action === 'approve' ? 'approved' : 'skipped';

    if (action === 'approve') {
      chat.planModeState.active = true;
      chat.planModeState.statusText = 'Planning - Researching';
    } else {
      chat.planModeState.active = false;
      chat.planModeState.statusText = 'Planning skipped';
    }

    this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
  }

  finalizePlanReview(item, action, feedback) {
    const chat = this.getChat(item.sessionId);
    if (!chat) return false;

    item.status = action === 'approve' ? 'approved' : 'rejected';
    item.feedback = feedback || '';
    item.collapsed = true;
    delete item.proposeInChat;

    this.ensureChatPlanState(chat);
    chat.planModeState.active = false;
    chat.planModeState.statusText = action === 'approve' ? 'Planning complete' : 'Planning revised';

    this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
    return true;
  }

  acknowledgePlanReviewDecision(chat, action, feedback = '') {
    if (!chat?.id) return false;
    const wsAction = action === 'reject' ? 'reject' : 'approve';
    return this.sendToServer(
      {
        type: 'plan_mode_response',
        session_id: chat.id,
        action: wsAction,
        feedback: typeof feedback === 'string' ? feedback : '',
      },
      chat
    );
  }

  clearWorkingStateForChat(chat) {
    if (!chat?.id) return;
    const chatId = chat.id;
    const isActive = this.isActiveChat(chatId);
    const wasProcessing = this.app.isChatProcessing(chatId);

    if (isActive && wasProcessing) {
      this.app.messageSender.stopInference();
      return;
    }

    if (wasProcessing) {
      this.app.stopProcessingChat(chatId);

      if (this.app.messageQueues?.has(chatId)) {
        this.app.messageQueues.delete(chatId);
        this.app.updateQueueIndicator();
      }

      this.app.wsManager.send({
        type: 'stop',
        session_id: chatId,
      });
    }

    if (isActive) {
      this.app.hideStatus();
      this.app.updateSendButton();
    } else if (wasProcessing) {
      this.app.finalizeStatusInChat(chatId);
    }

    this.app.renderProjectList();
  }

  startImplementationInCurrentThread(item) {
    const chat = this.getChat(item.sessionId);
    if (!chat) return;
    const acknowledged = this.acknowledgePlanReviewDecision(chat, 'approve');
    if (!acknowledged) return;
    this.clearWorkingStateForChat(chat);

    const finalized = this.finalizePlanReview(
      item,
      'approve',
      'Proceed with implementation in this thread.'
    );
    if (!finalized) return;

    const implementationPrompt = this.buildCurrentThreadImplementationPrompt(item.planText || '');
    this.app.messageSender.sendContentToChat(implementationPrompt, chat, false, [], {
      userBubbleVariant: 'plan',
    });
  }

  startNewThreadAndImplementPlan(item) {
    const sourceChat = this.getChat(item.sessionId);
    if (!sourceChat) return;
    const acknowledged = this.acknowledgePlanReviewDecision(sourceChat, 'approve');
    if (!acknowledged) return;
    this.clearWorkingStateForChat(sourceChat);

    const sourceProject = this.app.projects.find(project =>
      Array.isArray(project?.chats) && project.chats.some(chat => chat.id === sourceChat.id)
    );
    if (!sourceProject) {
      this.app.addErrorMessageToChat('Unable to start implementation thread: source project was not found.', sourceChat, this.isActiveChat(sourceChat.id));
      return;
    }

    const finalized = this.finalizePlanReview(
      item,
      'approve',
      'Proceeding in a new thread to keep implementation context clean.'
    );
    if (!finalized) return;

    item.status = 'thread_started';
    item.feedback = 'Execution moved to a new thread.';
    this.app.addToTimeline(
      {
        type: 'raw_html',
        subtype: 'plan_notice',
        html: '<strong>Plan implementation started in new chat.</strong>',
      },
      sourceChat
    );
    this.persistChatMutation(sourceChat, { rerender: this.isActiveChat(sourceChat.id) });

    // If Claude starts executing in the old thread after approval, stop it immediately.
    this.app.wsManager.send({
      type: 'stop',
      session_id: sourceChat.id,
    });

    this.app.chatManager.createInProject(sourceProject.id);
    const implementationChat = this.app.activeChat;
    if (!implementationChat) {
      this.app.addErrorMessageToChat('Implementation thread could not be created.', sourceChat, this.isActiveChat(sourceChat.id));
      return;
    }

    // Starting fresh implementation should always restore the normal composer UI.
    this.restoreDefaultComposerChrome();
    this.syncComposerDock();

    const implementationPrompt = this.buildNewThreadImplementationPrompt(item.planText || '');
    this.app.messageSender.sendContentToChat(implementationPrompt, implementationChat, false, [], {
      userBubbleVariant: 'plan',
    });
  }

  renderPlanExecutionPrompt(item) {
    if (!item || item.status !== 'pending') return null;

    const prompt = document.createElement('div');
    prompt.className = 'plan-execution-prompt';

    const promptTitle = document.createElement('div');
    promptTitle.className = 'plan-execution-title';
    promptTitle.textContent = 'Ropilot has written up a plan and is ready to execute. Would you like to proceed?';
    prompt.appendChild(promptTitle);

    const optionOne = document.createElement('button');
    optionOne.type = 'button';
    optionOne.className = 'plan-execution-option recommended';
    optionOne.textContent = '1. Implement plan in a new thread (clear context)';
    optionOne.addEventListener('click', () => this.startNewThreadAndImplementPlan(item));
    prompt.appendChild(optionOne);

    const optionTwo = document.createElement('button');
    optionTwo.type = 'button';
    optionTwo.className = 'plan-execution-option';
    optionTwo.textContent = '2. Implement plan in this thread';
    optionTwo.addEventListener('click', () => this.startImplementationInCurrentThread(item));
    prompt.appendChild(optionTwo);

    const optionThree = document.createElement('button');
    optionThree.type = 'button';
    optionThree.className = 'plan-execution-option';
    optionThree.textContent = '3. Propose Changes';
    optionThree.addEventListener('click', () => this.enterPlanProposeMode(item));
    prompt.appendChild(optionThree);

    return prompt;
  }

  buildNewThreadImplementationPrompt(planText) {
    const normalizedPlan = typeof planText === 'string' && planText.trim()
      ? planText.trim()
      : 'Plan is ready.';

    return [
      'Implement this approved plan in this new thread.',
      'Follow the plan step-by-step and execute it now.',
      'Treat permissions as pre-approved unless a hard blocker requires explicit confirmation.',
      'If a step is unclear, state the assumption briefly and continue.',
      '',
      'Approved plan:',
      normalizedPlan,
    ].join('\n');
  }

  buildCurrentThreadImplementationPrompt(planText) {
    const normalizedPlan = typeof planText === 'string' && planText.trim()
      ? planText.trim()
      : 'Plan is ready.';

    return [
      'Implement this approved plan in this thread now.',
      'Follow the plan step-by-step and execute it.',
      'Treat permissions as pre-approved unless a hard blocker requires explicit confirmation.',
      'If a step is unclear, state the assumption briefly and continue.',
      '',
      'Approved plan:',
      normalizedPlan,
    ].join('\n');
  }

  buildPlanRevisionPrompt(planText, feedback) {
    const normalizedPlan = typeof planText === 'string' && planText.trim()
      ? planText.trim()
      : 'Plan is ready.';
    const normalizedFeedback = typeof feedback === 'string' && feedback.trim()
      ? feedback.trim()
      : 'Please revise the plan.';

    return [
      'Revise the plan based on this feedback. Do not implement yet.',
      '',
      'Original plan:',
      normalizedPlan,
      '',
      'Requested changes:',
      normalizedFeedback,
    ].join('\n');
  }

  enterPlanProposeMode(item) {
    if (!item || !item.sessionId) return;
    const chat = this.getChat(item.sessionId);
    if (!chat) return;
    this.clearWorkingStateForChat(chat);

    item.proposeInChat = true;
    this.persistChatMutation(chat, { rerender: this.isActiveChat(chat.id) });
  }

  submitProposedPlanChanges(sessionId, feedbackText) {
    const chat = this.getChat(sessionId);
    if (!chat?.timeline) {
      return { handled: false, success: false };
    }

    const pendingReview = [...chat.timeline]
      .reverse()
      .find(item => item.type === 'plan_review' && item.status === 'pending');
    if (!pendingReview || !pendingReview.proposeInChat) {
      return { handled: false, success: false };
    }

    const feedback = typeof feedbackText === 'string' ? feedbackText.trim() : '';
    if (!feedback) {
      return { handled: true, success: false };
    }

    const acknowledged = this.acknowledgePlanReviewDecision(chat, 'reject', feedback);
    if (!acknowledged) {
      return { handled: true, success: false };
    }

    this.clearWorkingStateForChat(chat);

    const success = this.finalizePlanReview(pendingReview, 'reject', feedback);
    if (!success) {
      return { handled: true, success: false };
    }

    const revisionPrompt = this.buildPlanRevisionPrompt(pendingReview.planText || '', feedback);
    this.app.messageSender.sendContentToChat(revisionPrompt, chat, false, []);
    return { handled: true, success: true };
  }

  stashComposerInputForChat(chatId) {
    if (!chatId) return;
    const input = document.getElementById('input-message');
    if (!input) return;
    const text = input.value || '';
    if (!text.trim()) return;

    if (this.app.promptStash.get(chatId) !== text) {
      this.app.promptStash.set(chatId, text);
      this.app.markPromptStashDirty();
    }
  }

  restoreComposerInputForChat(chatId) {
    if (!chatId) return;
    const input = document.getElementById('input-message');
    if (!input) return;
    if (input.value && input.value.trim()) return;

    const stashed = this.app.promptStash.get(chatId) || '';
    if (!stashed) return;
    input.value = stashed;
    this.app.autoResizeTextarea(input);
    this.app.messageSender.updateButton();
  }

  // =============================================================
  // Question UI builders
  // =============================================================

  createReadonlyQuestionBlock(item, question) {
    const element = document.createElement('div');
    element.className = 'question-block readonly';

    const header = document.createElement('div');
    header.className = 'question-header';
    const chip = document.createElement('span');
    chip.className = 'question-chip';
    chip.textContent = question.header || 'Question';
    const text = document.createElement('span');
    text.className = 'question-text';
    text.textContent = question.question;
    header.appendChild(chip);
    header.appendChild(text);
    element.appendChild(header);

    const summary = this.getQuestionAnswerSummary(item, question);
    const selectedSet = new Set(summary.selectedOptions || []);
    const knownOptionLabels = new Set((question.options || []).map(option => option.label));

    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'question-options';
    element.appendChild(optionsContainer);

    const allOptions = [
      ...(question.options || []),
      { label: 'Other...', description: '', isOther: true },
    ];

    allOptions.forEach(option => {
      const selected = option.isOther
        ? (summary.otherText && !knownOptionLabels.has(summary.otherText))
        : selectedSet.has(option.label);

      const card = document.createElement('div');
      card.className = `option-card readonly ${selected ? 'selected' : ''}`;

      const indicator = document.createElement('span');
      indicator.className = `option-indicator ${question.multiSelect ? 'option-checkbox' : 'option-radio'}`;
      indicator.textContent = this.getOptionIndicatorSymbol(question.multiSelect, selected);

      const content = document.createElement('div');
      content.className = 'option-content';

      const label = document.createElement('div');
      label.className = 'option-label';
      label.textContent = option.label;
      content.appendChild(label);

      if (option.description) {
        const desc = document.createElement('div');
        desc.className = 'option-desc';
        desc.textContent = option.description;
        content.appendChild(desc);
      }

      if (selected) {
        const check = document.createElement('span');
        check.className = 'option-check';
        check.textContent = 'OK';
        card.appendChild(check);
      }

      card.appendChild(indicator);
      card.appendChild(content);

      if (option.isOther) {
        const otherInput = document.createElement('textarea');
        otherInput.className = `option-other-input visible`;
        otherInput.rows = 2;
        otherInput.value = summary.otherText || '';
        otherInput.readOnly = true;
        if (!summary.otherText) {
          otherInput.classList.remove('visible');
        }
        card.appendChild(otherInput);
      }

      optionsContainer.appendChild(card);
    });

    if (summary.note) {
      const note = document.createElement('textarea');
      note.className = 'question-note-input visible';
      note.rows = 2;
      note.value = summary.note;
      note.readOnly = true;
      element.appendChild(note);
    }

    return element;
  }

  // =============================================================
  // Modal
  // =============================================================

  ensurePlanReviewModal() {
    if (document.getElementById(this.planReviewModalId)) return;

    const modal = document.createElement('div');
    modal.className = 'modal hidden';
    modal.id = this.planReviewModalId;
    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content modal-plan-review">
        <div class="modal-header">
          <h2>Implementation Plan</h2>
          <button class="btn-icon plan-review-modal-close" type="button" aria-label="Close plan review">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="modal-body plan-review-modal-body"></div>
      </div>
    `;

    document.body.appendChild(modal);

    const backdrop = modal.querySelector('.modal-backdrop');
    const closeBtn = modal.querySelector('.plan-review-modal-close');
    backdrop?.addEventListener('click', () => this.closePlanReviewModal());
    closeBtn?.addEventListener('click', () => this.closePlanReviewModal());
  }

  openPlanReviewModal(planText) {
    this.ensurePlanReviewModal();
    const modal = document.getElementById(this.planReviewModalId);
    if (!modal) return;

    const body = modal.querySelector('.plan-review-modal-body');
    if (body) {
      body.innerHTML = formatMessage(planText || 'Plan is ready.');
    }

    modal.classList.remove('hidden');
  }

  closePlanReviewModal() {
    const modal = document.getElementById(this.planReviewModalId);
    if (modal) {
      modal.classList.add('hidden');
    }
  }

  // =============================================================
  // Helpers
  // =============================================================

  buildWizardStateFromPendingItem(chat, pendingItem) {
    const normalizedQuestions = this.normalizeQuestions(pendingItem?.questions || []);
    const maxIndex = Math.max(0, normalizedQuestions.length - 1);
    const currentIndexRaw = Number.isFinite(pendingItem?.currentIndex) ? pendingItem.currentIndex : 0;
    const currentIndex = Math.min(Math.max(0, currentIndexRaw), maxIndex);

    const ws = {
      questions: normalizedQuestions,
      toolUseId: pendingItem?.toolUseId || '',
      sessionId: chat.id,
      currentIndex,
      answers: { ...(pendingItem?.answers || {}) },
      answerSummary: { ...(pendingItem?.answerSummary || {}) },
      drafts: {},
    };

    const persistedDrafts = pendingItem?.draft && typeof pendingItem.draft === 'object'
      ? pendingItem.draft
      : {};

    for (const question of normalizedQuestions) {
      const stored = persistedDrafts[question.question] || {};
      const selected = Array.isArray(stored.selected)
        ? stored.selected.filter(value => typeof value === 'string' && value.trim())
        : [];
      const other = typeof stored.other === 'string' ? stored.other : '';

      ws.drafts[question.question] = {
        selected,
        other,
      };
    }

    return ws;
  }

  syncWizardStateToTimeline(ws) {
    if (!ws?.sessionId || !ws.toolUseId) return;
    const chat = this.getChat(ws.sessionId);
    if (!chat?.timeline) return;

    const pendingItem = [...chat.timeline]
      .reverse()
      .find(item => item.type === 'ask_question' && item.status === 'pending' && item.toolUseId === ws.toolUseId);

    if (!pendingItem) return;

    pendingItem.currentIndex = ws.currentIndex;
    pendingItem.questions = ws.questions;
    pendingItem.answers = { ...ws.answers };
    pendingItem.answerSummary = { ...ws.answerSummary };
    pendingItem.draft = { ...ws.drafts };

    this.app.projectManager.markChatForFullUpdate(chat.id);
    this.app.saveChats();
  }

  normalizeQuestions(questions) {
    if (!Array.isArray(questions)) return [];

    return questions.slice(0, 4).map(question => {
      const options = Array.isArray(question?.options)
        ? question.options
            .filter(option => option && typeof option.label === 'string' && option.label.trim())
            .map(option => ({
              label: option.label.trim(),
              description: typeof option.description === 'string' ? option.description.trim() : '',
            }))
        : [];

      const header = typeof question?.header === 'string' && question.header.trim()
        ? question.header.trim().slice(0, 12)
        : 'Question';

      const text = typeof question?.question === 'string' && question.question.trim()
        ? question.question.trim()
        : header;

      return {
        header,
        question: text,
        options,
        multiSelect: !!question?.multiSelect,
      };
    });
  }

  getQuestionAnswerSummary(item, question) {
    if (item.answerSummary?.[question.question]) {
      return item.answerSummary[question.question];
    }

    const rawAnswer = item.answers?.[question.question];
    if (!rawAnswer) {
      return { selectedOptions: [], note: '', otherText: '' };
    }

    const answer = String(rawAnswer);
    let base = answer;
    let note = '';

    const noteMatch = answer.match(/\s*\[Note:\s*([\s\S]+?)\]\s*$/);
    if (noteMatch) {
      note = noteMatch[1].trim();
      base = answer.slice(0, noteMatch.index).trim();
    }

    const selectedOptions = question.multiSelect
      ? base.split(',').map(part => part.trim()).filter(Boolean)
      : (base ? [base] : []);

    const knownLabels = new Set((question.options || []).map(option => option.label));
    const otherText = selectedOptions.find(value => !knownLabels.has(value)) || '';

    return {
      selectedOptions,
      note,
      otherText,
    };
  }

  getOptionIndicatorSymbol(multiSelect, selected) {
    if (multiSelect) {
      return selected ? '[\u2713]' : '[ ]';
    }
    return selected ? '(\u25CF)' : '(\u25CB)';
  }

  ensureChatPlanState(chat) {
    if (!chat.planModeState || typeof chat.planModeState !== 'object') {
      chat.planModeState = {
        active: false,
        statusText: 'Planning - Researching',
      };
      return;
    }

    if (typeof chat.planModeState.active !== 'boolean') {
      chat.planModeState.active = false;
    }
    if (typeof chat.planModeState.statusText !== 'string' || !chat.planModeState.statusText.trim()) {
      chat.planModeState.statusText = 'Planning - Researching';
    }
  }

  ensureTimeline(chat) {
    if (!chat.timeline) {
      chat.timeline = [];
    }
  }

  restoreDefaultComposerChrome() {
    const slot = document.getElementById('plan-mode-composer-slot');
    const pillSlot = document.getElementById('plan-mode-pill-slot');
    const inputArea = document.querySelector('.input-area');
    const inputOptionsRow = document.querySelector('.input-area .input-options-row');
    const inputRow = document.querySelector('.input-area .input-row');
    const inputInfo = document.querySelector('.input-area .input-info');
    const slashMenu = document.getElementById('slash-command-menu');

    slot?.classList.remove('visible', 'replace-chatbar');
    if (slot) slot.innerHTML = '';

    pillSlot?.classList.remove('visible');
    if (pillSlot) pillSlot.innerHTML = '';

    inputArea?.classList.remove('plan-mode-active');
    inputOptionsRow?.classList.remove('hidden-by-plan-mode');
    inputRow?.classList.remove('hidden-by-plan-mode');
    inputInfo?.classList.remove('hidden-by-plan-mode');
    slashMenu?.classList.remove('hidden-by-plan-mode');
    this.scheduleComposerClearanceRefresh();
  }

  scheduleComposerClearanceRefresh() {
    this.app.updateChatFloatingComposerClearance?.();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        this.app.updateChatFloatingComposerClearance?.();
      });
    }
  }

  persistChatMutation(chat, { rerender = false } = {}) {
    this.app.projectManager.markChatForFullUpdate(chat.id);
    this.app.saveChats();
    if (this.isActiveChat(chat.id)) {
      if (rerender) {
        this.app.renderMessages();
      } else {
        this.syncComposerDock();
      }
    }
  }

  sendToServer(payload, chat) {
    const sent = this.app.wsManager.send(payload);
    if (sent) {
      const provider = this.app.normalizeModelProvider(this.app.modelProvider);
      const isInteractiveContinuation =
        provider === 'codex' &&
        chat?.id &&
        (payload?.type === 'ask_user_answer' || payload?.type === 'plan_mode_response');

      if (isInteractiveContinuation) {
        const startedAt = Date.now();
        const turnId = `${chat.id}:plan:${startedAt}`;
        this.app.ttfwAnalytics?.startTurn({
          chatId: chat.id,
          turnId,
          provider,
          model: this.app.selectedModel,
          projectDir: this.app.projectDir || null,
          startedAt
        });
        this.app.aiProviderAnalytics?.startTurn({
          chatId: chat.id,
          turnId,
          provider,
          model: this.app.selectedModel,
          routePriority: this.app.isUseRopilotCreditsEnabled?.() === true
            ? (this.app.getRopilotCreditsRoutePriority?.() || 'economy')
            : 'byo',
          useRopilotCredits: this.app.isUseRopilotCreditsEnabled?.() === true,
          projectDir: this.app.projectDir || null,
          mode: this.app.projectDir ? 'filesync' : 'sourcecontrol',
          startedAt,
        });
        this.app.startProcessingChat(chat.id);
        if (this.isActiveChat(chat.id)) {
          this.app.showStatus('Thinking');
          this.app.updateSendButton();
        }
        this.app.renderProjectList();
      }

      return true;
    }

    if (chat) {
      this.app.addErrorMessageToChat('Not connected to server', chat, this.isActiveChat(chat.id));
    }
    return false;
  }

  isActiveChat(chatId) {
    return store.get('activeChatId') === chatId;
  }

  getChat(sessionId) {
    if (!sessionId) return null;
    return store.getChatById(sessionId) || this.app.findChatById(sessionId);
  }
}
