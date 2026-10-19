// Message Editor - handles message editing and rewind functionality
import { escapeHtml, autoResizeTextarea } from './utils.js';
import { store } from './state-store.js';
import { electronAPI } from './core/platform.js';

export class MessageEditor {
  constructor(app) {
    this.app = app;
    this.rewindModalKeyHandler = null;
    this.editBackup = null;
    this.pendingEditChatId = null;
    this.pendingEditProjectId = null;
    this.pendingEditProvider = null;
  }

  getChatProvider(chat = store.getActiveChat()) {
    return this.app.normalizeModelProvider(chat?.provider || this.app.modelProvider);
  }

  cloneData(value) {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  getUserBubbleVariant(message) {
    return typeof message?.bubbleVariant === 'string' ? message.bubbleVariant.trim() : '';
  }

  getDiffsFromMessage(chat, messageIndex) {
    return (chat?.diffs || []).filter((diff) => diff.chatMessageIndex >= messageIndex);
  }

  setRewindModalCopy(provider) {
    const safeProvider = this.app.normalizeModelProvider(provider);
    const titleEl = document.getElementById('edit-confirm-modal-title');
    const descriptionEl = document.getElementById('edit-confirm-modal-description');
    const rewindOnlyTitleEl = document.getElementById('btn-rewind-only-title');
    const rewindOnlyDescEl = document.getElementById('btn-rewind-only-desc');
    const rewindAndRevertTitleEl = document.getElementById('btn-rewind-and-revert-title');
    const rewindAndRevertDescEl = document.getElementById('btn-rewind-and-revert-desc');

    if (!titleEl || !descriptionEl || !rewindOnlyTitleEl || !rewindOnlyDescEl || !rewindAndRevertTitleEl || !rewindAndRevertDescEl) {
      return;
    }

    if (safeProvider === 'codex') {
      titleEl.textContent = 'Rewind Conversation';
      descriptionEl.textContent = 'Choose how to handle later file changes before editing from this point:';
      rewindOnlyTitleEl.textContent = 'Rewind';
      rewindOnlyDescEl.textContent = 'Keep current files and continue this chat from this point';
      rewindAndRevertTitleEl.textContent = 'Rewind and Revert Changes';
      rewindAndRevertDescEl.textContent = 'Restore files changed after this point, then continue this chat';
      return;
    }

    titleEl.textContent = 'Rewind Conversation';
    descriptionEl.textContent = 'Choose how to handle this edit:';
    rewindOnlyTitleEl.textContent = 'Rewind';
    rewindOnlyDescEl.textContent = 'Delete messages after this point';
    rewindAndRevertTitleEl.textContent = 'Rewind and Revert Changes';
    rewindAndRevertDescEl.textContent = 'Delete messages and revert all changes';
  }

  showRewindModal(provider, defaultAction = 'revert') {
    this.setRewindModalCopy(provider);

    const modal = document.getElementById('edit-confirm-modal');
    if (!modal) return;

    modal.classList.remove('hidden');

    const defaultButton = defaultAction === 'keep'
      ? document.getElementById('btn-rewind-only')
      : document.getElementById('btn-rewind-and-revert');
    setTimeout(() => defaultButton?.focus(), 50);

    if (this.rewindModalKeyHandler) {
      document.removeEventListener('keydown', this.rewindModalKeyHandler);
    }

    this.rewindModalKeyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeConfirmModal();
        return;
      }
      if (e.key !== 'Enter') return;

      const focusedId = document.activeElement?.id;
      if (focusedId === 'btn-rewind-only') {
        e.preventDefault();
        this.confirmRewind(false);
      } else if (focusedId === 'btn-rewind-and-revert') {
        e.preventDefault();
        this.confirmRewind(true);
      } else if (defaultAction === 'keep') {
        e.preventDefault();
        this.confirmRewind(false);
      } else {
        e.preventDefault();
        this.confirmRewind(true);
      }
    };

    document.addEventListener('keydown', this.rewindModalKeyHandler);
  }

  async restoreWorkspaceDiffsToOriginal(diffs, logPrefix = '[REWIND]') {
    if (!Array.isArray(diffs) || diffs.length === 0) {
      console.log(`${logPrefix} No diffs to revert`);
      return;
    }

    console.log(`${logPrefix} Diffs to revert:`, diffs.length);
    diffs.forEach((diff, i) => {
      const mode = diff.isFileSync ? 'LOCAL' : 'EDGE';
      console.log(`${logPrefix}   [${i}] chatMessageIndex=${diff.chatMessageIndex}, scriptPath=${diff.scriptPath}, localPath=${diff.localPath || '(none)'}, mode=${mode}, originalLen=${diff.originalContent?.length || 0}`);
    });

    const reversedDiffs = [...diffs].reverse();
    let successCount = 0;
    const failedPaths = [];

    for (const diff of reversedDiffs) {
      try {
        const isLocalFile = !!diff.isFileSync;
        if (isLocalFile) {
          console.log(`${logPrefix} Restoring local file: ${diff.localPath}`);
          const restored = await this.app.diffPreview.restoreLocalFile(diff.localPath, diff.originalContent);
          if (restored) {
            successCount++;
            console.log(`${logPrefix} Successfully restored local file: ${diff.localPath}`);
          } else {
            failedPaths.push(diff.localPath);
            console.error(`${logPrefix} Failed to restore local file: ${diff.localPath}`);
          }
        } else {
          console.log(`${logPrefix} Restoring script via edge: ${diff.scriptPath}`);
          const restored = await this.app.diffPreview.restoreScriptViaEdge(diff.scriptPath, diff.originalContent);
          if (restored) {
            successCount++;
            console.log(`${logPrefix} Successfully restored via edge: ${diff.scriptPath}`);
          } else {
            failedPaths.push(diff.scriptPath);
            console.error(`${logPrefix} Failed to restore via edge: ${diff.scriptPath}`);
          }
        }
      } catch (err) {
        const pathToLog = diff.localPath || diff.scriptPath;
        failedPaths.push(pathToLog);
        console.error(`${logPrefix} Error restoring ${pathToLog}:`, err);
      }
    }

    console.log(`${logPrefix} Restored ${successCount}/${diffs.length} scripts/files`);
    if (failedPaths.length > 0) {
      console.warn(`${logPrefix} Failed to restore:`, failedPaths);
    }
  }

  async reapplyEditedDiffs(diffs, logPrefix = '[EDIT]') {
    if (!Array.isArray(diffs) || diffs.length === 0) return;

    console.log(`${logPrefix} Re-applying reverted file changes on cancel...`);
    for (const diff of diffs) {
      try {
        const isLocalFile = !!diff.isFileSync;
        if (isLocalFile) {
          console.log(`${logPrefix} Re-applying local file: ${diff.localPath}`);
          await this.app.diffPreview.restoreLocalFile(diff.localPath, diff.editedContent);
        } else {
          console.log(`${logPrefix} Re-applying script via edge: ${diff.scriptPath}`);
          await this.app.diffPreview.restoreScriptViaEdge(diff.scriptPath, diff.editedContent);
        }
      } catch (err) {
        console.error(`${logPrefix} Error re-applying ${diff.localPath || diff.scriptPath}:`, err);
      }
    }
  }

  async prepareCodexRewindForEdit(sourceChat, messageIndex, withRevert) {
    if (!sourceChat) return false;

    const timelineIndex = this.app.messageRenderer.findTimelineIndexOfUserMessage(messageIndex);
    if (timelineIndex === -1) return false;

    const diffsToRevert = this.getDiffsFromMessage(sourceChat, messageIndex);
    if (withRevert && diffsToRevert.length > 0) {
      await this.restoreWorkspaceDiffsToOriginal(diffsToRevert, '[CODEX-REWIND]');
    }

    // Reconstructed Codex threads can collapse several UI messages into one
    // native turn, so rollout turn numbers are not a safe rewind boundary.
    // The next send rebuilds a fresh thread from the truncated UI timeline.

    const deletedTimeline = sourceChat.timeline.slice(timelineIndex + 1);
    const deletedDiffs = this.getDiffsFromMessage(sourceChat, messageIndex);
    this.editBackup = {
      chatId: sourceChat.id,
      timelineIndex,
      deletedTimeline: this.cloneData(deletedTimeline) || [],
      deletedDiffs: this.cloneData(deletedDiffs) || [],
      previousContextUsage: this.cloneData(sourceChat.contextUsage) || null,
      withRevert,
      codexRewind: true,
      previousCodexThreadId: sourceChat.codexThreadId || null,
      previousHasHistory: !!sourceChat.hasHistory,
      previousCodexCompactedTimelineIndex: Number(sourceChat.codexCompactedTimelineIndex) || 0,
      previousUpdatedAt: sourceChat.updatedAt || sourceChat.createdAt || Date.now(),
      clonedRolloutPath: null,
    };

    sourceChat.timeline = sourceChat.timeline.slice(0, timelineIndex + 1);
    sourceChat.diffs = this.cloneData((sourceChat.diffs || []).filter((diff) => diff.chatMessageIndex < messageIndex)) || [];
    sourceChat.claudeSessionId = null;
    sourceChat.codexThreadId = null;
    sourceChat.hasHistory = false;
    // A rewind rebuilds the timeline, so the last compact's boundary index no
    // longer points at the turns it described.
    sourceChat.codexCompactedTimelineIndex = 0;
    sourceChat.updatedAt = this.editBackup.previousUpdatedAt;
    this.app.clearChatContextUsage(sourceChat, { persist: false, rerender: false });

    this.app.saveProjects();
    this.app.chatSync?.scheduleChatCommit({ chatId: sourceChat.id, reason: 'codex_rewind_prepare' });
    this.app.renderProjectList();

    this.app.pendingRewind = true;
    this.app.pendingCodexRewindStrict = false;
    this.app.messageRenderer.render();
    this.enterEditMode(messageIndex);
    return true;
  }

  requestEdit(messageIndex) {
    if (this.app.isProcessing) {
      this.app.stopInference();
    }

    const activeChat = store.getActiveChat();
    if (!activeChat) return;

    const timeline = activeChat.timeline || [];
    const timelineIndex = this.app.messageRenderer.findTimelineIndexOfUserMessage(messageIndex);
    if (timelineIndex === -1) return;

    const chatProvider = this.getChatProvider(activeChat);
    const diffsToRevert = this.getDiffsFromMessage(activeChat, messageIndex);
    const hasLaterTimeline = timelineIndex < timeline.length - 1;

    this.pendingEditChatId = activeChat.id;
    this.pendingEditProjectId = this.app.activeProjectId;
    this.pendingEditProvider = chatProvider;

    if (chatProvider === 'codex') {
      if (diffsToRevert.length > 0) {
        this.app.pendingEditIndex = messageIndex;
        this.showRewindModal('codex', 'revert');
        return;
      }

      void this.prepareCodexRewindForEdit(activeChat, messageIndex, false).then((created) => {
        if (!created) {
          this.app.showAppAlertModal(
            'Unable To Rewind Codex Chat',
            'Ropilot could not rewind this Codex chat from this point.'
          );
        }
      });
      return;
    }

    if (hasLaterTimeline) {
      this.app.pendingEditIndex = messageIndex;
      if (diffsToRevert.length === 0) {
        void this.confirmRewind(false);
        return;
      }
      this.showRewindModal('claude', 'revert');
      return;
    }

    this.enterEditMode(messageIndex);
  }

  closeConfirmModal() {
    document.getElementById('edit-confirm-modal')?.classList.add('hidden');
    this.app.pendingEditIndex = null;
    this.pendingEditChatId = null;
    this.pendingEditProjectId = null;
    this.pendingEditProvider = null;
    document.querySelectorAll('.rewind-option').forEach((btn) => btn.classList.remove('loading'));
    if (this.rewindModalKeyHandler) {
      document.removeEventListener('keydown', this.rewindModalKeyHandler);
      this.rewindModalKeyHandler = null;
    }
    this.setRewindModalCopy('claude');
  }

  async confirmRewind(withRevert) {
    if (this.app.pendingEditIndex === null) return;

    const messageIndex = this.app.pendingEditIndex;
    const activeChat = this.app.chatManager.findById(this.pendingEditChatId) || store.getActiveChat();
    const activeProvider = this.app.normalizeModelProvider(this.pendingEditProvider || this.getChatProvider(activeChat));

    const btn = withRevert
      ? document.getElementById('btn-rewind-and-revert')
      : document.getElementById('btn-rewind-only');
    btn?.classList.add('loading');

    if (activeProvider === 'codex') {
      const created = await this.prepareCodexRewindForEdit(activeChat, messageIndex, withRevert);
      this.closeConfirmModal();
      if (!created) {
        this.app.showAppAlertModal(
          'Unable To Rewind Codex Chat',
          'Ropilot could not rewind this Codex chat from this point.'
        );
      }
      return;
    }

    const sessionId = activeChat?.id;
    const timeline = activeChat?.timeline || [];
    console.log('[REWIND] ======================================');
    console.log('[REWIND] confirmRewind called at', new Date().toISOString());
    console.log('[REWIND] Parameters:', {
      withRevert,
      messageIndex,
      sessionId,
      totalTimelineItems: timeline.length,
      totalDiffs: activeChat?.diffs?.length || 0
    });

    if (timeline.length > 0) {
      console.log('[REWIND] Current timeline:');
      timeline.forEach((item, i) => {
        const content = item.content?.substring(0, 50) || '(empty)';
        console.log(`[REWIND]   [${i}] ${item.type}: ${content}...`);
      });
    }

    if (activeChat?.diffs) {
      console.log('[REWIND] Stored diffs:');
      activeChat.diffs.forEach((diff, i) => {
        console.log(`[REWIND]   [${i}] chatMessageIndex=${diff.chatMessageIndex}, scriptPath=${diff.scriptPath}, localPath=${diff.localPath || '(none)'}, scriptType=${diff.scriptType || '(none)'}`);
      });
    }

    const diffsToRevert = this.getDiffsFromMessage(activeChat, messageIndex);
    if (withRevert && diffsToRevert.length > 0) {
      await this.restoreWorkspaceDiffsToOriginal(diffsToRevert, '[REWIND]');
    }

    this.closeConfirmModal();

    if (activeChat) {
      const timelineIndex = this.app.messageRenderer.findTimelineIndexOfUserMessage(messageIndex);
      if (timelineIndex !== -1) {
        const deletedTimeline = activeChat.timeline.slice(timelineIndex + 1);
        const deletedDiffs = this.getDiffsFromMessage(activeChat, messageIndex);

        if (deletedTimeline.length > 0 || deletedDiffs.length > 0) {
          this.editBackup = {
            chatId: activeChat.id,
            timelineIndex,
            deletedTimeline,
            deletedDiffs,
            previousContextUsage: this.cloneData(activeChat.contextUsage) || null,
            withRevert
          };
          console.log(`[REWIND] Stored edit backup: ${deletedTimeline.length} timeline items, ${deletedDiffs.length} diffs`);
        }

        activeChat.timeline = activeChat.timeline.slice(0, timelineIndex + 1);
        this.app.projectManager.queueTruncate(activeChat.id, timelineIndex);
      }

      if (activeChat.diffs) {
        activeChat.diffs = activeChat.diffs.filter((diff) => diff.chatMessageIndex < messageIndex);
      }
      this.app.clearChatContextUsage(activeChat, { persist: false, rerender: false });

      this.app.pendingRewind = true;
      console.log(`[REWIND] Marked pending rewind for chat ${activeChat.id}`);
      this.app.saveChats();
    }

    this.app.messageRenderer.render();
    this.enterEditMode(messageIndex);
  }

  enterEditMode(messageIndex) {
    if (this.app.isProcessing) {
      this.app.stopInference();
    }
    const activeChat = store.getActiveChat();
    if (!activeChat) return;

    this.app.editingMessageIndex = messageIndex;
    const timelineIndex = this.app.messageRenderer.findTimelineIndexOfUserMessage(messageIndex);
    const message = timelineIndex !== -1 ? activeChat.timeline[timelineIndex] : null;
    if (!message || message.type !== 'user') return;

    const messageEl = document.querySelector(`.message[data-message-index="${messageIndex}"]`);
    if (!messageEl) return;
    if (messageEl.classList.contains('editing')) return;

    messageEl.classList.add('editing');

    const wrapper = messageEl.querySelector('.message-wrapper');
    if (!wrapper) return;

    const existingContainer = wrapper.querySelector('.message-edit-container');
    if (existingContainer) {
      existingContainer.remove();
    }

    const editContainer = document.createElement('div');
    editContainer.className = 'message-edit-container';
    editContainer.innerHTML = `
      <textarea class="message-edit-textarea">${escapeHtml(message.content)}</textarea>
      <div class="message-edit-actions">
        <button class="btn-edit-cancel">Cancel</button>
        <button class="btn-edit-save">Save</button>
      </div>
    `;

    wrapper.appendChild(editContainer);

    const textarea = editContainer.querySelector('.message-edit-textarea');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    autoResizeTextarea(textarea);
    textarea.oninput = () => autoResizeTextarea(textarea);

    editContainer.querySelector('.btn-edit-cancel').onclick = () => {
      this.cancel(messageIndex);
    };

    editContainer.querySelector('.btn-edit-save').onclick = () => {
      this.save(messageIndex, textarea.value);
    };

    textarea.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.save(messageIndex, textarea.value);
      } else if (e.key === 'Escape') {
        this.cancel(messageIndex);
      }
    };

    editContainer.querySelector('.message-edit-actions').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async cancel(messageIndex) {
    const activeChat = store.getActiveChat();

    if (this.editBackup) {
      if (activeChat && activeChat.id === this.editBackup.chatId) {
        console.log(`[EDIT] Restoring backup: ${this.editBackup.deletedTimeline.length} timeline items, ${this.editBackup.deletedDiffs.length} diffs`);

        activeChat.timeline = [
          ...activeChat.timeline.slice(0, this.editBackup.timelineIndex + 1),
          ...this.editBackup.deletedTimeline
        ];
        activeChat.contextUsage = this.cloneData(this.editBackup.previousContextUsage) || null;

        if (this.editBackup.deletedDiffs.length > 0) {
          if (!activeChat.diffs) activeChat.diffs = [];
          activeChat.diffs = [...activeChat.diffs, ...this.editBackup.deletedDiffs];
        }

        if (this.editBackup.codexRewind) {
          activeChat.codexThreadId = this.editBackup.previousCodexThreadId;
          activeChat.hasHistory = this.editBackup.previousHasHistory;
          activeChat.codexCompactedTimelineIndex = this.editBackup.previousCodexCompactedTimelineIndex || 0;
          activeChat.updatedAt = this.editBackup.previousUpdatedAt;

          const api = electronAPI();
          if (this.editBackup.clonedRolloutPath && api?.deleteCodexClonedRollout) {
            const cleanupResult = await api.deleteCodexClonedRollout(this.editBackup.clonedRolloutPath);
            if (!cleanupResult?.success) {
              console.warn('[CODEX-REWIND] Failed to clean up cloned rollout:', cleanupResult?.error || 'unknown error');
            }
          }
        }

        if (this.editBackup.withRevert && this.editBackup.deletedDiffs.length > 0) {
          await this.reapplyEditedDiffs(this.editBackup.deletedDiffs, '[EDIT]');
        }

        this.app.pendingRewind = false;
        this.app.pendingCodexRewindStrict = false;
        if (this.editBackup.codexRewind) {
          this.app.saveProjects();
          this.app.chatSync?.scheduleChatCommit({ chatId: activeChat.id, reason: 'codex_rewind_cancel' });
          this.app.renderProjectList();
        } else {
          this.app.saveChats();
          this.app.chatSync?.scheduleChatCommit({ chatId: activeChat.id, reason: 'message_edit_cancel' });
        }
      }
      this.editBackup = null;
    }

    this.app.editingMessageIndex = null;
    this.app.messageRenderer.render();
  }

  save(messageIndex, newContent) {
    const activeChat = store.getActiveChat();
    newContent = newContent.trim();
    if (!newContent || !activeChat) {
      this.cancel(messageIndex);
      return;
    }

    const timelineIndex = this.app.messageRenderer.findTimelineIndexOfUserMessage(messageIndex);
    const editedMessage = timelineIndex !== -1 ? activeChat.timeline?.[timelineIndex] : null;
    const userBubbleVariant = this.getUserBubbleVariant(editedMessage);

    if (!this.app.getEffectiveApiKey()) {
      this.app.settings.open();
      return;
    }

    this.editBackup = null;

    if (timelineIndex !== -1) {
      activeChat.timeline = activeChat.timeline.slice(0, timelineIndex);
      this.app.projectManager.queueTruncate(activeChat.id, timelineIndex - 1);
    }
    this.app.clearChatContextUsage(activeChat, { persist: false, rerender: false });
    this.app.saveChats();
    this.app.chatSync?.scheduleChatCommit({ chatId: activeChat.id, reason: 'message_edit_save' });

    this.app.editingMessageIndex = null;
    this.app.messageRenderer.render();

    if (messageIndex === 0) {
      const newTitle = newContent.substring(0, 40) + (newContent.length > 40 ? '...' : '');
      activeChat.title = newTitle;
      this.app.projectManager.queueTitleUpdate(activeChat.id, newTitle);
      this.app.projectManager.renderList();
    }

    this.resend(newContent, userBubbleVariant ? { userBubbleVariant } : {});
  }

  resend(content, options = {}) {
    const activeChat = store.getActiveChat();
    if (!content || !activeChat) return;
    const userBubbleVariant = typeof options?.userBubbleVariant === 'string'
      ? options.userBubbleVariant.trim()
      : '';

    if (this.app.isChatProcessing(activeChat.id)) {
      if (!this.app.messageQueues.has(activeChat.id)) {
        this.app.messageQueues.set(activeChat.id, []);
      }
      const queuedEdit = {
        content,
        queuedAt: Date.now(),
      };
      if (userBubbleVariant) {
        queuedEdit.userBubbleVariant = userBubbleVariant;
      }
      this.app.messageQueues.get(activeChat.id).push(queuedEdit);
      this.app.updateQueueIndicator();
      return;
    }

    this.app.sendMessageContent(content, false, [], userBubbleVariant ? { userBubbleVariant } : {});
  }
}
