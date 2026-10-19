// Pending Message UI - handles pending message and queue indicator UI
import { escapeHtml, autoResizeTextarea, scrollChatMessagesToEnd } from './utils.js';
import { store } from './state-store.js';

export class PendingMessageUI {
  constructor(app) {
    this.app = app;
  }

  updateIndicator() {
    let container = document.getElementById('queue-indicator');

    // Get queue for current chat only (messageQueues is a Map keyed by chatId)
    const activeChatId = store.get('activeChatId');
    const currentChatQueue = activeChatId ? (this.app.messageQueues.get(activeChatId) || []) : [];

    if (currentChatQueue.length === 0) {
      if (container) {
        container.remove();
      }
      return;
    }

    if (!container) {
      container = document.createElement('div');
      container.id = 'queue-indicator';
      container.className = 'queue-container';
      const inputArea = document.querySelector('.input-area');
      if (inputArea) {
        inputArea.parentNode.insertBefore(container, inputArea);
      }
    }

    // Show messages queued for the current chat only
    const html = currentChatQueue.map((queuedItem) => {
      const content = typeof queuedItem === 'string' ? queuedItem : (queuedItem?.content || '');
      const imageCount = typeof queuedItem === 'string'
        ? 0
        : (Array.isArray(queuedItem?.images) ? queuedItem.images.length : 0);

      let label = content.trim();
      if (!label && imageCount > 0) {
        label = imageCount === 1 ? '[Image attached]' : `[${imageCount} images attached]`;
      } else if (label && imageCount > 0) {
        const suffix = imageCount === 1 ? ' + image' : ` + ${imageCount} images`;
        label = `${label}${suffix}`;
      }

      const truncated = label.length > 50 ? label.slice(0, 50) + '...' : label;
      return `<div class="queue-message">${escapeHtml(truncated)}</div>`;
    }).join('');

    container.innerHTML = html;
  }

  showPending() {
    this.hidePending();

    // Show pending message for the current active chat only
    const activeChatId = store.get('activeChatId');
    const pendingMsg = activeChatId ? this.app.getPendingMessage(activeChatId) : null;
    if (!pendingMsg) return;

    const container = document.createElement('div');
    container.id = 'pending-message';
    container.className = 'pending-message-container';

    const content = document.createElement('div');
    content.className = 'pending-message-content';

    const text = document.createElement('span');
    text.className = 'pending-message-text';
    text.textContent = pendingMsg;

    const actions = document.createElement('div');
    actions.className = 'pending-message-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'pending-action-btn pending-edit-btn';
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
    editBtn.title = 'Edit';
    editBtn.onclick = (e) => { e.stopPropagation(); this.editPending(); };

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'pending-action-btn pending-delete-btn';
    deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
    deleteBtn.title = 'Delete';
    deleteBtn.onclick = (e) => { e.stopPropagation(); this.deletePending(); };

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    content.appendChild(text);
    content.appendChild(actions);

    container.appendChild(content);

    const inputArea = document.querySelector('.input-area');
    if (inputArea) {
      inputArea.parentNode.insertBefore(container, inputArea);
    }
  }

  hidePending() {
    const container = document.getElementById('pending-message');
    if (container) {
      container.remove();
    }
  }

  editPending() {
    const activeChatId = store.get('activeChatId');
    const pendingMsg = activeChatId ? this.app.getPendingMessage(activeChatId) : null;
    if (!pendingMsg) return;

    const input = document.getElementById('input-message');
    input.value = pendingMsg;
    autoResizeTextarea(input);
    this.app.updateSendButton();
    input.focus();

    // Cancel the pending request for this chat
    this.app.setPendingMessage(activeChatId, null);
    this.hidePending();
    this.app.stopProcessingChat(activeChatId);
    this.app.statusManager.hide();
    this.app.updateSendButton();
    this.app.projectManager.renderList();
  }

  deletePending() {
    const activeChatId = store.get('activeChatId');
    if (activeChatId) {
      this.app.setPendingMessage(activeChatId, null);
      this.app.stopProcessingChat(activeChatId);
    }
    this.hidePending();
    this.app.statusManager.hide();
    this.app.updateSendButton();
    this.app.projectManager.renderList();
  }

  confirmPending() {
    // Find any chat with a pending message and confirm it
    // This is called when inference completes successfully
    for (const [chatId, pendingContent] of this.app.pendingMessages) {
      console.log('[CONFIRM] Processing pending message for chat:', chatId);

      // Find the chat using store
      const targetChat = store.getChatById(chatId);

      if (!targetChat) {
        console.warn('[PENDING] Could not find chat for pending message:', chatId);
        this.app.pendingMessages.delete(chatId);
        continue;
      }

      // Add user message to timeline
      this.app.messageRenderer.addToTimeline({ type: 'user', content: pendingContent }, targetChat);

      // Only render if this is the active chat
      if (store.get('activeChatId') === chatId) {
        this.app.messageRenderer.render();
        scrollChatMessagesToEnd();
      }

      // Update chat title if first user message
      const userMsgs = (targetChat.timeline || []).filter(i => i.type === 'user');
      if (userMsgs.length === 1) {
        const preview = pendingContent.slice(0, 50) + (pendingContent.length > 50 ? '...' : '');
        targetChat.title = preview;
        this.app.projectManager.queueTitleUpdate(targetChat.id, preview);
        this.app.projectManager.renderList();
      }

      // Clear pending state for this chat
      console.log('[CONFIRM] Clearing pending state for chat:', chatId);
      this.app.pendingMessages.delete(chatId);
    }

    // Save projects
    this.app.projectManager.save();

    // Hide pending UI (for active chat)
    this.hidePending();
    console.log('[CONFIRM] Done');
  }
}
