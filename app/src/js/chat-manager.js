// Chat Manager - handles chat CRUD and UI
import { resolveSiteUrlForApiKey } from './api-validation.js';
import { migrateLegacyContextWindowActivities } from './context-window.js';
import { escapeHtml, scrollChatMessagesToEnd } from './utils.js';
import { getProviderMarkSvg } from './ui/provider-marks.js';
import { store } from './state-store.js';

const BILLING_REPAIR_TIMEOUT_MS = 5000;
const BILLING_REPAIR_EPSILON = 0.000001;

export class ChatManager {
  constructor(app) {
    this.app = app;
    this.activationSequence = 0;
    this.billingRepairInFlight = new Set();
  }

  findLatestManagedCreditsTurn(chat) {
    if (!Array.isArray(chat?.timeline)) return null;

    let messageIndex = 0;
    let latest = null;
    for (const item of chat.timeline) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'user') {
        messageIndex += 1;
        continue;
      }
      if (messageIndex <= 0 || (item.type !== 'assistant' && item.type !== 'emit')) continue;

      const balanceType = typeof item.actionCostBalanceType === 'string'
        ? item.actionCostBalanceType.trim()
        : '';
      const label = typeof item.actionCostLabel === 'string' ? item.actionCostLabel.trim() : '';
      const isManaged = item.useRopilotCredits === true
        || balanceType === 'managed_ai_credits'
        || label === 'Ropilot Credits';
      const storedCost = Number(item.actionCost ?? item.actionCount ?? 0);
      if (isManaged && Number.isFinite(storedCost) && storedCost > 0) {
        latest = { messageIndex, storedCost };
      }
    }
    return latest;
  }

  async repairLatestManagedCreditsTurn(chat) {
    // free build: this is a legacy repair for chats whose turns were billed
    // to Ropilot Credits. Nothing here is billed, so there is nothing to
    // reconcile and no reason to contact their billing endpoint.
    return false;
  }

  buildChat(seed = {}) {
    const now = Date.now();
    const provider = this.app.normalizeModelProvider(seed.provider || this.app.modelProvider);
    const model = this.app.coerceModelForProvider(provider, seed.model || this.app.selectedModel);

    const chat = {
      id: seed.id || ('chat-' + now + '-' + Math.random().toString(36).substr(2, 6)),
      title: seed.title || 'New Chat',
      timeline: Array.isArray(seed.timeline) ? seed.timeline : [],
      activities: Array.isArray(seed.activities) ? seed.activities : [],
      createdAt: seed.createdAt || now,
      updatedAt: seed.updatedAt || now,
      sourcecontrolState: seed.sourcecontrolState || {},
      claudeSessionId: seed.claudeSessionId || null,
      codexThreadId: seed.codexThreadId || null,
      hasHistory: seed.hasHistory || false,
      codexCompactedTimelineIndex: Number(seed.codexCompactedTimelineIndex) || 0,
      turnCheckpoints: seed.turnCheckpoints || {},
      diffs: seed.diffs || [],
      pathMappings: seed.pathMappings || {},
      scriptTypes: seed.scriptTypes || {},
      studioErrors: Array.isArray(seed.studioErrors) ? seed.studioErrors : [],
      contextUsage: seed.contextUsage || null,
      provider,
      model,
    };

    migrateLegacyContextWindowActivities(chat, {
      fallbackProvider: provider,
      fallbackModel: model,
    });

    return chat;
  }

  create() {
    this.createInProject(this.app.activeProjectId);
  }

  createInProject(projectId, seed = {}) {
    const project = this.app.projects.find(p => p.id === projectId);
    if (!project) return;

    const chat = this.buildChat(seed);

    // Use store to add chat (handles deduplication)
    if (!store.addChat(projectId, chat)) {
      console.error('[CHAT] Failed to add chat (may be duplicate):', chat.id);
      return null;
    }
    project.expanded = true;
    this.app.projectManager.markChatDirty(chat.id, 'create', projectId, chat);
    this.app.projectManager.markProjectDirty(projectId, 'update', project);
    this.app.projectManager.save();
    this.app.chatSync?.scheduleChatCommit({ chatId: chat.id, reason: 'chat_create' });
    this.app.activeProjectId = projectId;
    this.setActive(chat.id, projectId);
    this.app.projectManager.renderList();
    // Boot the codex session in the background while the user types.
    this.app.prewarmCodexSession?.(chat);
    return chat;
  }

  async delete(chatId, projectId) {
    const project = this.app.projects.find(p => p.id === projectId);
    if (!project) return;

    const index = project.chats.findIndex(c => c.id === chatId);
    if (index === -1) return;
    let chatToDelete = project.chats[index];
    if (chatToDelete?._storageState === 'stub') {
      chatToDelete = await this.app.projectManager.ensureChatLoaded(chatToDelete, projectId) || chatToDelete;
    }
    this.app.chatSync?.scheduleChatCommit({
      chatId,
      reason: 'chat_delete',
      deletedChat: JSON.parse(JSON.stringify(chatToDelete)),
      projectId,
      projectDir: project.workingDir || null
    });

    this.app.projectManager.markChatDirty(chatId, 'delete');
    store.removeChat(chatId);
    this.app.projectManager.save();

    // Clean up stashed prompt for deleted chat
    if (this.app.promptStash.has(chatId)) {
      this.app.promptStash.delete(chatId);
      this.app.markPromptStashDirty();
    }
    this.app.composerImageStash.delete(chatId);

    // Clean up per-chat state for deleted chat
    this.app.wsManager?.send({
      type: 'delete_session',
      session_id: chatId
    });
    this.app.stopProcessingChat(chatId);
    this.app.setPendingMessage(chatId, null);
    this.app.messageQueues.delete(chatId);

    // If deleted the active chat, show welcome or switch to another
    if (this.app.activeChat?.id === chatId) {
      localStorage.removeItem('ropilot_active_chat');
      if (project.chats.length > 0) {
        this.setActive(project.chats[0].id, projectId);
      } else {
        // Try to find another chat in any project
        let foundChat = false;
        for (const p of this.app.projects) {
          if (p.chats.length > 0) {
            this.setActive(p.chats[0].id, p.id);
            foundChat = true;
            break;
          }
        }
        if (!foundChat) {
          this.app.activeChat = null;
          document.getElementById('welcome-screen').classList.remove('hidden');
          document.getElementById('chat-view').classList.add('hidden');
        }
      }
    }

    this.app.renderComposerImagePreview();
    this.app.updateSendButton();
    this.app.projectManager.renderList();
  }

  async setActive(chatId, projectId) {
    let chat = null;
    let foundProjectId = projectId;

    if (projectId) {
      const project = this.app.projects.find(p => p.id === projectId);
      if (project) {
        chat = project.chats.find(c => c.id === chatId);
      }
    }

    if (!chat) {
      for (const p of this.app.projects) {
        chat = p.chats.find(c => c.id === chatId);
        if (chat) {
          foundProjectId = p.id;
          break;
        }
      }
    }

    if (!chat) return;
    const activationSequence = ++this.activationSequence;

    // Auto-delete empty chat when switching away
    // (if user created a chat but never sent a message and has no draft)
    if (this.app.activeChat && this.app.activeChat.id !== chatId) {
      const prevChat = this.app.activeChat;
      const hasContent = prevChat.timeline && prevChat.timeline.some(
        item => item.type === 'user' || item.type === 'emit' || item.type === 'assistant'
      );
      const hasTextDraft = document.getElementById('input-message')?.value?.trim();
      const hasImageDraft = this.app.getComposerImages(prevChat.id).length > 0;
      const hasDraft = hasTextDraft || hasImageDraft;
      const isNewChat = prevChat.title === 'New Chat';

      if (!hasContent && !hasDraft && isNewChat) {
        console.log('[CHAT] Auto-deleting empty chat:', prevChat.id);
        // Find the project containing this chat
        for (const p of this.app.projects) {
          const idx = p.chats.findIndex(c => c.id === prevChat.id);
          if (idx !== -1) {
            this.app.projectManager.markChatDirty(prevChat.id, 'delete');
            p.chats.splice(idx, 1);
            this.app.projectManager.save();
            // Clean up stashed prompt
            this.app.promptStash.delete(prevChat.id);
            this.app.composerImageStash.delete(prevChat.id);
            // Re-render sidebar to remove the deleted chat
            this.app.projectManager.renderList();
            break;
          }
        }
      }
    }

    // Stash the current prompt before switching chats
    const input = document.getElementById('input-message');
    if (input && this.app.activeChat) {
      const currentText = input.value;
      if (currentText.trim()) {
        // Save non-empty prompt to stash
        this.app.promptStash.set(this.app.activeChat.id, currentText);
        this.app.markPromptStashDirty();
      } else {
        // Clear stash if prompt is empty (user cleared it)
        this.app.promptStash.delete(this.app.activeChat.id);
        this.app.markPromptStashDirty();
      }
    }

    if (chat?._storageState === 'stub') {
      chat = await this.app.projectManager.ensureChatLoaded(chat, foundProjectId) || chat;
      if (activationSequence !== this.activationSequence) {
        return;
      }
    }

    // The 'activeChatId' store subscription (app.js) renders on change, so
    // only render here when re-activating the already-active chat (the store
    // skips notification when the value is unchanged).
    const wasAlreadyActive = store.get('activeChatId') === chatId;
    store.setActiveChat(chatId);
    this.app.activeProjectId = foundProjectId;
    localStorage.setItem('ropilot_active_chat', chatId);

    const chatProvider = this.app.getChatProvider(chat);
    if (chat.provider !== chatProvider) {
      chat.provider = chatProvider;
      this.app.saveProjects();
    }
    const useRopilotCredits = this.app.isUseRopilotCreditsEnabled?.() === true;
    const legacyCreditsMigration = useRopilotCredits
      ? this.app.migrateLegacyRopilotCreditsChat?.(chat)
      : null;
    this.app.setModelProvider(chatProvider);
    const model = useRopilotCredits
      ? this.app.coerceRopilotCreditsModel(chat.model || this.app.selectedModel)
      : this.app.coerceModelForProvider(chatProvider, chat.model || this.app.selectedModel);
    const modelProvider = useRopilotCredits
      ? (this.app.getProviderForModel(model) || chatProvider)
      : chatProvider;
    if (legacyCreditsMigration || chat.provider !== modelProvider || chat.model !== model) {
      chat.provider = modelProvider;
      chat.model = model;
      chat.updatedAt = Date.now();
      this.app.saveProjects();
      this.app.chatSync?.scheduleChatCommit({ chatId: chat.id, reason: 'provider_metadata_change' });
    }
    this.app.modelProvider = modelProvider;
    localStorage.setItem('ropilot_model_provider', modelProvider);
    this.app.selectedModel = model;
    localStorage.setItem('ropilot_selected_model', model);

    // Debug logging
    if (!chat._debugId) chat._debugId = Math.random().toString(36).substr(2, 6);
    const playtests = chat.timeline?.filter(i => i.type === 'playtest') || [];
    console.log('[SWITCH] Switching to chat:', chatId, '_debugId:', chat._debugId,
      'timeline items:', chat.timeline?.length,
      'playtests:', playtests.map(p => ({ id: p.id, scriptsCount: p.scripts?.length })));

    // Update project directory
    const project = this.app.projects.find(p => p.id === foundProjectId);
    if (project) {
      this.app.projectDir = project.workingDir || null;
      this.app.updateProjectDirDisplay();
    }

    // Update UI. The sidebar caps how many chats it renders per project, so
    // re-render if the newly active chat has no DOM node yet (renderProjectChats
    // reveals the project containing the active chat).
    if (!document.querySelector(`.chat-item[data-chat-id="${chatId}"]`)) {
      this.app.projectManager.renderList();
    }
    document.querySelectorAll('.chat-item').forEach(el => {
      el.classList.toggle('active', el.dataset.chatId === chatId);
    });

    document.getElementById('welcome-screen').classList.add('hidden');
    // Don't show chat view if a setup screen is active (onboarding in progress)
    const setupScreenIds = [
      'setup-splash-screen',
      'anthropic-notice-screen',
      'setup-install-screen',
      'setup-auth-screen',
      'apikey-setup-screen',
      'advanced-input-setup-screen',
      'setup-screen',
      'plugin-setup-screen',
      'free-offer-claim-screen'
    ];
    const setupActive = setupScreenIds.some(id => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    });
    if (!setupActive) {
      document.getElementById('chat-view').classList.remove('hidden');
    }

    if (wasAlreadyActive) {
      this.app.messageRenderer.render();
    } else {
      // The subscription render ran while #chat-view could still be hidden
      // (display:none makes scrollHeight 0), so re-pin now that it's visible.
      scrollChatMessagesToEnd({ force: true });
    }

    // If this chat is processing but has no active status in DOM, recreate it
    // This handles edge cases where status was lost during chat switching
    if (this.app.isChatProcessing(chatId)) {
      const container = document.getElementById('messages');
      const hasActiveStatus = container?.querySelector('.message-status.status-active');
      if (!hasActiveStatus) {
        console.log('[SWITCH] Chat is processing but has no active status, recreating');
        this.app.showStatus('Working');
      }
    }

    // Update queue indicator to show messages queued for this chat
    this.app.updateQueueIndicator();

    // Update send button to reflect this chat's processing state
    this.app.updateSendButton();

    // Update pending message UI for this chat
    this.app.pendingMessageUI.showPending();

    // Restore stashed prompt for the new chat (or clear if none)
    const inputEl = document.getElementById('input-message');
    if (inputEl) {
      const stashedPrompt = this.app.getRestorablePromptDraft(chatId);
      inputEl.value = stashedPrompt;
      this.app.autoResizeTextarea(inputEl);
      this.app.slashCommandManager.updateForInput(stashedPrompt);
      this.app.renderComposerImagePreview();
      this.app.renderComposerContextUsage(chat);
      this.app.updateSendButton();
    }

    inputEl?.focus();

    // A prior process can exit before the final async billing top-up reaches
    // the renderer. Repair only the latest saved managed-credit label, and
    // only upward, from the authoritative per-turn settlement.
    void this.repairLatestManagedCreditsTurn(chat);
  }

  findById(chatId) {
    return store.getChatById(chatId);
  }

  startEditingName(chatId) {
    this.app.editingChatId = chatId;
    this.app.projectManager.renderList();

    setTimeout(() => {
      const input = document.querySelector(`.chat-name-input[data-chat-id="${chatId}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  finishEditingName(chatId, newName) {
    this.app.editingChatId = null;
    this.renameById(chatId, newName);
  }

  async renameById(chatId, newName) {
    for (const project of this.app.projects) {
      let chat = project.chats.find(c => c.id === chatId);
      if (chat) {
        if (chat?._storageState === 'stub') {
          chat = await this.app.projectManager.ensureChatLoaded(chat, project.id) || chat;
        }
        chat.title = newName.trim() || 'Untitled Chat';
        this.app.projectManager.queueTitleUpdate(chatId, chat.title);
        this.app.projectManager.save();
        this.app.chatSync?.scheduleChatCommit({ chatId, reason: 'chat_rename' });
        break;
      }
    }
    this.app.projectManager.renderList();
  }

  // One sidebar chat row, shaped like Synara's thread rows
  // (Sidebar.tsx renderThreadRow / renderPinnedThreadRow): provider mark,
  // a fading title, and a trailing slot whose status glyph yields to the
  // hover actions (Pin + Delete in Synara's Pin + Archive slots). Pinned
  // rows sit flush left and carry their project's name on the right.
  renderItem(chat, projectId, { pinned = false, projectLabel = '' } = {}) {
    const isActive = store.get('activeChatId') === chat.id;
    // Show spinner if THIS chat is being processed (per-chat state)
    const isProcessing = store.isChatProcessing(chat.id);
    const isEditing = this.app.editingChatId === chat.id;
    const title = typeof chat.title === 'string' ? chat.title : '';

    // Synara-style rows lead with the chat's provider mark; chats without one keep the bubble.
    // Like Synara, a chat still carrying the generic title shows no mark.
    const provider = typeof chat.provider === 'string' ? chat.provider.trim() : '';
    const isGenericTitle = /^new chat$/i.test(title.trim());
    const providerIcon = getProviderMarkSvg(provider) || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4.5 18.5V7a2.5 2.5 0 0 1 2.5-2.5h10A2.5 2.5 0 0 1 19.5 7v6.5A2.5 2.5 0 0 1 17 16H8.2l-2.9 2.9a.5.5 0 0 1-.8-.4Z"/>
          </svg>`;
    const pinLabel = pinned ? 'Unpin chat' : 'Pin chat';
    // Tabler pin / pin-filled (MIT): outline invites a pin, the fill marks a pinned chat
    const pinIcon = pinned
      ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.113 3.21l.094 .083l5.5 5.5a1 1 0 0 1 -1.175 1.59l-3.172 3.171l-1.424 3.797a1 1 0 0 1 -.158 .277l-.07 .08l-1.5 1.5a1 1 0 0 1 -1.32 .082l-.095 -.083l-2.793 -2.792l-3.793 3.792a1 1 0 0 1 -1.497 -1.32l.083 -.094l3.792 -3.793l-2.792 -2.793a1 1 0 0 1 -.083 -1.32l.083 -.094l1.5 -1.5a1 1 0 0 1 .258 -.187l.098 -.042l3.796 -1.425l3.171 -3.17a1 1 0 0 1 1.497 -1.26z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4"/><path d="M9 15l-4.5 4.5"/><path d="M14.5 4l5.5 5.5"/></svg>';

    return `
      <div class="chat-item${pinned ? ' chat-item--pinned' : ''}${isActive ? ' active' : ''}${isProcessing ? ' processing' : ''}${isEditing ? ' editing' : ''}" role="button" tabindex="0" aria-label="Open ${escapeHtml(title)}" data-chat-id="${chat.id}" data-project-id="${projectId}"${provider ? ` data-provider="${escapeHtml(provider)}"` : ''}>
        ${isGenericTitle ? '' : `<span class="chat-item-icon">${providerIcon}</span>`}
        <div class="chat-item-content">
          ${isEditing ? `
            <input type="text" class="chat-name-input" data-chat-id="${chat.id}" value="${escapeHtml(title)}" />
          ` : `<span class="chat-item-title">${escapeHtml(title)}</span>${pinned && projectLabel ? `<span class="chat-item-project">${escapeHtml(projectLabel)}</span>` : ''}`}
        </div>
        <div class="chat-item-trailing">
          ${isProcessing ? '<span class="chat-item-status" title="Working"><span class="chat-item-spinner"></span></span>' : ''}
          <div class="chat-item-actions">
            <button class="chat-item-pin" type="button" title="${pinLabel}" aria-label="${pinLabel}" aria-pressed="${pinned}">${pinIcon}</button>
            ${isProcessing ? '' : `<button class="chat-item-delete" type="button" title="Delete chat" aria-label="Delete chat">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>
            </button>`}
          </div>
        </div>
      </div>
    `;
  }

  getSidebarPreview(chat) {
    if (!Array.isArray(chat.timeline)) {
      return typeof chat._sidebarPreviewText === 'string' && chat._sidebarPreviewText.trim()
        ? chat._sidebarPreviewText.trim()
        : 'No messages';
    }

    const timeline = Array.isArray(chat.timeline) ? chat.timeline : [];
    const timelineLength = timeline.length;
    const lastTimelineItem = timelineLength > 0 ? timeline[timelineLength - 1] : null;
    const cache = chat._sidebarPreviewCache;

    if (cache && cache.timelineLength === timelineLength && cache.lastTimelineItem === lastTimelineItem) {
      return cache.preview;
    }

    let preview = 'No messages';
    for (let i = timelineLength - 1; i >= 0; i--) {
      const item = timeline[i];
      if (!item || (item.type !== 'user' && item.type !== 'assistant' && item.type !== 'emit')) {
        continue;
      }

      const text = typeof item.content === 'string' ? item.content.trim() : '';
      if (text) {
        preview = text.substring(0, 50);
      } else if (item.type === 'user' && Array.isArray(item.images) && item.images.length > 0) {
        preview = item.images.length === 1 ? '[Image attached]' : `[${item.images.length} images attached]`;
      }
      break;
    }

    chat._sidebarPreviewCache = {
      timelineLength,
      lastTimelineItem,
      preview,
    };
    return preview;
  }

  formatRelativeTime(timestampMs) {
    const ts = Number(timestampMs);
    if (!Number.isFinite(ts) || ts <= 0) return '';

    const elapsedMs = Math.max(0, Date.now() - ts);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    // Compact labels, Synara-style: now / 5m / 3h / 2d / 1w / 5mo / 1y
    if (elapsedMs < minute) return 'now';
    if (elapsedMs < hour) return `${Math.floor(elapsedMs / minute)}m`;
    if (elapsedMs < day) return `${Math.floor(elapsedMs / hour)}h`;

    const days = Math.floor(elapsedMs / day);
    if (days < 7) return `${days}d`;
    if (days < 30) return `${Math.floor(days / 7)}w`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
  }
}
