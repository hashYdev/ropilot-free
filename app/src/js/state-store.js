// Simple reactive state store for Ropilot
// Centralizes state management and ensures UI stays in sync.
//
// Event names (state keys + fire-and-forget signals) are enumerated in
// core/events.js. Mutation convention: containers are mutated in place and
// change is announced with an explicit notify(key, value, value) — set()
// no-ops on identical references, so don't switch to immutable updates
// without auditing re-render timing.

/**
 * @typedef {Object} Chat
 * @property {string} id
 * @property {string} [title]
 * @property {Array<Object>} [timeline]
 *
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} [name]
 * @property {Chat[]} chats
 *
 * @typedef {Object} ModelSelection
 * @property {string|null} provider - active model provider (claude/codex/ropilot)
 * @property {string|null} model - selected model value
 * @property {boolean} useRopilotCredits - managed credits vs BYO subscription
 * @property {boolean} codexFastMode - personal Codex fast (service_tier 'fast')
 * @property {boolean} ropilotCreditsFastMode - managed Fast (service_tier
 *   'priority', 2.5x credits); independent of codexFastMode on purpose so a
 *   BYO preference can never silently turn into a paid one
 * @property {Object<string, string>} reasoningLevelsByModel
 * @property {Object<string, string>} creditsReasoningLevelsByModel
 *
 * @typedef {Object} Credits
 * @property {number|null} actionsRemaining - account balance remaining (edge)
 * @property {number|null} actionsLimit - account balance cap, when metered
 * @property {string|null} userTier - account tier (e.g. 'free')
 * @property {boolean} bonusClaimed - free bonus actions already claimed
 *
 * @typedef {Object} AppState
 * @property {Project[]} projects
 * @property {string|null} activeChatId
 * @property {string|null} activeProjectId
 * @property {Set<string>} processingChatIds - chats with a turn in flight
 * @property {boolean} playtestActive
 * @property {string|null} activePlaytestPanelId
 * @property {string|null} activePlaytestChatId
 * @property {ModelSelection} modelSelection - seeded from localStorage by the
 *   app constructor; updated only via whole-object replacement (set() no-ops
 *   on identical references, so patches must build a new container)
 * @property {Credits} credits - session-only account credits state from the
 *   edge (no localStorage persistence); updated only via whole-object
 *   replacement, same as modelSelection
 */

export class StateStore {
  constructor() {
    /** @type {AppState} */
    this.state = {
      projects: [],
      activeChatId: null,
      activeProjectId: null,
      processingChatIds: new Set(),
      playtestActive: false,
      activePlaytestPanelId: null,
      activePlaytestChatId: null,
      modelSelection: {
        provider: null,
        model: null,
        useRopilotCredits: false,
        codexFastMode: false,
        ropilotCreditsFastMode: false,
        reasoningLevelsByModel: {},
        creditsReasoningLevelsByModel: {},
      },
      credits: {
        actionsRemaining: null,
        actionsLimit: null,
        userTier: null,
        bonusClaimed: false,
      },
    };

    this.listeners = new Map(); // key -> Set of callbacks
    this.derivedCache = new Map(); // Cache for derived values
  }

  // Get current state (read-only snapshot)
  get(key) {
    return this.state[key];
  }

  // Get derived value (computed from state)
  // Caches result until dependencies change
  getActiveChat() {
    const { projects, activeChatId } = this.state;
    if (!activeChatId) return null;

    for (const project of projects) {
      const chat = project.chats?.find(c => c.id === activeChatId);
      if (chat) return chat;
    }
    return null;
  }

  getActiveProject() {
    const { projects, activeProjectId } = this.state;
    return projects.find(p => p.id === activeProjectId) || projects[0];
  }

  getChatById(chatId) {
    if (!chatId) return null;
    for (const project of this.state.projects) {
      const chat = project.chats?.find(c => c.id === chatId);
      if (chat) return chat;
    }
    return null;
  }

  isChatProcessing(chatId) {
    return this.state.processingChatIds.has(chatId);
  }

  isAnyChatProcessing() {
    return this.state.processingChatIds.size > 0;
  }

  // Update state and notify listeners
  set(key, value) {
    const oldValue = this.state[key];
    if (oldValue === value) return; // No change

    this.state[key] = value;
    this.notify(key, value, oldValue);
  }

  // Batch multiple updates (single notification at end)
  batch(updates) {
    const changes = [];

    for (const [key, value] of Object.entries(updates)) {
      const oldValue = this.state[key];
      if (oldValue !== value) {
        this.state[key] = value;
        changes.push({ key, value, oldValue });
      }
    }

    // Notify all changes
    for (const { key, value, oldValue } of changes) {
      this.notify(key, value, oldValue);
    }
  }

  // Update projects array with automatic deduplication
  setProjects(projects) {
    // Deduplicate chats within each project
    for (const project of projects) {
      if (project.chats) {
        const seen = new Set();
        project.chats = project.chats.filter(chat => {
          if (seen.has(chat.id)) {
            console.warn('[STATE] Filtered duplicate chat:', chat.id);
            return false;
          }
          seen.add(chat.id);
          return true;
        });
      }
    }

    this.set('projects', projects);

    // Validate activeChatId still exists
    if (this.state.activeChatId && !this.getChatById(this.state.activeChatId)) {
      console.warn('[STATE] Active chat no longer exists, clearing');
      this.set('activeChatId', null);
    }
  }

  // Add a chat to a project
  addChat(projectId, chat) {
    const projects = this.state.projects;
    const project = projects.find(p => p.id === projectId);
    if (!project) return false;

    // Check for duplicate
    if (project.chats?.some(c => c.id === chat.id)) {
      console.warn('[STATE] Attempted to add duplicate chat:', chat.id);
      return false;
    }

    if (!project.chats) project.chats = [];
    project.chats.unshift(chat);

    // Trigger update
    this.notify('projects', projects, projects);
    return true;
  }

  // Remove a chat
  removeChat(chatId) {
    const projects = this.state.projects;

    for (const project of projects) {
      const idx = project.chats?.findIndex(c => c.id === chatId);
      if (idx !== undefined && idx !== -1) {
        project.chats.splice(idx, 1);

        // Clear active if this was the active chat
        if (this.state.activeChatId === chatId) {
          this.set('activeChatId', null);
        }

        // Clear processing state
        this.state.processingChatIds.delete(chatId);

        this.notify('projects', projects, projects);
        return true;
      }
    }
    return false;
  }

  // Set active chat (with validation)
  setActiveChat(chatId) {
    if (chatId && !this.getChatById(chatId)) {
      console.warn('[STATE] Cannot set active chat - does not exist:', chatId);
      return false;
    }
    this.set('activeChatId', chatId);
    return true;
  }

  // Processing state management
  startProcessing(chatId) {
    if (!this.state.processingChatIds.has(chatId)) {
      this.state.processingChatIds.add(chatId);
      this.notify('processingChatIds', this.state.processingChatIds);
    }
  }

  stopProcessing(chatId) {
    if (this.state.processingChatIds.has(chatId)) {
      this.state.processingChatIds.delete(chatId);
      this.notify('processingChatIds', this.state.processingChatIds);
    }
  }

  clearAllProcessing() {
    if (this.state.processingChatIds.size > 0) {
      this.state.processingChatIds.clear();
      this.notify('processingChatIds', this.state.processingChatIds);
    }
  }

  // Subscribe to state changes
  subscribe(key, callback) {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key).add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(key)?.delete(callback);
    };
  }

  // Subscribe to any state change
  subscribeAll(callback) {
    return this.subscribe('*', callback);
  }

  // Notify listeners of a change
  notify(key, value, oldValue) {
    // Notify specific listeners
    this.listeners.get(key)?.forEach(cb => {
      try {
        cb(value, oldValue, key);
      } catch (err) {
        console.error('[STATE] Listener error:', err);
      }
    });

    // Notify wildcard listeners
    this.listeners.get('*')?.forEach(cb => {
      try {
        cb(value, oldValue, key);
      } catch (err) {
        console.error('[STATE] Listener error:', err);
      }
    });
  }

  // Debug: log current state
  debug() {
    console.log('[STATE] Current state:', {
      projectCount: this.state.projects.length,
      activeChatId: this.state.activeChatId,
      activeProjectId: this.state.activeProjectId,
      processingChatIds: [...this.state.processingChatIds],
      playtestActive: this.state.playtestActive,
    });
  }

  // Playtest state management
  setPlaytestActive(active, panelId = null, chatId = null) {
    this.batch({
      playtestActive: active,
      activePlaytestPanelId: panelId,
      activePlaytestChatId: chatId
    });
  }

  // Timeline operations (for a specific chat)
  addToTimeline(chatId, item) {
    const chat = this.getChatById(chatId);
    if (!chat) return false;
    if (!chat.timeline) chat.timeline = [];
    item.timestamp = Date.now();
    chat.timeline.push(item);
    this.notify('chatTimeline', { chatId, item });
    return true;
  }

  // Update chat property
  updateChat(chatId, updates) {
    const chat = this.getChatById(chatId);
    if (!chat) return false;
    Object.assign(chat, updates);
    this.notify('chatUpdated', { chatId, updates });
    return true;
  }
}

// Singleton instance
export const store = new StateStore();
