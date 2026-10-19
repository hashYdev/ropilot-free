// @ts-check
// App-level confirm/alert modals: delete-chat and delete-project confirms,
// the generic app alert modal, and the shared focus capture/restore helpers
// used by every modal (including the image preview modal). Extracted from
// app.js; holds the app reference and reaches back through it for the
// pending-delete state and the focus-return registry, which stay on the app
// object so external writers keep working.

export class Modals {
  constructor(app) {
    this.app = app;
  }

  showDeleteChatModal(chatId, projectId, chatTitle = '') {
    if (!chatId || !projectId) return;
    this.app.pendingDeleteChat = { chatId, projectId };

    const messageEl = document.getElementById('delete-chat-modal-message');
    if (messageEl) {
      const safeTitle = (chatTitle || '').trim();
      messageEl.textContent = safeTitle
        ? `Delete "${safeTitle}"? This cannot be undone.`
        : 'Delete this chat? This cannot be undone.';
    }

    const modal = document.getElementById('chat-delete-confirm-modal');
    this.captureModalFocus('chat-delete-confirm-modal');
    modal?.classList.remove('hidden');
    document.getElementById('btn-cancel-delete-chat')?.focus();
  }

  closeDeleteChatModal() {
    const modal = document.getElementById('chat-delete-confirm-modal');
    modal?.classList.add('hidden');
    this.app.pendingDeleteChat = null;
    this.restoreFocusAfterModal('chat-delete-confirm-modal');
  }

  confirmDeleteChat() {
    const pending = this.app.pendingDeleteChat;
    if (!pending) return;
    this.closeDeleteChatModal();
    this.app.chatManager.delete(pending.chatId, pending.projectId);
  }

  showDeleteProjectModal(projectId, projectName = '') {
    if (!projectId || projectId === 'default') return;
    const safeName = (projectName || '').trim();
    this.app.pendingDeleteProject = {
      projectId,
      requiredName: safeName ? safeName.toLowerCase() : ''
    };

    const messageEl = document.getElementById('delete-project-modal-message');
    if (messageEl) {
      messageEl.textContent = safeName
        ? `Delete folder "${safeName}"? This cannot be undone.`
        : 'Delete this folder? This cannot be undone.';
    }
    const hintEl = document.getElementById('delete-project-modal-hint');
    if (hintEl) {
      hintEl.textContent = this.app.pendingDeleteProject.requiredName
        ? `Required: ${this.app.pendingDeleteProject.requiredName}`
        : '';
    }
    const inputEl = document.getElementById('input-delete-project-confirmation');
    if (inputEl) {
      inputEl.value = '';
      inputEl.placeholder = this.app.pendingDeleteProject.requiredName || 'folder-name';
    }
    this.updateDeleteProjectConfirmState();

    const modal = document.getElementById('project-delete-confirm-modal');
    this.captureModalFocus('project-delete-confirm-modal');
    modal?.classList.remove('hidden');
    document.getElementById('input-delete-project-confirmation')?.focus();
  }

  closeDeleteProjectModal() {
    const modal = document.getElementById('project-delete-confirm-modal');
    modal?.classList.add('hidden');
    const inputEl = document.getElementById('input-delete-project-confirmation');
    if (inputEl) inputEl.value = '';
    const confirmBtn = document.getElementById('btn-confirm-delete-project');
    if (confirmBtn) confirmBtn.disabled = true;
    this.app.pendingDeleteProject = null;
    this.restoreFocusAfterModal('project-delete-confirm-modal');
  }

  updateDeleteProjectConfirmState() {
    const inputEl = document.getElementById('input-delete-project-confirmation');
    const confirmBtn = document.getElementById('btn-confirm-delete-project');
    if (!inputEl || !confirmBtn) return;

    const pending = this.app.pendingDeleteProject;
    if (!pending) {
      confirmBtn.disabled = true;
      return;
    }

    const typedValue = inputEl.value.trim();
    confirmBtn.disabled = pending.requiredName
      ? typedValue !== pending.requiredName
      : false;
  }

  confirmDeleteProject() {
    const pending = this.app.pendingDeleteProject;
    if (!pending) return;
    this.closeDeleteProjectModal();
    this.app.projectManager.delete(pending.projectId);
  }

  showAppAlertModal(title, message, focusSelector = null, options = {}) {
    const titleEl = document.getElementById('app-alert-title');
    const messageEl = document.getElementById('app-alert-message');
    const noteEl = document.getElementById('app-alert-note');
    const noteTitleEl = document.getElementById('app-alert-note-title');
    const noteBodyEl = document.getElementById('app-alert-note-body');
    const modal = document.getElementById('app-alert-modal');
    if (!titleEl || !messageEl || !modal) return;

    titleEl.textContent = title || 'Notice';
    messageEl.textContent = message || '';
    const noteTitle = typeof options.noteTitle === 'string' ? options.noteTitle.trim() : '';
    const noteMessage = typeof options.noteMessage === 'string' ? options.noteMessage.trim() : '';
    if (noteEl && noteTitleEl && noteBodyEl) {
      if (noteTitle || noteMessage) {
        noteTitleEl.textContent = noteTitle || 'From Ropilot';
        noteBodyEl.textContent = noteMessage;
        noteEl.classList.remove('hidden');
      } else {
        noteTitleEl.textContent = '';
        noteBodyEl.textContent = '';
        noteEl.classList.add('hidden');
      }
    }
    this.app.pendingAppAlertFocusSelector = focusSelector || null;
    this.captureModalFocus('app-alert-modal');
    modal.classList.remove('hidden');

    const okBtn = document.getElementById('btn-ok-app-alert');
    okBtn?.focus();
  }

  closeAppAlertModal() {
    const modal = document.getElementById('app-alert-modal');
    const noteEl = document.getElementById('app-alert-note');
    const noteTitleEl = document.getElementById('app-alert-note-title');
    const noteBodyEl = document.getElementById('app-alert-note-body');
    if (modal) {
      modal.classList.add('hidden');
    }
    if (noteEl && noteTitleEl && noteBodyEl) {
      noteEl.classList.add('hidden');
      noteTitleEl.textContent = '';
      noteBodyEl.textContent = '';
    }
    this.restoreFocusAfterModal('app-alert-modal', this.app.pendingAppAlertFocusSelector);
    this.app.pendingAppAlertFocusSelector = null;
  }

  captureModalFocus(modalId) {
    if (!modalId) return;
    const activeEl = document.activeElement;
    if (activeEl && activeEl instanceof HTMLElement) {
      this.app.modalFocusReturnTargets.set(modalId, activeEl);
    } else {
      this.app.modalFocusReturnTargets.delete(modalId);
    }
  }

  isFocusableVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.matches(':disabled')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  restoreFocusAfterModal(modalId, preferredSelector = null) {
    const modal = modalId ? document.getElementById(modalId) : null;
    const activeEl = document.activeElement;

    // If focus is stuck on an element inside a hidden modal, blur it first.
    if (modal && activeEl instanceof HTMLElement && modal.contains(activeEl)) {
      activeEl.blur();
    }

    const preferredEl = preferredSelector ? document.querySelector(preferredSelector) : null;
    const storedEl = modalId ? this.app.modalFocusReturnTargets.get(modalId) : null;
    const fallbackInput = document.getElementById('input-message');

    const target =
      (this.isFocusableVisible(preferredEl) && preferredEl) ||
      (this.isFocusableVisible(storedEl) && storedEl) ||
      (this.isFocusableVisible(fallbackInput) && fallbackInput) ||
      null;

    if (modalId) {
      this.app.modalFocusReturnTargets.delete(modalId);
    }

    if (target && typeof target.focus === 'function') {
      requestAnimationFrame(() => {
        target.focus();
      });
    }
  }
}
