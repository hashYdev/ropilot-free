import { resolveSiteUrlForApiKey } from './api-validation.js';

const DEFAULT_STORAGE_KEY = 'ropilot_chat_sync_commit_pending_v1';
const DEFAULT_DEBOUNCE_MS = 1500;
const LOG_PREFIX = '[CHAT_SYNC_COMMIT]';
const MAX_STARTUP_PENDING_COMMIT_BLOB_CHARS = 512 * 1024;
// A commit reads the whole agent transcript into the renderer and copies it
// several times. Past this size that freezes the UI and can OOM the renderer,
// which main.js answers with a reload (Oct 2026 "freezes and refreshes on every
// send"). Skip the upload instead of loading the file.
export const MAX_AGENT_TRANSCRIPT_BYTES = 48 * 1024 * 1024;
// A descriptor is persisted before each attempt and replayed on every launch,
// so a commit that can never succeed must eventually be dropped.
export const MAX_COMMIT_ATTEMPTS = 5;

export class ChatSyncCommitService {
  constructor(app, options = {}) {
    this.app = app;
    this.fileAdapter = options.fileAdapter || null;
    this.storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
    this.debounceMs = options.debounceMs || DEFAULT_DEBOUNCE_MS;
    this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
    this.localStorageRef = options.localStorageRef || localStorage;
    this.now = options.now || (() => Date.now());
    this.pendingByChatId = new Map();
    this.inFlightByChatId = new Map();
    this.followUpByChatId = new Set();
    this.debounceTimers = new Map();
    this.isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', () => {
        this.isOnline = true;
        void this.flushAllPendingCommits();
      });
      window.addEventListener('offline', () => {
        this.isOnline = false;
      });
    }
  }

  loadPendingCommits() {
    try {
      const raw = this.localStorageRef.getItem(this.storageKey);
      if (!raw) return;
      if (raw.length > MAX_STARTUP_PENDING_COMMIT_BLOB_CHARS) {
        console.warn(
          `${LOG_PREFIX} Clearing oversized legacy pending commit blob (${raw.length} chars)`
        );
        this.localStorageRef.removeItem(this.storageKey);
        this.pendingByChatId = new Map();
        return;
      }
      const parsed = JSON.parse(raw);
      this.pendingByChatId = new Map(
        Object.entries(parsed || {}).map(([chatId, descriptor]) => [chatId, this.normalizePendingDescriptor(chatId, descriptor)])
      );
      this.persistPendingCommits();
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to load pending commits:`, err);
      this.pendingByChatId = new Map();
    }
  }

  persistPendingCommits() {
    const serialized = {};
    for (const [chatId, descriptor] of this.pendingByChatId.entries()) {
      serialized[chatId] = descriptor;
    }
    this.localStorageRef.setItem(this.storageKey, JSON.stringify(serialized));
  }

  getEffectiveApiKey() {
    return typeof this.app.getEffectiveApiKey === 'function'
      ? this.app.getEffectiveApiKey()
      : this.app.apiKey;
  }

  getCommitEndpointUrl() {
    const apiKey = this.getEffectiveApiKey();
    const siteUrl = typeof this.app.config?.siteUrl === 'string' ? this.app.config.siteUrl.trim() : '';
    const edgeUrl = typeof this.app.config?.edgeUrl === 'string' ? this.app.config.edgeUrl.trim() : '';
    const edgeSiteUrl = edgeUrl.replace(/\/edge\/?$/, '');
    const fallbackSiteUrl = siteUrl || edgeSiteUrl;

    if (apiKey) {
      return `${resolveSiteUrlForApiKey(apiKey, fallbackSiteUrl)}/api/chat-sync/commit`;
    }

    if (siteUrl) {
      return `${siteUrl}/api/chat-sync/commit`;
    }

    return `${edgeSiteUrl}/api/chat-sync/commit`;
  }

  normalizePendingDescriptor(chatId, descriptor = {}) {
    return {
      chatId: descriptor.chatId || chatId,
      projectId: descriptor.projectId || null,
      projectDir: Object.prototype.hasOwnProperty.call(descriptor, 'projectDir') ? descriptor.projectDir : null,
      provider: descriptor.provider || null,
      claudeSessionId: Object.prototype.hasOwnProperty.call(descriptor, 'claudeSessionId') ? descriptor.claudeSessionId : null,
      codexThreadId: Object.prototype.hasOwnProperty.call(descriptor, 'codexThreadId') ? descriptor.codexThreadId : null,
      deletedChat: descriptor.deletedChat || null,
      reason: descriptor.reason || 'unknown',
      needsRetry: descriptor.needsRetry !== false,
      lastError: descriptor.lastError || null,
      lastHttpStatus: descriptor.lastHttpStatus || null,
      attemptCount: Number.isFinite(descriptor.attemptCount) ? descriptor.attemptCount : 0,
      lastAttemptAt: Number.isFinite(descriptor.lastAttemptAt) ? descriptor.lastAttemptAt : undefined
    };
  }

  buildPendingDescriptor(chatId, overrides = {}) {
    return this.app.projectManager?.syncManager?.buildChatCommitMetadata(chatId, overrides) || null;
  }

  async buildDescriptor(chatId, overrides = {}) {
    return this.app.projectManager?.syncManager?.buildChatSyncDescriptor(chatId, overrides) || null;
  }

  scheduleChatCommit({ chatId, reason = 'unknown', ...overrides }) {
    const descriptor = this.buildPendingDescriptor(chatId, overrides);
    if (!descriptor) {
      console.warn(`${LOG_PREFIX} Cannot schedule commit without descriptor:`, chatId, reason);
      return false;
    }

    const existing = this.pendingByChatId.get(chatId) || {};
    const next = this.normalizePendingDescriptor(chatId, {
      ...existing,
      ...descriptor,
      chatId: descriptor.chatId || chatId,
      reason,
      needsRetry: true,
      lastError: null,
      lastHttpStatus: null,
      attemptCount: Number.isFinite(existing.attemptCount) ? existing.attemptCount : 0
    });

    this.pendingByChatId.set(chatId, next);
    this.persistPendingCommits();

    if (this.inFlightByChatId.has(chatId)) {
      this.followUpByChatId.add(chatId);
      return true;
    }

    this.queueFlush(chatId, this.debounceMs);
    return true;
  }

  queueFlush(chatId, delayMs = this.debounceMs) {
    const existing = this.debounceTimers.get(chatId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(chatId);
      void this.flushChatCommit(chatId);
    }, delayMs);
    this.debounceTimers.set(chatId, timer);
  }

  async buildCommitPayload(chatId) {
    const pendingDescriptor = this.pendingByChatId.get(chatId) || null;
    const descriptor = await this.buildDescriptor(chatId, pendingDescriptor || {});
    if (!descriptor) {
      throw new Error(`Missing pending descriptor for chat ${chatId}`);
    }

    if (!this.fileAdapter?.resolveFiles || !this.fileAdapter?.readFile) {
      const error = new Error('Chat sync file adapter is not configured');
      error.code = 'SYNC_FILE_ADAPTER_UNAVAILABLE';
      throw error;
    }

    const resolved = await this.fileAdapter.resolveFiles({
      provider: descriptor.provider,
      chatId: descriptor.chatId,
      claudeSessionId: descriptor.claudeSessionId,
      codexThreadId: descriptor.codexThreadId,
      projectDir: descriptor.projectDir
    });
    if (!resolved?.success) {
      const error = new Error(resolved?.error || 'Failed to resolve chat sync files');
      error.code = resolved?.code || 'SYNC_FILE_RESOLVE_FAILED';
      throw error;
    }

    const transcriptBytes = Number(resolved.agent_chat_file?.sizeBytes) || 0;
    if (transcriptBytes > MAX_AGENT_TRANSCRIPT_BYTES) {
      const error = new Error(`Transcript is ${transcriptBytes} bytes; over the ${MAX_AGENT_TRANSCRIPT_BYTES} byte sync limit`);
      error.code = 'SYNC_TRANSCRIPT_TOO_LARGE';
      error.permanent = true;
      throw error;
    }

    const fileResult = await this.fileAdapter.readFile(resolved.agent_chat_file.filePath);
    if (!fileResult?.success) {
      const error = new Error(fileResult?.error || 'Failed to read chat sync file');
      error.code = fileResult?.code || 'SYNC_FILE_READ_FAILED';
      throw error;
    }

    console.log(
      `${LOG_PREFIX} Uploading chat ${descriptor.chatId}: ropilot=${descriptor.ropilot_chat_file?.content?.length || 0}B agent=${fileResult.sizeBytes || 0}B`
    );

    return {
      chat_id: descriptor.chatId,
      agent: resolved.agent,
      ropilot_chat_file: descriptor.ropilot_chat_file,
      agent_chat_file: {
        path: resolved.agent_chat_file.path,
        content: fileResult.content
      }
    };
  }

  async postCommit(payload) {
    const apiKey = this.getEffectiveApiKey();
    if (!apiKey) {
      const error = new Error('Missing API key');
      error.code = 'MISSING_API_KEY';
      throw error;
    }

    // Transcripts past a few MB were rejected by the server's old 5 MiB cap and
    // never synced. Send gzip when the runtime supports it (text transcripts
    // compress ~2-5x); the server accepts both forms.
    const json = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };
    let body = json;
    if (typeof CompressionStream === 'function' && json.length > 64 * 1024) {
      try {
        const compressed = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
        body = await new Response(compressed).arrayBuffer();
        headers['Content-Encoding'] = 'gzip';
      } catch (_) {
        body = json;
      }
    }

    const response = await this.fetchImpl(this.getCommitEndpointUrl(), {
      method: 'POST',
      headers,
      body
    });

    const rawBody = await response.text();
    let parsedBody = null;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch (_) {
        const error = new Error('Invalid endpoint JSON response');
        error.code = 'INVALID_ENDPOINT_JSON';
        error.status = response.status;
        throw error;
      }
    }

    if (!response.ok) {
      const error = new Error(parsedBody?.error || `Server error: ${response.status}`);
      error.code = response.status === 401 ? 'UNAUTHORIZED' : 'SERVER_ERROR';
      error.status = response.status;
      throw error;
    }

    return parsedBody;
  }

  shouldDeferForCurrentState(descriptor, { includeUnauthorized = false } = {}) {
    if (!descriptor) return true;
    if (!this.isOnline) return true;
    if (!this.getEffectiveApiKey()) return true;
    return descriptor.lastHttpStatus === 401 && !includeUnauthorized;
  }

  updatePendingFailure(chatId, err) {
    const descriptor = this.pendingByChatId.get(chatId);
    if (!descriptor) return;
    if (err?.permanent || (descriptor.attemptCount || 0) >= MAX_COMMIT_ATTEMPTS) {
      this.pendingByChatId.delete(chatId);
      this.followUpByChatId.delete(chatId);
      this.persistPendingCommits();
      console.warn(`${LOG_PREFIX} Dropping commit for ${chatId} after ${descriptor.attemptCount} attempts:`, err?.message || String(err));
      return;
    }
    descriptor.needsRetry = true;
    descriptor.lastError = err?.message || String(err);
    descriptor.lastHttpStatus = err?.status || null;
    this.pendingByChatId.set(chatId, descriptor);
    this.persistPendingCommits();
    console.warn(`${LOG_PREFIX} Commit failed for ${chatId}:`, descriptor.lastError);
  }

  async flushChatCommit(chatId, options = {}) {
    const descriptor = this.pendingByChatId.get(chatId);
    if (!descriptor) return false;
    if (this.inFlightByChatId.has(chatId)) {
      return this.inFlightByChatId.get(chatId);
    }
    if (this.shouldDeferForCurrentState(descriptor, options)) {
      return false;
    }

    const op = (async () => {
      try {
        descriptor.attemptCount = Number.isFinite(descriptor.attemptCount) ? descriptor.attemptCount + 1 : 1;
        descriptor.lastAttemptAt = this.now();
        this.pendingByChatId.set(chatId, descriptor);
        this.persistPendingCommits();

        const payload = await this.buildCommitPayload(chatId);
        await this.postCommit(payload);

        if (this.followUpByChatId.has(chatId)) {
          this.followUpByChatId.delete(chatId);
          this.queueFlush(chatId, 0);
        } else {
          this.pendingByChatId.delete(chatId);
          this.persistPendingCommits();
        }

        return true;
      } catch (err) {
        this.updatePendingFailure(chatId, err);
        return false;
      } finally {
        this.inFlightByChatId.delete(chatId);
      }
    })();

    this.inFlightByChatId.set(chatId, op);
    return op;
  }

  async flushAllPendingCommits(options = {}) {
    for (const chatId of [...this.pendingByChatId.keys()]) {
      await this.flushChatCommit(chatId, options);
    }
  }

  handleApiKeyChange() {
    for (const descriptor of this.pendingByChatId.values()) {
      if (descriptor.lastHttpStatus === 401) {
        descriptor.lastHttpStatus = null;
        descriptor.lastError = null;
      }
    }
    this.persistPendingCommits();
    void this.flushAllPendingCommits({ includeUnauthorized: true });
  }
}
