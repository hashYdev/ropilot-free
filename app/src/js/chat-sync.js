// Chat Sync Service - handles syncing with edge server
const PENDING_SYNC_STORAGE_KEY = 'ropilot_pending_sync';
const MAX_STARTUP_PENDING_SYNC_BLOB_CHARS = 512 * 1024;
const MAX_PENDING_SYNC_CHANGE_CHARS = 128 * 1024;

export class ChatSyncService {
  constructor(getApiKey, getEdgeUrl) {
    this.getEdgeUrl = getEdgeUrl || (() => 'https://ropilot.ai/edge');
    this.getApiKey = getApiKey;
    this.syncInProgress = false;
    this.pendingChanges = [];
    this.lastSyncTime = null;
    this.isOnline = navigator.onLine;

    window.addEventListener('online', () => {
      this.isOnline = true;
      this.flushPendingChanges();
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
    });
  }

  getHeaders() {
    const apiKey = this.getApiKey();
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };
  }

  canSync() {
    return this.isOnline && !!this.getApiKey();
  }

  async fetchChats() {
    if (!this.canSync()) return null;

    try {
      const response = await fetch(`${this.getEdgeUrl()}/chats`, {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        if (response.status === 401) {
          console.warn('ChatSync: Invalid API key');
          return null;
        }
        throw new Error(`Server error: ${response.status}`);
      }

      const data = await response.json();
      this.lastSyncTime = Date.now();
      return data.projects || [];
    } catch (err) {
      console.error('ChatSync: Failed to fetch chats:', err);
      return null;
    }
  }

  async fetchChat(chatId) {
    if (!this.canSync()) return null;

    try {
      const response = await fetch(`${this.getEdgeUrl()}/chats/${chatId}`, {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (!response.ok) return null;
      return await response.json();
    } catch (err) {
      console.error('ChatSync: Failed to fetch chat:', err);
      return null;
    }
  }

  async saveProjects(projects) {
    if (!this.canSync()) {
      this.queueChange({ type: 'full_sync', projects });
      return false;
    }

    try {
      const response = await fetch(`${this.getEdgeUrl()}/chats/sync`, {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify({ projects })
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('ChatSync: Server response:', errorBody);
        throw new Error(`Server error: ${response.status} - ${errorBody}`);
      }

      this.lastSyncTime = Date.now();
      return true;
    } catch (err) {
      console.error('ChatSync: Failed to save projects:', err);
      this.queueChange({ type: 'full_sync', projects });
      return false;
    }
  }

  async createChat(projectId, chat) {
    if (!this.canSync()) {
      this.queueChange({ type: 'create_chat', projectId, chat });
      return false;
    }

    try {
      const response = await fetch(`${this.getEdgeUrl()}/chats`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ projectId, chat })
      });

      return response.ok;
    } catch (err) {
      console.error('ChatSync: Failed to create chat:', err);
      this.queueChange({ type: 'create_chat', projectId, chat });
      return false;
    }
  }

  async updateChat(chatId, updates) {
    if (!this.canSync()) {
      this.queueChange({ type: 'update_chat', chatId, updates });
      return false;
    }

    try {
      const response = await fetch(`${this.getEdgeUrl()}/chats/${chatId}`, {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(updates)
      });

      return response.ok;
    } catch (err) {
      console.error('ChatSync: Failed to update chat:', err);
      this.queueChange({ type: 'update_chat', chatId, updates });
      return false;
    }
  }

  async addTimelineItem(chatId, item) {
    return this.updateChat(chatId, { addTimelineItem: item });
  }

  async deleteChat(chatId) {
    if (!this.canSync()) {
      this.queueChange({ type: 'delete_chat', chatId });
      return false;
    }

    try {
      const response = await fetch(`${this.getEdgeUrl()}/chats/${chatId}`, {
        method: 'DELETE',
        headers: this.getHeaders()
      });

      return response.ok;
    } catch (err) {
      console.error('ChatSync: Failed to delete chat:', err);
      this.queueChange({ type: 'delete_chat', chatId });
      return false;
    }
  }

  async saveProject(project) {
    if (!this.canSync()) {
      this.queueChange({ type: 'save_project', project });
      return false;
    }

    try {
      const response = await fetch(`${this.getEdgeUrl()}/projects/${project.id}`, {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(project)
      });

      return response.ok;
    } catch (err) {
      console.error('ChatSync: Failed to save project:', err);
      this.queueChange({ type: 'save_project', project });
      return false;
    }
  }

  async deleteProject(projectId) {
    if (!this.canSync()) {
      this.queueChange({ type: 'delete_project', projectId });
      return false;
    }

    try {
      const response = await fetch(`${this.getEdgeUrl()}/projects/${projectId}`, {
        method: 'DELETE',
        headers: this.getHeaders()
      });

      return response.ok;
    } catch (err) {
      console.error('ChatSync: Failed to delete project:', err);
      this.queueChange({ type: 'delete_project', projectId });
      return false;
    }
  }

  queueChange(change) {
    change.timestamp = Date.now();
    this.pendingChanges.push(change);
    localStorage.setItem(PENDING_SYNC_STORAGE_KEY, JSON.stringify(this.pendingChanges));
  }

  estimatePendingChangeSize(change) {
    try {
      return JSON.stringify(change).length;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  normalizePendingChange(change) {
    if (!change || typeof change !== 'object') {
      return null;
    }

    const type = typeof change.type === 'string' ? change.type : '';
    if (!type) {
      return null;
    }

    const serializedLength = this.estimatePendingChangeSize(change);
    if (serializedLength > MAX_PENDING_SYNC_CHANGE_CHARS) {
      console.warn(`ChatSync: Dropping oversized pending change (${type}, ${serializedLength} chars)`);
      return null;
    }

    return change;
  }

  loadPendingChanges() {
    try {
      const stored = localStorage.getItem(PENDING_SYNC_STORAGE_KEY);
      if (stored) {
        if (stored.length > MAX_STARTUP_PENDING_SYNC_BLOB_CHARS) {
          console.warn(`ChatSync: Clearing oversized legacy pending sync blob (${stored.length} chars)`);
          localStorage.removeItem(PENDING_SYNC_STORAGE_KEY);
          this.pendingChanges = [];
          return;
        }

        const parsed = JSON.parse(stored);
        const normalized = Array.isArray(parsed)
          ? parsed
              .map((change) => this.normalizePendingChange(change))
              .filter(Boolean)
          : [];

        this.pendingChanges = normalized;
        if (normalized.length > 0) {
          localStorage.setItem(PENDING_SYNC_STORAGE_KEY, JSON.stringify(normalized));
        } else {
          localStorage.removeItem(PENDING_SYNC_STORAGE_KEY);
        }
      }
    } catch (err) {
      console.error('ChatSync: Failed to load pending changes:', err);
      this.pendingChanges = [];
    }
  }

  async flushPendingChanges() {
    if (!this.canSync() || this.pendingChanges.length === 0 || this.syncInProgress) {
      return;
    }

    this.syncInProgress = true;
    console.log(`ChatSync: Flushing ${this.pendingChanges.length} pending changes`);

    const changes = [...this.pendingChanges];
    this.pendingChanges = [];

    for (const change of changes) {
      try {
        switch (change.type) {
          case 'full_sync':
            await this.saveProjects(change.projects);
            break;
          case 'create_chat':
            await this.createChat(change.projectId, change.chat);
            break;
          case 'update_chat':
            await this.updateChat(change.chatId, change.updates);
            break;
          case 'delete_chat':
            await this.deleteChat(change.chatId);
            break;
          case 'save_project':
            await this.saveProject(change.project);
            break;
          case 'delete_project':
            await this.deleteProject(change.projectId);
            break;
        }
      } catch (err) {
        console.error('ChatSync: Failed to flush change:', change, err);
        this.pendingChanges.push(change);
      }
    }

    if (this.pendingChanges.length > 0) {
      localStorage.setItem(PENDING_SYNC_STORAGE_KEY, JSON.stringify(this.pendingChanges));
    } else {
      localStorage.removeItem(PENDING_SYNC_STORAGE_KEY);
    }

    this.syncInProgress = false;
  }
}
