// Project Sync Manager - handles dirty tracking and cloud sync for projects
import { migrateLegacyContextWindowActivities } from './context-window.js';
import { compactDiffTimelineItem, enforceDiffRollbackCap } from './diff-preview.js';
import { store } from './state-store.js';
import { electronAPI } from './core/platform.js';
import * as storage from './core/storage.js';
import { createGoStorageAdapter } from './go-storage-adapter.js';

// Timelines at or past this length serialize per-item with event-loop yields
// (see serializeChatForStorage); shorter chats use one plain JSON.stringify.
const CHUNKED_SERIALIZE_MIN_TIMELINE_ITEMS = 64;

// Falling back to the legacy shell bridge means writing without CAS, backups or
// atomic replace — that is the precondition for a torn manifest. A single failed
// request used to condemn the whole session to it, so the Go endpoint now gets a
// bounded retry, several strikes, and a periodic re-probe before we give up.
const STORAGE_ATTEMPTS_PER_REQUEST = 3;
const STORAGE_RETRY_BASE_DELAY_MS = 150;
const STORAGE_FAILURE_TRIP_THRESHOLD = 3;
const STORAGE_REPROBE_BASE_DELAY_MS = 15000;
const STORAGE_REPROBE_MAX_DELAY_MS = 300000;

export class ProjectSyncManager {
  constructor(app) {
    this.app = app;
    this.syncTimer = null;
    this.pollTimer = null;
    this.localSaveTimer = null;
    this.localSaveDelayMs = 150;
    this.userDataPath = null; // Will be set during init
    this.storageRootPath = null;
    this.projectsManifestPath = null;
    this.legacyProjectsFilePath = null;
    this.persistedChatFiles = new Set();
    // chat file path -> { projectId, chatId }. Stale-file cleanup only knows the
    // path, but the Go delete endpoint addresses chats by id, so the mapping is
    // carried alongside instead of parsed back out of the path.
    this.persistedChatTargets = new Map();
    this.persistedChatHashes = new Map();
    this.persistedChatFingerprints = new Map();
    this.persistedManifestJson = null;
    // Chat ids whose files must be re-serialized on the next local flush.
    // Swapped out per-flush and restored if the flush fails, so a pending
    // change is never silently dropped. When in doubt, chats get marked.
    this.locallyDirtyChatIds = new Set();
    // Size of the biggest chat serialized by the last flush — scales the next
    // flush's debounce so giant chats aren't re-stringified every 150 ms.
    this.lastFlushLargestChatChars = 0;
    this.hydratingChats = new Map();
    this.legacyProjectsBackupContent = null;
    this.saveToStorageInProgress = false;
    this.saveToStorageQueued = false;
    this.localSaveFailureCount = 0;
    this.localSaveRetryTimer = null;
    // Suppress stale deletion until a complete post-recovery flush commits.
    this.storageRecoveryPending = false;
    // Sticky for the whole session: if storage ever needed recovery, the local
    // state is not trustworthy enough to sweep anything on disk. Unlike
    // storageRecoveryPending this is never cleared.
    this.storageRecoveryObserved = false;
    this.goStorage = null;
    this.goStorageAvailable = true;
    this.storageRevisions = new Map();
    // Consecutive hard failures of the Go storage endpoint. Reset by any
    // success; only a sustained run trips the legacy fallback.
    this.goStorageFailureStreak = 0;
    this.goStorageReprobeTimer = null;
    this.goStorageReprobeDelayMs = STORAGE_REPROBE_BASE_DELAY_MS;
    this.goStorageReprobeInFlight = false;
    // Routes an older Go binary does not implement (404). Cached so we probe
    // each optional endpoint at most once per session.
    this.goStorageMissingMethods = new Set();
    this.storageSweepRequested = false;

    // Dirty tracking for incremental sync
    // Each entry has { changeType: 'create' | 'update' | 'delete', data: {...} }
    this.dirtyProjects = new Map(); // projectId -> { changeType, project }
    this.dirtyChats = new Map();    // chatId -> { changeType, projectId, chat, updates }
    this.pendingMessages = new Map(); // chatId -> [messages to add]
    this.pendingTruncates = new Map(); // chatId -> truncateAfter index
    this.needsFullSync = false; // Fall back to full sync if incremental fails

    // Polling interval for multi-instance sync (30 seconds)
    this.pollInterval = 30000;
    this.lastServerCheck = 0;
  }

  // Start polling for server updates (enables multi-instance sync)
  startPolling() {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(async () => {
      await this.pollServerForUpdates();
    }, this.pollInterval);

    // Pause polling when window is hidden, resume when visible (with debounce)
    this.visibilityDebounce = null;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        console.log('[SYNC] Window hidden');
        if (this.visibilityDebounce) {
          clearTimeout(this.visibilityDebounce);
          this.visibilityDebounce = null;
        }
      } else {
        // Debounce visibility poll to avoid race conditions with pending local changes
        if (this.visibilityDebounce) clearTimeout(this.visibilityDebounce);
        this.visibilityDebounce = setTimeout(() => {
          console.log('[SYNC] Window visible, polling after debounce');
          this.pollServerForUpdates();
        }, 2000); // 2 second debounce
      }
    });

    console.log('[SYNC] Started polling for server updates every', this.pollInterval / 1000, 'seconds');
  }

  // Stop polling
  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log('[SYNC] Stopped polling for server updates');
    }
  }

  // Poll server for updates from other instances
  // DISABLED: Chat sync disabled pending efficiency improvements (version-based polling)
  async pollServerForUpdates() {
    return;

    /* eslint-disable no-unreachable */
    if (!this.app.chatSync.canSync()) return;

    // Don't poll if ANY chat is actively processing
    if (store.get('processingChatIds')?.size > 0) {
      console.log('[SYNC] Skipping poll - chat is processing');
      return;
    }

    // Don't poll if we have pending changes (our changes should go first)
    const hasPendingChanges = this.dirtyProjects.size > 0 ||
                               this.dirtyChats.size > 0 ||
                               this.pendingMessages.size > 0 ||
                               this.pendingTruncates.size > 0;
    if (hasPendingChanges) {
      console.log('[SYNC] Skipping poll - have pending changes');
      return;
    }

    try {
      const serverProjects = await this.app.chatSync.fetchChats();
      if (!serverProjects || serverProjects.length === 0) return;

      // Check if server has newer data by comparing timestamps
      let serverHasNewer = false;
      for (const serverProject of serverProjects) {
        const localProject = this.app.projects.find(p => p.id === serverProject.id);
        if (!localProject) {
          serverHasNewer = true;
          break;
        }
        for (const serverChat of serverProject.chats || []) {
          const localChat = localProject.chats?.find(c => c.id === serverChat.id);
          if (!localChat || (serverChat.updatedAt || 0) > (localChat.updatedAt || 0)) {
            serverHasNewer = true;
            break;
          }
        }
        if (serverHasNewer) break;
      }

      if (serverHasNewer) {
        if (store.get('processingChatIds')?.size > 0) {
          console.log('[SYNC] Aborting merge - chat started processing during fetch');
          return;
        }

        console.log('[SYNC] Server has newer data, merging...');
        const merged = this.mergeProjects(store.get('projects'), serverProjects);
        store.setProjects(merged);
        this.saveToLocal();
        console.log('[SYNC] Merged updates from server');
      }
    } catch (err) {
      console.warn('[SYNC] Poll failed:', err);
    }
    /* eslint-enable no-unreachable */
  }

  // Initialize filesystem paths
  async initFilesystem() {
    const api = electronAPI();
    if (api?.getUserDataPath) {
      this.userDataPath = await api.getUserDataPath();
      this.storageRootPath = `${this.userDataPath}/projects`;
      this.projectsManifestPath = `${this.storageRootPath}/manifest.json`;
      this.legacyProjectsFilePath = `${this.userDataPath}/projects.json`;
      if (typeof window?.fetch === 'function') {
        this.goStorage = createGoStorageAdapter({ electronApi: api });
      }
      console.log('[STORAGE] Using split filesystem storage:', this.projectsManifestPath);
    } else {
      console.log('[STORAGE] electronAPI not available, using localStorage fallback');
    }
  }

  getReadFile() {
    const api = electronAPI();
    return api?.readFileV2 || api?.readFile;
  }

  getWriteFile() {
    const api = electronAPI();
    return api?.writeFileV2 || api?.writeFile;
  }

  getDeleteFile() {
    const api = electronAPI();
    return api?.deleteFileV2 || api?.deleteFile;
  }

  getListFiles() {
    return electronAPI()?.listFiles;
  }

  getRenameFile() {
    return electronAPI()?.renameFile;
  }

  getStorageTarget(kind, projectId = null, chatId = null) {
    return {
      kind,
      ...(projectId ? { project_id: projectId } : {}),
      ...(chatId ? { chat_id: chatId } : {})
    };
  }

  getStorageRevisionKey(kind, projectId = null, chatId = null) {
    return `${kind}:${projectId || ''}:${chatId || ''}`;
  }

  storageDelay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // A request is worth retrying when the failure is about reaching the server,
  // not about the payload. Semantic conflicts (stale revision, corrupt file,
  // recovery required) are answers, not failures, and must not be retried.
  isRetriableStorageFailure(result) {
    if (!result || result.success) return false;
    if (result.code !== 'STORAGE_REQUEST_FAILED' && result.code !== 'STORAGE_UNAVAILABLE') return false;
    // 404 means this Go build lacks the route; retrying cannot help.
    if (result.httpStatus === 404) return false;
    return true;
  }

  // Issue one storage request with bounded retry + linear backoff. Only a
  // request that never got a usable answer is retried, and only for methods
  // that are safe to repeat (a commit is idempotent under CAS: the retry either
  // wins or comes back STORAGE_STALE_REVISION, which is not retried).
  async callGoStorageWithRetry(method, request) {
    let result = null;
    for (let attempt = 1; attempt <= STORAGE_ATTEMPTS_PER_REQUEST; attempt++) {
      result = await this.goStorage[method](request);
      if (!this.isRetriableStorageFailure(result)) return result;
      if (attempt < STORAGE_ATTEMPTS_PER_REQUEST) {
        await this.storageDelay(STORAGE_RETRY_BASE_DELAY_MS * attempt);
      }
    }
    return result;
  }

  noteGoStorageSuccess() {
    this.goStorageFailureStreak = 0;
    this.goStorageReprobeDelayMs = STORAGE_REPROBE_BASE_DELAY_MS;
  }

  // Record a hard failure. The legacy fallback only engages after a sustained
  // run of them, and even then a re-probe keeps trying to get back onto the
  // durable path — a transient blip must not condemn the whole session.
  noteGoStorageFailure(result) {
    this.goStorageFailureStreak += 1;
    if (this.goStorageFailureStreak < STORAGE_FAILURE_TRIP_THRESHOLD) {
      console.warn(
        `[STORAGE] Go durability request failed (${this.goStorageFailureStreak}/${STORAGE_FAILURE_TRIP_THRESHOLD}):`,
        result?.error || result?.code || 'unknown'
      );
      return false;
    }
    if (this.goStorageAvailable) {
      console.warn('[STORAGE] Go durability endpoint unavailable; using legacy shell bridge until re-probe succeeds');
    }
    this.goStorageAvailable = false;
    this.scheduleGoStorageReprobe();
    return true;
  }

  scheduleGoStorageReprobe() {
    if (this.goStorageReprobeTimer || !this.goStorage) return;
    const delayMs = this.goStorageReprobeDelayMs;
    this.goStorageReprobeTimer = setTimeout(() => {
      this.goStorageReprobeTimer = null;
      this.probeGoStorage().catch(() => {});
    }, delayMs);
    // Never hold the app open on a background probe.
    if (typeof this.goStorageReprobeTimer?.unref === 'function') {
      this.goStorageReprobeTimer.unref();
    }
  }

  // Cheap read-only health check. Loading the settings file touches the exact
  // code path the writes use without mutating anything.
  async probeGoStorage() {
    if (!this.goStorage || this.goStorageAvailable || this.goStorageReprobeInFlight) return false;
    this.goStorageReprobeInFlight = true;
    try {
      const result = await this.callGoStorageWithRetry('load', this.getStorageTarget('settings'));
      if (result && !this.isRetriableStorageFailure(result)) {
        this.goStorageAvailable = true;
        this.noteGoStorageSuccess();
        console.log('[STORAGE] Go durability endpoint recovered; leaving the legacy shell bridge');
        return true;
      }
      this.goStorageReprobeDelayMs = Math.min(STORAGE_REPROBE_MAX_DELAY_MS, this.goStorageReprobeDelayMs * 2);
      this.scheduleGoStorageReprobe();
      return false;
    } finally {
      this.goStorageReprobeInFlight = false;
    }
  }

  async tryGoStorage(method, target, content = undefined) {
    if (!this.goStorage || !this.goStorageAvailable) return null;
    if (this.goStorageMissingMethods.has(method)) return null;
    const revisionKey = this.getStorageRevisionKey(target.kind, target.project_id, target.chat_id);
    const request = { ...target };
    let committedContent = null;
    if (content !== undefined) {
      const currentRevision = this.storageRevisions.get(revisionKey);
      if (!Number.isFinite(currentRevision)) {
        const loaded = await this.tryGoStorage('load', target);
        if (!loaded) return null;
        if (!loaded.success && loaded.status !== 'missing') return loaded;
      }
      const expectedRevision = this.storageRevisions.get(revisionKey) || 0;
      const nextRevision = expectedRevision + 1;
      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      const revisionedContent = { ...parsed, storageRevision: nextRevision };
      request.content = revisionedContent;
      request.expected_revision = expectedRevision;
      committedContent = JSON.stringify(revisionedContent);
    }
    const result = await this.callGoStorageWithRetry(method, request);
    if (result?.httpStatus === 404) {
      // This Go build predates the route. Only that route is disabled; the rest
      // of the durable storage path keeps working.
      this.goStorageMissingMethods.add(method);
      console.warn(`[STORAGE] Go endpoint /${method} is not available in this build; using the legacy path for it`);
      return null;
    }
    if (result?.code === 'STORAGE_REQUEST_FAILED') {
      this.noteGoStorageFailure(result);
      return null;
    }
    if (result?.code === 'STORAGE_UNAVAILABLE') {
      this.noteGoStorageFailure(result);
      // A transport failure is ambiguous: the server may have committed the
      // request before the response was lost. Falling back here could overwrite
      // the same primary through the legacy bridge without CAS or a backup.
      return result;
    }
    // Anything that reached the server and produced a structured answer counts
    // as reachable, even a conflict — the durable path is working.
    this.noteGoStorageSuccess();
    if (result?.status === 'missing') {
      this.storageRevisions.set(revisionKey, 0);
    } else if (Number.isFinite(result?.revision)) {
      this.storageRevisions.set(revisionKey, result.revision);
    }
    if (result?.success && committedContent) {
      result.committedContent = committedContent;
    }
    return result;
  }

  async loadGoSettings() {
    const target = this.getStorageTarget('settings');
    const result = await this.tryGoStorage('load', target);
    if (!result) return null;
    if (result.success && result.content) return result.content;
    return result.status === 'missing' ? {} : null;
  }

  async saveGoSettings(settings) {
    const result = await this.tryGoStorage('commit', this.getStorageTarget('settings'), JSON.stringify(settings || {}));
    return result ? !!result.success : null;
  }

  async readStorageFile(target, legacyPath, readFile) {
    const result = await this.tryGoStorage('load', target);
    if (result) {
      if (result.success && result.content) {
        return {
          success: true,
          content: JSON.stringify(result.content),
          storageStatus: result.status,
          recovered: !!result.recovered,
          backup: result.backup,
          quarantine: result.quarantine
        };
      }
      if (result.status === 'missing') {
        return {
          success: false,
          error: result.deleted ? 'File was deleted' : 'File not found',
          notFound: true,
          deleted: !!result.deleted,
          storageStatus: 'missing'
        };
      }
      return {
        success: false,
        error: result.error || 'Storage read failed',
        storageStatus: result.status || 'read_error',
        code: result.code,
        quarantine: result.quarantine
      };
    }
    return readFile ? readFile(legacyPath) : { success: false, error: 'Storage unavailable' };
  }

  async writeStorageFile(target, legacyPath, content, writeFile) {
    const result = await this.tryGoStorage('commit', target, content);
    if (result) return result;
    return writeFile ? writeFile(legacyPath, content) : { success: false, error: 'Storage unavailable' };
  }

  // Commit a file, clearing the Go side's recovery latch if it trips.
  //
  // STORAGE_RECOVERY_REQUIRED means the Go service marked this target blocked
  // (a corrupt or unparseable primary). The latch lives in memory for the
  // lifetime of the Go process, so without an explicit /recover call every
  // subsequent commit for that target fails for the whole session — which is
  // exactly the state that used to abort every flush. /recover restores the
  // newest valid backup, and it refuses outright behind a tombstone, so a
  // deleted chat can never be resurrected through this path.
  async commitWithRecovery(target, legacyPath, content, writeFile) {
    const first = await this.writeStorageFile(target, legacyPath, content, writeFile);
    if (first?.success || first?.code !== 'STORAGE_RECOVERY_REQUIRED') {
      return first;
    }

    console.warn('[STORAGE][RECOVERY] Storage is latched; attempting recovery:', legacyPath);
    const recovered = await this.tryGoStorage('recover', target);
    if (!recovered?.success) {
      if (recovered?.code === 'STORAGE_DELETED') {
        // The user deleted this chat; the latch is irrelevant and the write
        // must not proceed. Surface the original failure untouched.
        console.warn('[STORAGE][RECOVERY] Refusing to recover a deleted target:', legacyPath);
        return first;
      }
      console.warn('[STORAGE][RECOVERY] Recovery failed:', legacyPath, recovered?.error || recovered?.code);
      return first;
    }

    // /recover resets the service revision to the restored backup's. If the
    // response did not carry one, the cached expected_revision is now stale —
    // drop it so the retry re-derives it with a load.
    if (!Number.isFinite(recovered?.revision)) {
      this.storageRevisions.delete(
        this.getStorageRevisionKey(target.kind, target.project_id, target.chat_id)
      );
    }
    console.log('[STORAGE][RECOVERY] Recovered storage; retrying commit:', legacyPath);
    return this.writeStorageFile(target, legacyPath, content, writeFile);
  }

  // Delete a chat through the Go endpoint so its `.backups` directory goes with
  // it and a tombstone blocks any later restore. Falls back to the legacy shell
  // bridge (primary only) when the Go build has no /delete route, which leaves
  // the pre-fix behaviour rather than failing the user's delete.
  async deleteStorageFile(target, legacyPath, deleteFile) {
    const result = await this.tryGoStorage('delete', target);
    if (result) {
      const revisionKey = this.getStorageRevisionKey(target.kind, target.project_id, target.chat_id);
      if (result.success) {
        this.storageRevisions.delete(revisionKey);
        return { success: true, deleted: true };
      }
      return { success: false, error: result.error || 'Storage delete failed', code: result.code };
    }
    if (!deleteFile) return { success: false, error: 'Storage unavailable' };
    const legacyResult = await deleteFile(legacyPath);
    if (legacyResult?.success) {
      this.storageRevisions.delete(this.getStorageRevisionKey(target.kind, target.project_id, target.chat_id));
    }
    return legacyResult;
  }

  // One-time sweep of `.backups` directories orphaned by the pre-tombstone
  // delete path. The Go side re-checks every safety condition itself and skips
  // the whole run whenever storage is mid-recovery; this only asks.
  async requestStorageSweep() {
    if (this.storageSweepRequested) return;
    if (!this.goStorage || !this.goStorageAvailable) return;
    // Never sweep while the renderer is reconciling a recovered manifest, and
    // never at all in a session that has seen a recovery — the on-disk state in
    // that session is exactly the state the sweep predicate can misread.
    if (this.storageRecoveryPending || this.storageRecoveryObserved) return;
    this.storageSweepRequested = true;
    try {
      const result = await this.tryGoStorage('sweep', { kind: 'sweep' });
      if (result?.skipped) {
        console.log('[STORAGE] Backup sweep skipped:', result.skipped);
      } else if (result?.swept) {
        console.log('[STORAGE] Backup sweep tombstoned', result.swept, 'orphaned chat backup directories');
      }
    } catch (err) {
      console.warn('[STORAGE] Backup sweep failed:', err);
    }
  }

  serializeStorageContent(content, fallback) {
    return typeof content === 'string' ? content : (content ? JSON.stringify(content) : fallback);
  }

  encodePathSegment(value) {
    return encodeURIComponent(String(value || 'unknown'));
  }

  getProjectFolderPath(projectId) {
    return `${this.storageRootPath}/${this.encodePathSegment(projectId)}`;
  }

  getChatFilePath(projectId, chatId) {
    return `${this.getProjectFolderPath(projectId)}/chats/${this.encodePathSegment(chatId)}.json`;
  }

  getChatCommitPath(projectId, chatId) {
    return `projects/${projectId}/chats/${chatId}.json`;
  }

  getProjectForChat(chatId) {
    for (const project of this.app.projects || []) {
      if ((project.chats || []).some((chat) => chat.id === chatId)) {
        return project;
      }
    }
    return null;
  }

  findProjectById(projectId) {
    return (this.app.projects || []).find((project) => project.id === projectId) || null;
  }

  isStorageStubChat(chat) {
    return !!chat && chat._storageState === 'stub';
  }

  // A chat whose file could not be read. What is in memory is a placeholder the
  // hydrate failure produced, never the user's content, so it must be treated
  // as read-only exactly like an un-hydrated stub.
  isStorageErrorChat(chat) {
    return !!chat && chat._storageState === 'error';
  }

  // Neither a stub (never hydrated) nor an error placeholder (hydrate failed)
  // carries real timeline data. Serializing either over its primary is how a
  // transient read failure turns into permanent chat loss.
  isUnwritableChat(chat) {
    return this.isStorageStubChat(chat) || this.isStorageErrorChat(chat);
  }

  // Streamable FNV-1a step: feeding string parts in order produces the same
  // state as one pass over their concatenation.
  hashStringInto(hash, input) {
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash;
  }

  computeStringHash(value) {
    const input = typeof value === 'string' ? value : String(value ?? '');
    return (this.hashStringInto(2166136261, input) >>> 0).toString(16);
  }

  markChatLocallyDirty(chatId) {
    if (chatId) {
      this.locallyDirtyChatIds.add(chatId);
    }
  }

  // O(1) structural fingerprint used as a safety net against mutations that
  // never marked the chat dirty. Any mismatch forces a reserialize; only an
  // in-place edit of a non-final timeline item with no count/updatedAt change
  // can slip past it, and those paths all go through markChatLocallyDirty.
  computeChatFingerprint(chat) {
    const timeline = Array.isArray(chat.timeline) ? chat.timeline : [];
    const last = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    return [
      chat.updatedAt || 0,
      chat.title || '',
      timeline.length,
      last ? `${last.type || ''}:${last.id ?? last.timestamp ?? ''}` : '',
      typeof last?.content === 'string' ? last.content.length : -1,
      last?.finalized ? 1 : 0,
      Array.isArray(chat.activities) ? chat.activities.length : 0,
      Array.isArray(chat.diffs) ? chat.diffs.length : 0,
      Array.isArray(chat.studioErrors) ? chat.studioErrors.length : 0,
      chat.claudeSessionId || '',
      chat.codexThreadId || '',
      chat.provider || '',
      chat.model || '',
      chat.hasHistory ? 1 : 0,
      Number(chat.codexCompactedTimelineIndex) || 0,
      chat.pathMappings ? Object.keys(chat.pathMappings).length : 0,
      chat.scriptTypes ? Object.keys(chat.scriptTypes).length : 0,
      chat.sourcecontrolState ? Object.keys(chat.sourcecontrolState).length : 0,
      chat.turnCheckpoints ? Object.keys(chat.turnCheckpoints).length : 0,
      chat.contextUsage ? (chat.contextUsage.updatedAt || 1) : 0,
    ].join('\u0001');
  }

  getChatStoragePath(projectId, chat) {
    return this.getChatFilePath(projectId, chat?.id);
  }

  buildChatPreview(chat) {
    if (!chat || typeof chat !== 'object') {
      return 'No messages';
    }

    if (typeof chat._sidebarPreviewText === 'string' && chat._sidebarPreviewText.trim()) {
      return chat._sidebarPreviewText.trim().substring(0, 50);
    }

    const timeline = Array.isArray(chat.timeline) ? chat.timeline : [];
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (!item || (item.type !== 'user' && item.type !== 'assistant' && item.type !== 'emit')) {
        continue;
      }

      const text = typeof item.content === 'string' ? item.content.trim() : '';
      if (text) {
        return text.substring(0, 50);
      }
      if (item.type === 'user' && Array.isArray(item.images) && item.images.length > 0) {
        return item.images.length === 1 ? '[Image attached]' : `[${item.images.length} images attached]`;
      }
      break;
    }

    return 'No messages';
  }

  createStorageStubChat(projectId, ref = {}) {
    return {
      id: ref.id,
      title: ref.title || 'New Chat',
      timeline: null,
      activities: null,
      createdAt: ref.createdAt || Date.now(),
      updatedAt: ref.updatedAt || ref.createdAt || Date.now(),
      sourcecontrolState: {},
      claudeSessionId: ref.claudeSessionId || null,
      codexThreadId: ref.codexThreadId || null,
      hasHistory: !!ref.hasHistory,
      codexCompactedTimelineIndex: Number(ref.codexCompactedTimelineIndex) || 0,
      turnCheckpoints: ref.turnCheckpoints || {},
      diffs: [],
      pathMappings: {},
      scriptTypes: {},
      studioErrors: [],
      contextUsage: null,
      provider: ref.provider || this.app.modelProvider,
      model: ref.model || this.app.selectedModel,
      _storageState: 'stub',
      _chatFilePath: typeof ref.file === 'string' && ref.file
        ? ref.file
        : this.getChatFilePath(projectId, ref.id),
      _sidebarPreviewText: typeof ref.previewText === 'string' ? ref.previewText : 'No messages'
    };
  }

  normalizeChatForRuntime(chat, { allowStub = false } = {}) {
    if (!chat || typeof chat !== 'object') {
      return chat;
    }

    if (allowStub && this.isStorageStubChat(chat)) {
      return chat;
    }

    // An error placeholder must keep its marker across normalization. Clearing
    // it would leave a perfectly ordinary-looking chat with an empty timeline,
    // which the next flush happily writes over the good file that merely failed
    // to read. Shape fixups still run so the UI can render it.
    const wasStorageError = this.isStorageErrorChat(chat);

    if (!Array.isArray(chat.timeline)) {
      chat.timeline = [];
    }
    if (!Array.isArray(chat.activities)) {
      chat.activities = [];
    }
    if (!Array.isArray(chat.diffs)) {
      chat.diffs = [];
    }
    if (!Array.isArray(chat.studioErrors)) {
      chat.studioErrors = [];
    }
    if (!chat.pathMappings || typeof chat.pathMappings !== 'object') {
      chat.pathMappings = {};
    }
    if (!chat.scriptTypes || typeof chat.scriptTypes !== 'object') {
      chat.scriptTypes = {};
    }
    if (!chat.sourcecontrolState || typeof chat.sourcecontrolState !== 'object') {
      chat.sourcecontrolState = {};
    }
    if (!chat.turnCheckpoints || typeof chat.turnCheckpoints !== 'object') {
      chat.turnCheckpoints = {};
    }
    if (!chat.provider) {
      chat.provider = this.app.modelProvider;
    }
    if (!chat.model) {
      chat.model = this.app.selectedModel;
    }

    // One-time migration of legacy diff timeline items (they embed full file
    // contents) to the compact v2 format, plus the rollback-entry cap. Cheap
    // once migrated (per-item idempotency fast path). Marked dirty so the
    // next flush persists the shrunken file.
    let compacted = false;
    for (const item of chat.timeline) {
      compacted = compactDiffTimelineItem(item) || compacted;
    }
    compacted = enforceDiffRollbackCap(chat) || compacted;
    if (compacted) {
      this.markChatLocallyDirty(chat.id);
      try {
        this.markChatForFullUpdate(chat.id);
      } catch {
        // app.projects may not be initialized during the initial storage load
      }
    }

    migrateLegacyContextWindowActivities(chat, {
      fallbackProvider: chat.provider || this.app.modelProvider,
      fallbackModel: chat.model || this.app.selectedModel,
    });

    delete chat._storageState;
    if (wasStorageError) {
      chat._storageState = 'error';
    }
    if (typeof chat._sidebarPreviewText !== 'string') {
      delete chat._sidebarPreviewText;
    }

    return chat;
  }

  materializeStubChat(chat) {
    if (!chat || typeof chat !== 'object') {
      return chat;
    }

    if (!Array.isArray(chat.timeline)) {
      chat.timeline = [];
    }
    if (!Array.isArray(chat.activities)) {
      chat.activities = [];
    }
    delete chat._storageState;
    return this.normalizeChatForRuntime(chat);
  }

  // Remove a chat that the Go side reports as tombstoned from the in-memory
  // project tree. Only ever called for a chat the user explicitly deleted, and
  // only when a tombstone (not a missing file) says so.
  removeDeletedChatReference(projectId, chatId) {
    const project = this.findProjectById(projectId);
    if (!project || !Array.isArray(project.chats)) return;
    const index = project.chats.findIndex((entry) => entry?.id === chatId);
    if (index === -1) return;
    project.chats.splice(index, 1);
    const chatPath = this.getChatFilePath(projectId, chatId);
    this.persistedChatFiles.delete(chatPath);
    this.persistedChatTargets.delete(chatPath);
    this.persistedChatHashes.delete(chatPath);
    this.persistedChatFingerprints.delete(chatPath);
    // Force a manifest rewrite on the next flush so the stale reference goes.
    this.persistedManifestJson = null;
    this.saveToLocal();
  }

  async ensureChatLoaded(chatOrId, projectId = null) {
    const chat = typeof chatOrId === 'string'
      ? (projectId
        ? this.findProjectById(projectId)?.chats?.find((entry) => entry.id === chatOrId)
        : this.findChatById(chatOrId))
      : chatOrId;

    if (!chat) {
      return null;
    }
    // Error placeholders are retried, not latched: the read may have failed for
    // a transient reason, and a chat that can never re-hydrate is a chat the
    // user can never use again this session.
    if (!this.isUnwritableChat(chat)) {
      return this.normalizeChatForRuntime(chat);
    }

    const resolvedProjectId = projectId || this.getProjectForChat(chat.id)?.id || 'default';
    const chatPath = this.getChatStoragePath(resolvedProjectId, chat);
    if (!chatPath) {
      return this.materializeStubChat(chat);
    }

    if (this.hydratingChats.has(chatPath)) {
      return this.hydratingChats.get(chatPath);
    }

    const loadPromise = (async () => {
      const readFile = this.getReadFile();
      if (!readFile) {
        return this.materializeStubChat(chat);
      }

      try {
        const chatResult = await this.readStorageFile(
          this.getStorageTarget('chat', resolvedProjectId, chat.id),
          chatPath,
          readFile
        );
        if (chatResult.success && chatResult.content) {
          const loadedChat = this.normalizeChatForRuntime(JSON.parse(chatResult.content));
          const preservedDebugId = chat._debugId;
          for (const key of Object.keys(chat)) {
            delete chat[key];
          }
          Object.assign(chat, loadedChat);
          chat._chatFilePath = chatPath;
          if (preservedDebugId) {
            chat._debugId = preservedDebugId;
          }
          delete chat._sidebarPreviewCache;
          return chat;
        }
        if (chatResult.deleted) {
          // A tombstone says the user deleted this chat; an older manifest is
          // still referencing it. Drop the reference instead of showing an
          // error stub, and let the next flush rewrite the manifest without it.
          console.log('[STORAGE] Dropping manifest reference to a deleted chat:', chatPath);
          this.removeDeletedChatReference(resolvedProjectId, chat.id);
          return null;
        }
      } catch (err) {
        console.warn('[STORAGE] Failed to hydrate chat file:', chatPath, err);
      }

      console.error('[STORAGE] Chat file is unavailable; preserving a read-only error stub:', chatPath);
      chat._storageState = 'error';
      chat._storageError = 'Chat data could not be read. Restore a backup before editing this chat.';
      return chat;
    })();

    this.hydratingChats.set(chatPath, loadPromise);
    try {
      return await loadPromise;
    } finally {
      if (this.hydratingChats.get(chatPath) === loadPromise) {
        this.hydratingChats.delete(chatPath);
      }
    }
  }

  async prepareProjectsForSync(projects = this.app.projects) {
    const prepared = [];
    for (const project of projects || []) {
      prepared.push(await this.prepareProjectForSync(project));
    }
    return prepared;
  }

  buildStorageManifest(projects) {
    return {
      version: 2,
      projects: (projects || []).map((project) => ({
        id: project.id,
        name: project.name,
        expanded: project.expanded,
        createdAt: project.createdAt,
        workingDir: project.id === 'default' ? null : (project.workingDir ?? null),
        apiKey: project.apiKey,
        customPrompt: project.customPrompt,
        chatRefs: (project.chats || []).map((chat) => ({
          id: chat.id,
          file: this.getChatStoragePath(project.id, chat),
          title: chat.title,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          provider: chat.provider,
          model: chat.model,
          claudeSessionId: chat.claudeSessionId || null,
          codexThreadId: chat.codexThreadId || null,
          hasHistory: !!chat.hasHistory,
          codexCompactedTimelineIndex: Number(chat.codexCompactedTimelineIndex) || 0,
          turnCheckpoints: chat.turnCheckpoints || {},
          previewText: this.buildChatPreview(chat)
        }))
      }))
    };
  }

  normalizeProjectsForRuntime(projects) {
    const normalized = Array.isArray(projects) ? projects : [];

    for (const project of normalized) {
      if (!Array.isArray(project.chats)) {
        project.chats = [];
      }
      this.deduplicateProjectChats(project);
      for (const chat of project.chats) {
        if (!chat || typeof chat !== 'object') {
          continue;
        }
        if (this.isStorageStubChat(chat)) {
          continue;
        }
        this.normalizeChatForRuntime(chat);
      }
    }

    if (!normalized.find(p => p.id === 'default')) {
      normalized.unshift({ id: 'default', name: 'Default', chats: [], expanded: true, createdAt: 0 });
    }

    const defaultProject = normalized.find(p => p.id === 'default');
    if (defaultProject && defaultProject.workingDir) {
      defaultProject.workingDir = null;
    }

    return normalized;
  }

  updatePersistedStorageSnapshot(projects, manifestJson = null) {
    const nextFiles = new Set();
    const nextTargets = new Map();
    for (const project of projects || []) {
      for (const chat of project.chats || []) {
        const chatPath = this.getChatStoragePath(project.id, chat);
        nextFiles.add(chatPath);
        if (chat?.id) {
          nextTargets.set(chatPath, { projectId: project.id, chatId: chat.id });
        }
      }
    }
    this.persistedChatFiles = nextFiles;
    this.persistedChatTargets = nextTargets;
    this.persistedChatHashes = new Map(
      [...this.persistedChatHashes.entries()].filter(([chatPath]) => nextFiles.has(chatPath))
    );
    this.persistedChatFingerprints = new Map(
      [...this.persistedChatFingerprints.entries()].filter(([chatPath]) => nextFiles.has(chatPath))
    );
    this.persistedManifestJson = manifestJson || JSON.stringify(this.buildStorageManifest(projects || []), null, 2);
  }

  parseStorageManifest(content) {
    const manifest = JSON.parse(content);
    if (!manifest || manifest.version !== 2 || !Array.isArray(manifest.projects)) {
      throw new Error('Split manifest missing or invalid version');
    }
    return manifest;
  }

  projectsFromStorageManifest(manifest) {
    const projects = [];
    for (const storedProject of manifest.projects) {
      const { chatRefs, chats, ...projectData } = storedProject || {};
      const refs = Array.isArray(chatRefs) ? chatRefs : [];
      const stubChats = refs
        .filter((ref) => !!ref?.id)
        .map((ref) => this.createStorageStubChat(projectData.id, ref));

      // Accept inline chats as a last-resort compatibility path.
      const fallbackChats = Array.isArray(chats) ? chats : [];
      projects.push({
        ...projectData,
        chats: stubChats.length > 0 ? stubChats : fallbackChats
      });
    }
    return this.normalizeProjectsForRuntime(projects);
  }

  countProjectChats(projects) {
    return (projects || []).reduce((count, project) => count + (project.chats?.length || 0), 0);
  }

  isNotFoundResult(result) {
    return !!result?.notFound || /not found|enoent/i.test(String(result?.error || ''));
  }

  latestChatTimestamp(chat) {
    let latest = 0;
    for (const item of chat?.timeline || []) {
      const value = item?.timestamp ?? item?.createdAt ?? item?.updatedAt;
      const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
      if (Number.isFinite(timestamp)) {
        latest = Math.max(latest, timestamp);
      }
    }
    const fallback = typeof chat?.updatedAt === 'number'
      ? chat.updatedAt
      : Date.parse(chat?.updatedAt || chat?.createdAt || '');
    return Math.max(latest, Number.isFinite(fallback) ? fallback : 0);
  }

  // True for anything under `/chats/` that is not a live primary chat file:
  // backup copies (`<chat>.json.backups/<stamp>.json`) and corruption
  // quarantines (`<chat>.json.corrupt-<ns>`). Both are `.json` paths under
  // `/chats/`, so a naive filter treats them as real chats.
  isNonPrimaryChatPath(normalizedPath) {
    return normalizedPath.includes('.backups/') || normalizedPath.includes('.corrupt');
  }

  // Tombstones (`<chat>.json.deleted`) are written by the Go delete endpoint and
  // mark a chat as intentionally deleted. Rebuild must honour them or it
  // undeletes chats straight off the disk.
  collectTombstonedChatPaths(files) {
    const tombstoned = new Set();
    for (const filePath of files || []) {
      const normalizedPath = String(filePath).replace(/\\/g, '/');
      if (!normalizedPath.endsWith('.json.deleted') || !normalizedPath.includes('/chats/')) {
        continue;
      }
      tombstoned.add(normalizedPath.slice(0, -'.deleted'.length));
    }
    return tombstoned;
  }

  // Harvest project names/workingDirs from any manifest still readable on disk:
  // the Go backup chain (`manifest.json.backups/*.json`), the legacy `.bak`, and
  // corruption quarantines. Strictly read-only and best effort — a folder name
  // is worth recovering, but never at the cost of restoring stale chat refs.
  async recoverProjectMetadata(files, readFile) {
    const metadata = new Map();
    if (typeof readFile !== 'function' || !this.projectsManifestPath) return metadata;

    const normalizedManifest = this.projectsManifestPath.replace(/\\/g, '/');
    const candidates = [];
    for (const filePath of files || []) {
      const normalizedPath = String(filePath).replace(/\\/g, '/');
      const isBackup = normalizedPath.startsWith(`${normalizedManifest}.backups/`) && normalizedPath.endsWith('.json');
      const isLegacyBak = normalizedPath === `${normalizedManifest}.bak`;
      const isQuarantine = normalizedPath.includes('/manifest.corrupt-') || normalizedPath.startsWith(`${normalizedManifest}.corrupt`);
      if (isBackup || isLegacyBak || isQuarantine) {
        candidates.push(filePath);
      }
    }
    // Newest first: the most recent manifest that still parses wins.
    candidates.sort((a, b) => String(b).localeCompare(String(a)));

    for (const candidate of candidates) {
      try {
        const result = await readFile(candidate);
        if (!result?.success || !result.content) continue;
        const parsed = JSON.parse(result.content);
        if (!parsed || !Array.isArray(parsed.projects)) continue;
        for (const project of parsed.projects) {
          const projectId = project?.id;
          if (!projectId || metadata.has(projectId)) continue;
          const name = typeof project.name === 'string' && project.name.trim() ? project.name : null;
          const workingDir = typeof project.workingDir === 'string' && project.workingDir ? project.workingDir : null;
          if (name || workingDir) {
            metadata.set(projectId, { name, workingDir });
          }
        }
      } catch {
        // An unreadable or invalid manifest simply contributes no names.
      }
    }
    if (metadata.size > 0) {
      console.log('[STORAGE][RECOVERY] Recovered folder names for', metadata.size, 'projects from an older manifest');
    }
    return metadata;
  }

  // Re-attach chat files that exist on disk but have no manifest reference.
  //
  // A flush that aborted before its manifest write leaves exactly this state:
  // the chat's `.json` primary is committed, the manifest still describes the
  // world as it was before, and on the next launch the chat is simply absent
  // from the sidebar even though the data is intact. This runs after a healthy
  // manifest load and puts those orphans back.
  //
  // Deliberately narrow, because the reverse mistake — resurrecting chats the
  // user deleted — is worse than the bug it fixes:
  //   * tombstones (`<chat>.json.deleted`) veto absolutely, and are the only
  //     durable record of an intentional delete;
  //   * backups and corruption quarantines are excluded by the same filter the
  //     recovery rebuild uses, so old copies never come back;
  //   * a chat id already present anywhere in the manifest is left alone.
  // Cost is one directory listing plus a read per orphan, so a healthy install
  // (no orphans) pays for the listing only.
  async reconcileOrphanedChatFiles(projects, readFile) {
    const listFiles = this.getListFiles();
    if (typeof listFiles !== 'function' || !this.storageRootPath || typeof readFile !== 'function') {
      return 0;
    }

    const knownChatIds = new Set();
    const knownChatPaths = new Set();
    const projectsById = new Map();
    for (const project of projects || []) {
      projectsById.set(project.id, project);
      for (const chat of project.chats || []) {
        if (chat?.id) knownChatIds.add(chat.id);
        knownChatPaths.add(this.getChatStoragePath(project.id, chat).replace(/\\/g, '/'));
      }
    }

    let listResult;
    try {
      listResult = await listFiles(this.storageRootPath);
    } catch (err) {
      console.warn('[STORAGE] Orphan reconciliation skipped; listing failed:', err);
      return 0;
    }
    if (!listResult?.success || !Array.isArray(listResult.files)) {
      return 0;
    }

    const tombstonedChatPaths = this.collectTombstonedChatPaths(listResult.files);
    const normalizedRoot = this.storageRootPath.replace(/\\/g, '/').replace(/\/$/, '');
    const orphanPaths = [];
    for (const filePath of listResult.files) {
      const normalizedPath = String(filePath).replace(/\\/g, '/');
      if (!normalizedPath.endsWith('.json') || !normalizedPath.includes('/chats/')) continue;
      if (this.isNonPrimaryChatPath(normalizedPath)) continue;
      if (tombstonedChatPaths.has(normalizedPath)) continue;
      if (knownChatPaths.has(normalizedPath)) continue;
      orphanPaths.push(filePath);
    }
    if (orphanPaths.length === 0) return 0;

    let restored = 0;
    for (const orphanPath of orphanPaths) {
      const normalizedPath = String(orphanPath).replace(/\\/g, '/');
      let parsed = null;
      try {
        const result = await readFile(orphanPath);
        if (!result?.success || !result.content) continue;
        parsed = JSON.parse(result.content);
      } catch (err) {
        console.warn('[STORAGE] Ignoring unreadable orphan chat file:', orphanPath, err);
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.id) continue;
      // The same id under a different path is already represented; adding it
      // again would produce a duplicate sidebar entry pointing at stale data.
      if (knownChatIds.has(parsed.id)) continue;

      const relativePath = normalizedPath.startsWith(`${normalizedRoot}/`)
        ? normalizedPath.slice(normalizedRoot.length + 1)
        : normalizedPath;
      const pathParts = relativePath.split('/');
      const chatsIndex = pathParts.lastIndexOf('chats');
      let projectId = 'default';
      if (chatsIndex > 0) {
        try {
          projectId = decodeURIComponent(pathParts[chatsIndex - 1]) || 'default';
        } catch {
          projectId = pathParts[chatsIndex - 1] || 'default';
        }
      }

      let project = projectsById.get(projectId);
      if (!project) {
        // The whole project folder lost its manifest entry. Recreate a husk so
        // the chats are reachable; the name is cosmetic and the user can rename.
        project = {
          id: projectId,
          name: projectId === 'default' ? 'Default' : projectId,
          chats: [],
          expanded: true,
          createdAt: parsed.createdAt || Date.now(),
          workingDir: null
        };
        projects.push(project);
        projectsById.set(projectId, project);
      }
      if (!Array.isArray(project.chats)) project.chats = [];

      // Re-add as a stub: identical to how the manifest path materializes a
      // chat, so the timeline stays lazily hydrated and nothing is rewritten.
      project.chats.push(this.createStorageStubChat(projectId, {
        id: parsed.id,
        file: orphanPath,
        title: parsed.title,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        claudeSessionId: parsed.claudeSessionId,
        codexThreadId: parsed.codexThreadId,
        hasHistory: parsed.hasHistory,
        codexCompactedTimelineIndex: parsed.codexCompactedTimelineIndex,
        turnCheckpoints: parsed.turnCheckpoints,
        provider: parsed.provider,
        model: parsed.model,
        previewText: this.buildChatPreview(parsed)
      }));
      knownChatIds.add(parsed.id);
      knownChatPaths.add(normalizedPath);
      restored += 1;
    }

    if (restored > 0) {
      // The sidebar sorts chats itself, so restored entries need no reordering.
      // Fold the restored chats into the tracked snapshot, then force the next
      // flush to rewrite the manifest so the repair becomes durable.
      this.updatePersistedStorageSnapshot(projects);
      this.persistedManifestJson = null;
      console.warn(`[STORAGE] Re-attached ${restored} orphaned chat file(s) missing from the manifest`);
    }
    return restored;
  }

  async rebuildProjectsFromChatFiles(readFile) {
    const listFiles = this.getListFiles();
    if (typeof listFiles !== 'function') {
      console.warn('[STORAGE][RECOVERY] Chat-file rebuild unavailable: listFiles bridge is missing');
      return [];
    }
    if (!this.storageRootPath) return [];

    let listResult;
    try {
      listResult = await listFiles(this.storageRootPath);
    } catch (err) {
      console.warn('[STORAGE][RECOVERY] Failed to enumerate chat files:', err);
      return [];
    }
    if (!listResult?.success || !Array.isArray(listResult.files)) {
      return [];
    }

    const normalizedRoot = this.storageRootPath.replace(/\\/g, '/').replace(/\/$/, '');
    const tombstonedChatPaths = this.collectTombstonedChatPaths(listResult.files);
    const groupedChats = new Map();
    for (const chatPath of listResult.files) {
      const normalizedPath = String(chatPath).replace(/\\/g, '/');
      if (!normalizedPath.endsWith('.json') || !normalizedPath.includes('/chats/')) {
        continue;
      }
      // Backup copies and corruption quarantines are `.json` files under
      // `/chats/` too. Ingesting them resurrects every chat that ever existed,
      // including ones the user deleted long ago, so they are never rebuilt from.
      if (this.isNonPrimaryChatPath(normalizedPath)) {
        continue;
      }
      if (tombstonedChatPaths.has(normalizedPath)) {
        continue;
      }

      try {
        const result = await readFile(chatPath);
        if (!result?.success || !result.content) continue;
        const chat = JSON.parse(result.content);
        if (!chat || typeof chat !== 'object' || !chat.id) continue;

        const relativePath = normalizedPath.startsWith(`${normalizedRoot}/`)
          ? normalizedPath.slice(normalizedRoot.length + 1)
          : normalizedPath;
        const pathParts = relativePath.split('/');
        const chatsIndex = pathParts.lastIndexOf('chats');
        let projectId = 'default';
        if (chatsIndex > 0) {
          try {
            projectId = decodeURIComponent(pathParts[chatsIndex - 1]) || 'default';
          } catch {
            projectId = 'default';
          }
        }

        this.normalizeChatForRuntime(chat);
        chat._chatFilePath = chatPath;
        if (!groupedChats.has(projectId)) {
          groupedChats.set(projectId, new Map());
        }
        const existing = groupedChats.get(projectId).get(chat.id);
        if (!existing || this.latestChatTimestamp(chat) >= this.latestChatTimestamp(existing)) {
          groupedChats.get(projectId).set(chat.id, chat);
        }
      } catch (err) {
        console.warn('[STORAGE][RECOVERY] Ignoring invalid chat file:', chatPath, err);
      }
    }

    // A rebuild that names every folder after its id is indistinguishable from
    // "my folders were deleted". Any older manifest still on disk knows the real
    // names, so harvest them read-only before falling back to id-husks.
    const recoveredMetadata = await this.recoverProjectMetadata(listResult.files, readFile);

    const projects = [...groupedChats.entries()].map(([projectId, chatsById]) => {
      const chats = [...chatsById.values()]
        .sort((a, b) => this.latestChatTimestamp(b) - this.latestChatTimestamp(a));
      const metadata = recoveredMetadata.get(projectId) || null;
      return {
        id: projectId,
        name: metadata?.name || (projectId === 'default' ? 'Default' : projectId),
        chats,
        expanded: true,
        createdAt: chats.reduce((oldest, chat) => Math.min(oldest, chat.createdAt || oldest), Date.now()),
        workingDir: metadata?.workingDir || null
      };
    });
    projects.sort((a, b) => {
      if (a.id === 'default') return -1;
      if (b.id === 'default') return 1;
      return a.id.localeCompare(b.id);
    });
    return this.normalizeProjectsForRuntime(projects);
  }

  async quarantineCorruptManifest(readFile, corruptContent = null) {
    if (!this.projectsManifestPath) return null;
    const quarantinePath = this.projectsManifestPath.replace(
      /manifest\.json$/,
      `manifest.corrupt-${Date.now()}.json`
    );
    const renameFile = this.getRenameFile();
    if (typeof renameFile !== 'function') {
      console.error('[STORAGE][RECOVERY] Cannot quarantine corrupt manifest: renameFile bridge is missing');
      return null;
    }

    try {
      const result = await renameFile(this.projectsManifestPath, quarantinePath);
      if (result?.success) {
        console.error('[STORAGE][RECOVERY] Quarantined corrupt manifest:', quarantinePath);
        return quarantinePath;
      }
      console.error('[STORAGE][RECOVERY] Failed to quarantine corrupt manifest:', result?.error);
    } catch (err) {
      console.error('[STORAGE][RECOVERY] Failed to quarantine corrupt manifest:', err);
    }
    return null;
  }

  async loadSplitStorage(readFile) {
    if (!this.projectsManifestPath || (!readFile && !this.goStorage)) {
      return { status: 'missing', projects: [] };
    }

    let manifestResult;
    try {
      manifestResult = await this.readStorageFile(
        this.getStorageTarget('manifest'),
        this.projectsManifestPath,
        readFile
      );
    } catch (err) {
      manifestResult = { success: false, error: err?.message || String(err) };
    }
    if (!manifestResult?.success && this.isNotFoundResult(manifestResult)) {
      return { status: 'missing', projects: [] };
    }

    if (manifestResult?.success && manifestResult.content) {
      try {
        const manifest = this.parseStorageManifest(manifestResult.content);
        const normalized = this.projectsFromStorageManifest(manifest);
        this.updatePersistedStorageSnapshot(normalized, manifestResult.content);
        console.log('[STORAGE] Loaded split storage:', normalized.length, 'projects');
        if (manifestResult.storageStatus === 'corrupt' || manifestResult.recovered) {
          this.storageRecoveryPending = true;
          this.storageRecoveryObserved = true;
          return {
            status: 'corrupt',
            projects: normalized,
            recovered: true,
            source: 'go-backup',
            backup: manifestResult.backup,
            quarantinePath: manifestResult.quarantine
          };
        }
        // The manifest parsed, but it may still be behind the chat files: a
        // flush that failed before its manifest write leaves committed chats
        // with no reference. Re-attach those before handing the tree to the UI.
        try {
          await this.reconcileOrphanedChatFiles(normalized, readFile);
        } catch (err) {
          console.warn('[STORAGE] Orphan reconciliation failed:', err);
        }
        return { status: 'healthy', projects: normalized };
      } catch (err) {
        console.warn('[STORAGE] Failed to load split storage:', err);
      }
    } else {
      console.warn('[STORAGE] Failed to read split storage:', manifestResult?.error || 'empty manifest');
    }

    this.storageRecoveryPending = true;
    this.storageRecoveryObserved = true;
    if (manifestResult?.code?.startsWith('STORAGE_') && this.goStorageAvailable) {
      return {
        status: manifestResult.storageStatus || 'corrupt',
        projects: [],
        recovered: false,
        quarantinePath: manifestResult.quarantine || null
      };
    }

    const backupPath = `${this.projectsManifestPath}.bak`;
    try {
      const backupResult = await readFile(backupPath);
      if (backupResult?.success && backupResult.content) {
        const backupManifest = this.parseStorageManifest(backupResult.content);
        const backupProjects = this.projectsFromStorageManifest(backupManifest);
        if (this.countProjectChats(backupProjects) > 0) {
          this.updatePersistedStorageSnapshot(backupProjects, backupResult.content);
          this.persistedManifestJson = null;
          console.error('[STORAGE][RECOVERY] Recovered split storage from manifest.json.bak');
          return { status: 'corrupt', projects: backupProjects, recovered: true, source: 'backup' };
        }
      }
    } catch (err) {
      console.warn('[STORAGE][RECOVERY] Backup manifest is unavailable or invalid:', err);
    }

    const rebuiltProjects = await this.rebuildProjectsFromChatFiles(readFile);
    const rebuiltChatCount = this.countProjectChats(rebuiltProjects);
    if (rebuiltChatCount > 0) {
      this.updatePersistedStorageSnapshot(rebuiltProjects);
      this.persistedManifestJson = null;
      console.error(`[STORAGE][RECOVERY] rebuilt manifest from ${rebuiltChatCount} orphaned chat files`);
      return { status: 'corrupt', projects: rebuiltProjects, recovered: true, source: 'chat-files' };
    }

    const quarantinePath = await this.quarantineCorruptManifest(readFile, manifestResult?.content);
    return {
      status: 'corrupt',
      projects: [],
      recovered: false,
      quarantinePath
    };
  }

  async loadLegacyProjectsFile(readFile) {
    if (!this.legacyProjectsFilePath || !readFile) return null;

    try {
      const result = await readFile(this.legacyProjectsFilePath);
      if (!result.success || !result.content) {
        return null;
      }

      const parsed = JSON.parse(result.content);
      if (!Array.isArray(parsed)) {
        return null;
      }

      this.legacyProjectsBackupContent = result.content;
      console.log('[STORAGE] Loaded legacy projects.json for migration');
      const projects = this.normalizeProjectsForRuntime(parsed);
      return {
        projects,
        hadLegacyData: this.countProjectChats(projects) > 0
      };
    } catch (err) {
      console.warn('[STORAGE] Failed to load legacy projects.json:', err);
      return null;
    }
  }

  async deleteLegacyProjectsFile() {
    const readFile = this.getReadFile();
    const writeFile = this.getWriteFile();
    const deleteFile = this.getDeleteFile();
    if (!deleteFile || !this.legacyProjectsFilePath) return;

    try {
      if (writeFile) {
        const backupPath = `${this.legacyProjectsFilePath}.bak`;
        let backupContent = this.legacyProjectsBackupContent;
        let legacyMissing = false;
        let backupAlreadyExists = false;

        if (typeof backupContent !== 'string' && readFile) {
          const legacyResult = await readFile(this.legacyProjectsFilePath);
          if (legacyResult?.success && typeof legacyResult.content === 'string') {
            backupContent = legacyResult.content;
          } else if (legacyResult?.notFound) {
            legacyMissing = true;
          }

          if (typeof backupContent !== 'string') {
            const backupFileResult = await readFile(backupPath);
            backupAlreadyExists = !!(backupFileResult?.success && typeof backupFileResult.content === 'string');
          }
        }

        if (typeof backupContent !== 'string') {
          if (legacyMissing || backupAlreadyExists) {
            return;
          }
          console.warn('[STORAGE] Refusing to delete legacy projects.json without writing projects.json.bak first');
          return;
        }

        const backupResult = await writeFile(backupPath, backupContent);
        if (!backupResult?.success) {
          console.warn('[STORAGE] Failed to back up legacy projects.json:', backupResult?.error);
          return;
        }
      }

      const result = await deleteFile(this.legacyProjectsFilePath);
      if (!result?.success) {
        console.warn('[STORAGE] Failed to delete legacy projects.json:', result?.error);
      } else {
        this.legacyProjectsBackupContent = null;
      }
    } catch (err) {
      console.warn('[STORAGE] Failed to delete legacy projects.json:', err);
    }
  }

  // Mark a project as dirty with the type of change
  markProjectDirty(projectId, changeType, project = null) {
    const existing = this.dirtyProjects.get(projectId);

    // If already marked for delete, keep it
    if (existing?.changeType === 'delete') return;

    // If marked for create and now update, keep as create
    if (existing?.changeType === 'create' && changeType === 'update') {
      this.dirtyProjects.set(projectId, { changeType: 'create', project: project || existing.project });
      return;
    }

    // If marked for create/update and now delete, just mark delete
    if (changeType === 'delete') {
      // If was created but never synced, just remove from dirty
      if (existing?.changeType === 'create') {
        this.dirtyProjects.delete(projectId);
        return;
      }
      this.dirtyProjects.set(projectId, { changeType: 'delete', projectId });
      return;
    }

    this.dirtyProjects.set(projectId, { changeType, project });
  }

  // Mark a chat as dirty with the type of change
  markChatDirty(chatId, changeType, projectId = null, chat = null, updates = null) {
    this.markChatLocallyDirty(chatId);
    const existing = this.dirtyChats.get(chatId);

    // If already marked for delete, keep it
    if (existing?.changeType === 'delete') return;

    // If marked for create and now update, keep as create with latest chat
    if (existing?.changeType === 'create' && changeType === 'update') {
      this.dirtyChats.set(chatId, {
        changeType: 'create',
        projectId: projectId || existing.projectId,
        chat: chat || existing.chat
      });
      return;
    }

    // If marked for create/update and now delete, handle appropriately
    if (changeType === 'delete') {
      // If was created but never synced, just remove from dirty
      if (existing?.changeType === 'create') {
        this.dirtyChats.delete(chatId);
        this.pendingMessages.delete(chatId);
        this.pendingTruncates.delete(chatId);
        return;
      }
      this.dirtyChats.set(chatId, { changeType: 'delete', chatId });
      this.pendingMessages.delete(chatId);
      this.pendingTruncates.delete(chatId);
      return;
    }

    this.dirtyChats.set(chatId, { changeType, projectId, chat, updates });
  }

  // Queue a message to be added to a chat
  queueMessage(chatId, message) {
    this.markChatLocallyDirty(chatId);
    const existing = this.dirtyChats.get(chatId);
    // If chat is marked for create, the full chat will be sent
    if (existing?.changeType === 'create') return;
    // If chat is marked for delete, skip
    if (existing?.changeType === 'delete') return;

    if (!this.pendingMessages.has(chatId)) {
      this.pendingMessages.set(chatId, []);
    }
    this.pendingMessages.get(chatId).push(message);
  }

  // Queue a truncate operation for a chat
  queueTruncate(chatId, afterIndex) {
    this.markChatLocallyDirty(chatId);
    const existing = this.dirtyChats.get(chatId);
    // If chat is marked for create, the full chat will be sent
    if (existing?.changeType === 'create') return;
    // If chat is marked for delete, skip
    if (existing?.changeType === 'delete') return;

    // Clear any pending messages (they'd come after truncated content)
    this.pendingMessages.delete(chatId);
    // Store the truncate index (if multiple truncates, use the lowest)
    const existingTruncate = this.pendingTruncates.get(chatId);
    if (existingTruncate === undefined || afterIndex < existingTruncate) {
      this.pendingTruncates.set(chatId, afterIndex);
    }
  }

  // Queue a title update for a chat
  queueTitleUpdate(chatId, title) {
    const existing = this.dirtyChats.get(chatId);
    // If chat is marked for create/delete, skip (create sends full chat, delete removes it)
    if (existing?.changeType === 'create' || existing?.changeType === 'delete') return;

    // Mark as update with title change
    this.markChatDirty(chatId, 'update', null, null, { title });
  }

  // Mark a chat as needing a full update (when timeline items are modified in place)
  // This sends the entire chat to replace server state
  markChatForFullUpdate(chatId) {
    const existing = this.dirtyChats.get(chatId);
    // If chat is marked for create/delete, skip
    if (existing?.changeType === 'create' || existing?.changeType === 'delete') return;

    // Find the chat and its project
    let chat = null;
    let projectId = null;
    for (const project of this.app.projects) {
      chat = project.chats.find(c => c.id === chatId);
      if (chat) {
        projectId = project.id;
        break;
      }
    }
    if (!chat) return;

    // Mark as update with fullReplace flag
    this.markChatDirty(chatId, 'update', projectId, chat, { fullReplace: true });
    // Clear any pending incremental changes since we're doing a full replace
    this.pendingMessages.delete(chatId);
    this.pendingTruncates.delete(chatId);
  }

  // Load projects with cloud sync support
  async loadWithSync() {
    // Initialize filesystem paths
    await this.initFilesystem();

    // Load from filesystem (or localStorage for migration)
    console.log('[SYNC] loadProjectsWithSync: Loading from filesystem...');
    const localProjects = await this.loadFromStorage();
    this.app._projects = localProjects;  // Set backing store directly

    // DISABLED: Chat sync disabled pending efficiency improvements (version-based polling)
    // Server merge and push will be re-enabled once lightweight version checks are in place
    /*
    if (this.app.apiKey) {
      try {
        const serverProjects = await this.app.chatSync.fetchChats();
        if (serverProjects && serverProjects.length > 0) {
          console.log('[SYNC] MERGING projects from server');
          const merged = this.mergeProjects(localProjects, serverProjects);
          this.app._projects = merged;
          console.log('[SYNC] Loaded and merged projects from server');
          this.saveToLocal();
        }
      } catch (err) {
        console.warn('[SYNC] Failed to load from server, using local data:', err);
      }
    }
    */
  }

  // Merge local and server projects
  // Server data takes precedence for chats, but preserves local-only projects
  mergeProjects(localProjects, serverProjects) {
    const serverProjectMap = new Map(serverProjects.map(p => [p.id, p]));
    const merged = [];

    // Process all local projects
    for (const localProject of localProjects) {
      const serverProject = serverProjectMap.get(localProject.id);
      if (serverProject) {
        // Merge chats: server content wins, but preserve local pathMappings/scriptTypes
        const mergedChats = this.mergeChats(localProject.chats || [], serverProject.chats || []);

        // Merge: server data takes precedence, but keep device-specific fields
        merged.push({
          ...serverProject,
          chats: mergedChats,
          workingDir: localProject.workingDir || serverProject.workingDir,
          expanded: localProject.expanded !== undefined ? localProject.expanded : serverProject.expanded
        });
        serverProjectMap.delete(localProject.id);
      } else {
        // Local-only project - keep it
        merged.push(localProject);
      }
    }

    // Add any server-only projects
    for (const serverProject of serverProjectMap.values()) {
      merged.push(serverProject);
    }

    // Ensure default project exists
    if (!merged.find(p => p.id === 'default')) {
      merged.unshift({ id: 'default', name: 'Default', chats: [], expanded: true, createdAt: 0 });
    }

    return merged;
  }

  // Merge chats from local and server
  mergeChats(localChats, serverChats) {
    const localChatMap = new Map(localChats.map(c => [c.id, c]));
    const merged = [];
    const mergedIds = new Set(); // Track merged IDs to prevent duplicates

    for (const serverChat of serverChats) {
      if (mergedIds.has(serverChat.id)) {
        console.warn('[MERGE] Skipping duplicate server chat:', serverChat.id);
        continue;
      }

      const localChat = localChatMap.get(serverChat.id);
      if (localChat) {
        const isProcessing = store.isChatProcessing(localChat.id);
        const isActiveChat = store.get('activeChatId') === localChat.id;

        if (isProcessing || isActiveChat) {
          merged.push({
            ...localChat,
            pathMappings: { ...(serverChat.pathMappings || {}), ...(localChat.pathMappings || {}) },
            scriptTypes: { ...(serverChat.scriptTypes || {}), ...(localChat.scriptTypes || {}) },
            diffs: localChat.diffs || serverChat.diffs || [],
            sourcecontrolState: { ...(serverChat.sourcecontrolState || {}), ...(localChat.sourcecontrolState || {}) }
          });
          localChatMap.delete(serverChat.id);
          mergedIds.add(serverChat.id);
          console.log('[MERGE] Chat', serverChat.id, 'PROTECTED (active/processing) - using LOCAL');
          continue;
        }

        const localTime = localChat.updatedAt || 0;
        const serverTime = serverChat.updatedAt || 0;
        const useLocal = localTime >= serverTime;
        const baseChat = useLocal ? localChat : serverChat;
        const otherChat = useLocal ? serverChat : localChat;

        merged.push({
          ...baseChat,
          pathMappings: { ...(otherChat.pathMappings || {}), ...(baseChat.pathMappings || {}) },
          scriptTypes: { ...(otherChat.scriptTypes || {}), ...(baseChat.scriptTypes || {}) },
          diffs: baseChat.diffs || otherChat.diffs || [],
          sourcecontrolState: { ...(otherChat.sourcecontrolState || {}), ...(baseChat.sourcecontrolState || {}) }
        });
        localChatMap.delete(serverChat.id);
        mergedIds.add(serverChat.id);
        console.log('[MERGE] Chat', serverChat.id, 'merged: localTime=', localTime, 'serverTime=', serverTime,
          'using', useLocal ? 'LOCAL' : 'SERVER');
      } else {
        merged.push(serverChat);
        mergedIds.add(serverChat.id);
      }
    }

    // Add any local-only chats
    for (const localChat of localChatMap.values()) {
      if (mergedIds.has(localChat.id)) {
        console.warn('[MERGE] Skipping duplicate local chat:', localChat.id);
        continue;
      }
      merged.push(localChat);
      mergedIds.add(localChat.id);
    }

    return merged;
  }

  // De-duplicate chats within a project (cleanup utility)
  deduplicateProjectChats(project) {
    if (!project.chats || project.chats.length === 0) return;

    const seen = new Set();
    const originalCount = project.chats.length;
    project.chats = project.chats.filter(chat => {
      if (seen.has(chat.id)) {
        console.warn('[STORAGE] Removing duplicate chat from', project.name, ':', chat.id);
        return false;
      }
      seen.add(chat.id);
      return true;
    });

    if (project.chats.length !== originalCount) {
      console.log('[STORAGE] Removed', originalCount - project.chats.length, 'duplicates from', project.name);
    }
  }

  // Load projects from filesystem (with localStorage migration)
  async loadFromStorage() {
    const readFile = this.getReadFile();

    const splitResult = await this.loadSplitStorage(readFile);
    if (splitResult.status === 'healthy' || splitResult.projects.length > 0) {
      return splitResult.projects;
    }
    const canMigrateToFilesystem = splitResult.status !== 'corrupt' || !!splitResult.quarantinePath;

    const legacyResult = await this.loadLegacyProjectsFile(readFile);
    if (legacyResult?.hadLegacyData) {
      if (canMigrateToFilesystem) {
        console.log('[STORAGE] Migrating legacy projects.json to split storage...');
        const migrated = await this.saveToStorage(legacyResult.projects);
        if (migrated) {
          await this.deleteLegacyProjectsFile();
        }
      } else {
        console.error('[STORAGE][RECOVERY] Refusing to overwrite an unquarantined corrupt manifest');
      }
      return legacyResult.projects;
    }

    // Fall back to localStorage (for migration)
    console.log('[STORAGE] Checking localStorage for migration...');
    const localResult = this.loadFromLocalStorage();
    const localData = this.normalizeProjectsForRuntime(localResult.projects);

    // Only migrate a real legacy payload. normalizeProjectsForRuntime always
    // creates an empty default project, which must never trigger a disk write.
    if (localResult.hadLegacyData && this.projectsManifestPath && canMigrateToFilesystem) {
      console.log('[STORAGE] Migrating', localData.length, 'projects from localStorage to filesystem...');
      const migrated = await this.saveToStorage(localData);
      if (migrated) {
        storage.remove(storage.KEYS.projects);
        storage.remove(storage.KEYS.chats);
        console.log('[STORAGE] Migration complete, localStorage cleared');
      }
    }

    return localResult.hadLegacyData ? localData : (legacyResult?.projects || localData);
  }

  // Load from localStorage (for migration only)
  loadFromLocalStorage() {
    try {
      const data = storage.getRaw(storage.KEYS.projects);
      if (data) {
        const projects = JSON.parse(data);
        if (Array.isArray(projects)) {
          const hadLegacyData = projects.some((project) => (
            project?.id !== 'default' || (project?.chats?.length || 0) > 0
          ));
          if (!projects.find(p => p.id === 'default')) {
            projects.unshift({ id: 'default', name: 'Default', chats: [], expanded: true, createdAt: 0 });
          }
          return { projects, hadLegacyData };
        }
      }
    } catch {
      // Fall through to create default
    }

    // Migrate existing chats to default project
    const existingChats = this.loadLegacyChats();
    return {
      projects: [{
        id: 'default',
        name: 'Default',
        chats: existingChats,
        expanded: true,
        createdAt: 0
      }],
      hadLegacyData: existingChats.length > 0
    };
  }

  loadLegacyChats() {
    return storage.getJSON(storage.KEYS.chats, []);
  }

  sanitizeChatForStorage(chat) {
    const sanitized = { ...chat };
    delete sanitized._debugId;
    delete sanitized._sidebarPreviewCache;
    delete sanitized._storageState;
    delete sanitized._sidebarPreviewText;
    delete sanitized._chatFilePath;
    return sanitized;
  }

  // Serialize + hash one chat for storage. Long timelines stringify per item
  // with periodic yields to the event loop, so a single giant chat can't
  // block the UI thread in one uninterruptible chunk (writeStorageSnapshot's
  // own yield only breaks BETWEEN chats). The hash is streamed over the same
  // parts, so it equals computeStringHash(chatJson) without a second pass.
  // Items are joined into JSON identical to JSON.stringify(sanitized) except
  // that the timeline key moves to the end (irrelevant to JSON.parse).
  async serializeChatForStorage(chat) {
    const sanitized = this.sanitizeChatForStorage(chat);
    const timeline = Array.isArray(sanitized.timeline) ? sanitized.timeline : null;
    if (!timeline || timeline.length < CHUNKED_SERIALIZE_MIN_TIMELINE_ITEMS) {
      const chatJson = JSON.stringify(sanitized);
      return { chatJson, chatHash: this.computeStringHash(chatJson) };
    }

    // Snapshot item refs up front: appends/splices during a yield can't skew
    // the loop, and any such mutation re-marks the chat dirty so the queued
    // follow-up save rewrites the file with the fresh state.
    const items = timeline.slice();
    delete sanitized.timeline;
    const head = JSON.stringify(sanitized);
    const prefix = head === '{}' ? '{"timeline":[' : `${head.slice(0, -1)},"timeline":[`;

    let hash = this.hashStringInto(2166136261, prefix);
    const parts = [prefix];
    let sliceStart = performance.now();
    for (let i = 0; i < items.length; i++) {
      if (performance.now() - sliceStart > 12) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
      // '?? null' matches array semantics: JSON.stringify serializes an
      // undefined element as null.
      const itemJson = JSON.stringify(items[i] ?? null) ?? 'null';
      const piece = i === 0 ? itemJson : `,${itemJson}`;
      hash = this.hashStringInto(hash, piece);
      parts.push(piece);
    }
    const suffix = ']}';
    hash = this.hashStringInto(hash, suffix);
    parts.push(suffix);
    return { chatJson: parts.join(''), chatHash: (hash >>> 0).toString(16) };
  }

  buildChatCommitMetadata(chatId, overrides = {}) {
    const chatOverride = overrides.deletedChat || overrides.chat || null;
    const project = overrides.projectId
      ? this.app.projects.find((entry) => entry.id === overrides.projectId) || null
      : this.getProjectForChat(chatId);
    const chat = chatOverride || this.findChatById(chatId);
    if (!chat) {
      return null;
    }

    const projectId = overrides.projectId || project?.id || 'default';
    const projectDir = Object.prototype.hasOwnProperty.call(overrides, 'projectDir')
      ? overrides.projectDir
      : (project?.workingDir || null);
    const provider = this.app.normalizeModelProvider(overrides.provider || chat.provider || this.app.modelProvider);

    return {
      chatId,
      projectId,
      projectDir,
      provider,
      claudeSessionId: overrides.claudeSessionId !== undefined ? overrides.claudeSessionId : (chat.claudeSessionId || null),
      codexThreadId: overrides.codexThreadId !== undefined ? overrides.codexThreadId : (chat.codexThreadId || null),
      deletedChat: overrides.deletedChat || null
    };
  }

  async buildChatSyncDescriptor(chatId, overrides = {}) {
    const metadata = this.buildChatCommitMetadata(chatId, overrides);
    if (!metadata) {
      return null;
    }

    let chat = overrides.deletedChat || overrides.chat || this.findChatById(chatId);
    if (!chat) {
      return null;
    }
    if (!overrides.deletedChat && !overrides.chat && this.isStorageStubChat(chat)) {
      chat = await this.ensureChatLoaded(chat, metadata.projectId);
    } else if (!this.isStorageStubChat(chat)) {
      chat = this.normalizeChatForRuntime(chat);
    }

    if (!chat) {
      return null;
    }

    const ropilotChatContent = overrides.ropilotChatContent
      || JSON.stringify(this.sanitizeChatForStorage(chat), null, 2);

    return {
      chatId: metadata.chatId,
      projectId: metadata.projectId,
      projectDir: metadata.projectDir,
      provider: metadata.provider,
      claudeSessionId: metadata.claudeSessionId,
      codexThreadId: metadata.codexThreadId,
      ropilot_chat_file: {
        path: this.getChatCommitPath(metadata.projectId, metadata.chatId),
        content: ropilotChatContent
      }
    };
  }

  renderLocalSaveStatus() {
    this.app.messageRenderer?.renderStorageSaveStatus?.();
  }

  clearLocalSaveRetry() {
    if (this.localSaveRetryTimer != null) clearTimeout(this.localSaveRetryTimer);
    this.localSaveRetryTimer = null;
  }

  scheduleLocalSaveRetry() {
    if (this.localSaveRetryTimer != null) return;
    const delay = Math.min(30000, 10000 * this.localSaveFailureCount);
    this.localSaveRetryTimer = setTimeout(() => {
      this.localSaveRetryTimer = null;
      this.saveToStorage().catch((err) => console.warn('[STORAGE] Save retry failed:', err));
    }, delay);
    this.localSaveRetryTimer.unref?.();
  }

  async retryLocalSave() {
    this.clearLocalSaveRetry();
    return this.saveToStorage();
  }

  // Save to filesystem (or localStorage fallback).
  // Serialized: a save requested while one is running is coalesced into a
  // follow-up debounced save instead of interleaving file writes.
  async saveToStorage(projects = null) {
    if (this.saveToStorageInProgress) {
      if (projects == null) {
        // Routine debounced save — coalesce into a follow-up run
        this.saveToStorageQueued = true;
        return true;
      }
      // Explicit-snapshot save (e.g. storage migration): the caller checks the
      // result, so wait for the in-flight save instead of skipping the write
      while (this.saveToStorageInProgress) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    // Track routine filesystem saves only. Migration snapshots have their own
    // caller/result handling and must never be retried with a different snapshot.
    const trackSave = projects == null && !!this.projectsManifestPath &&
      !!(this.getWriteFile() || this.goStorage);
    this.saveToStorageInProgress = true;
    if (trackSave) this.renderLocalSaveStatus();
    let saved = false;
    try {
      saved = await this.writeStorageSnapshot(projects);
      return saved;
    } finally {
      this.saveToStorageInProgress = false;
      if (trackSave) {
        if (saved) {
          this.localSaveFailureCount = 0;
          this.clearLocalSaveRetry();
        } else {
          this.localSaveFailureCount += 1;
          this.scheduleLocalSaveRetry();
        }
        this.renderLocalSaveStatus();
      }
      if (this.saveToStorageQueued) {
        this.saveToStorageQueued = false;
        this.saveToLocal();
      }
    }
  }

  async writeStorageSnapshot(projects = null) {
    const dataToSave = projects ?? this.app.projects;
    const writeFile = this.getWriteFile();
    const deleteFile = this.getDeleteFile();

    // Explicit snapshots (e.g. storage migration) bypass dirty tracking and
    // serialize everything. Routine flushes only reserialize chats that were
    // marked dirty or whose cheap fingerprint changed.
    const forceAllChats = projects != null || this.storageRecoveryPending;
    // Take the dirty set for this flush; marks added while the flush is in
    // flight land in the fresh set and are picked up by the queued follow-up
    // save. Restored below if this flush does not commit.
    const dirtyChatIds = this.locallyDirtyChatIds;
    this.locallyDirtyChatIds = new Set();
    let committed = false;

    try {
      // Try split filesystem storage first
      if (this.projectsManifestPath && (writeFile || this.goStorage)) {
        try {
          const nextChatFiles = new Set();
          const nextChatTargets = new Map();
          const nextChatHashes = new Map();
          const nextChatFingerprints = new Map();
          // Chats whose file write failed this flush. They stay dirty and the
          // flush reports failure so it is retried, but the manifest still
          // commits for every chat that did land.
          const failedChatIds = new Set();

          // Snapshot project/chat membership and derive the manifest before any
          // event-loop yield. A chat added mid-flush is therefore absent from
          // both this flush's chat writes and its manifest, then picked up by the
          // queued follow-up save.
          const snapshot = (dataToSave || []).map((project) => ({
            ...project,
            chats: [...(project.chats || [])]
          }));
          const chatEntries = [];
          for (const project of snapshot) {
            for (const chat of project.chats) {
              chatEntries.push([project, chat]);
            }
          }
          const manifestJson = JSON.stringify(this.buildStorageManifest(snapshot), null, 2);

          // Serializing + hashing large chats is CPU-heavy; yield periodically
          // so the dirty ones can't freeze the UI thread back-to-back.
          let sliceStart = performance.now();
          let largestSerializedChars = 0;
          for (const [project, chat] of chatEntries) {
            if (performance.now() - sliceStart > 12) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              sliceStart = performance.now();
            }

            const chatPath = this.getChatStoragePath(project.id, chat);
            nextChatFiles.add(chatPath);
            if (chat?.id) {
              nextChatTargets.set(chatPath, { projectId: project.id, chatId: chat.id });
            }
            // Stubs were never hydrated and error placeholders are what a failed
            // hydrate left behind — neither holds the user's timeline, so writing
            // either would replace a good file with an empty one. Carry the
            // previously persisted hash/fingerprint forward and leave the file
            // untouched; the chat still keeps its manifest reference above.
            if (this.isUnwritableChat(chat)) {
              const existingHash = this.persistedChatHashes.get(chatPath);
              if (existingHash) {
                nextChatHashes.set(chatPath, existingHash);
              }
              const existingFingerprint = this.persistedChatFingerprints.get(chatPath);
              if (existingFingerprint) {
                nextChatFingerprints.set(chatPath, existingFingerprint);
              }
              continue;
            }

            // Skip chats that provably didn't change since the last commit:
            // not marked dirty, previously persisted, and an unchanged
            // structural fingerprint. When in doubt, serialize (never lose
            // data); the hash below still dedupes actual writes.
            const fingerprint = this.computeChatFingerprint(chat);
            const priorHash = this.persistedChatHashes.get(chatPath);
            const unchanged = !forceAllChats
              && !dirtyChatIds.has(chat.id)
              && !!priorHash
              && this.persistedChatFingerprints.get(chatPath) === fingerprint;
            if (unchanged) {
              nextChatHashes.set(chatPath, priorHash);
              nextChatFingerprints.set(chatPath, fingerprint);
              continue;
            }

            const { chatJson, chatHash } = await this.serializeChatForStorage(chat);
            if (chatJson.length > largestSerializedChars) {
              largestSerializedChars = chatJson.length;
            }
            nextChatHashes.set(chatPath, chatHash);
            nextChatFingerprints.set(chatPath, fingerprint);

            if (priorHash !== chatHash) {
              const chatResult = await this.commitWithRecovery(
                this.getStorageTarget('chat', project.id, chat.id),
                chatPath,
                chatJson,
                writeFile
              );
              if (!chatResult.success) {
                // One unwritable chat must never abort the flush. Aborting here
                // is what froze the manifest: every chat created afterwards had
                // a file on disk but no manifest reference, so it vanished from
                // the sidebar on the next launch. Record the failure, keep the
                // chat dirty, and let the remaining chats + the manifest commit.
                console.warn('[STORAGE] Chat write failed:', chatPath, chatResult.error);
                failedChatIds.add(chat.id);
                // Do not claim a hash/fingerprint we never persisted, or the
                // next flush would treat this chat as already written.
                if (priorHash) {
                  nextChatHashes.set(chatPath, priorHash);
                } else {
                  nextChatHashes.delete(chatPath);
                }
                const priorFingerprint = this.persistedChatFingerprints.get(chatPath);
                if (priorFingerprint) {
                  nextChatFingerprints.set(chatPath, priorFingerprint);
                } else {
                  nextChatFingerprints.delete(chatPath);
                }
                continue;
              }
              if (chatResult.committedContent) {
                nextChatHashes.set(chatPath, this.computeStringHash(chatResult.committedContent));
              }
            }
          }
          this.lastFlushLargestChatChars = largestSerializedChars;

          let committedManifestJson = manifestJson;
          if (this.persistedManifestJson !== manifestJson) {
            const manifestResult = await this.commitWithRecovery(
              this.getStorageTarget('manifest'),
              this.projectsManifestPath,
              manifestJson,
              writeFile
            );
            if (!manifestResult.success) {
              console.warn('[STORAGE] Manifest write failed:', manifestResult.error);
              return false;
            }
            committedManifestJson = manifestResult.committedContent || manifestJson;
          }

          // A partial flush leaves the on-disk chat set ambiguous, so stale-file
          // deletion is suspended exactly as it is during a pending recovery.
          if ((deleteFile || this.goStorage) && !this.storageRecoveryPending && failedChatIds.size === 0) {
            for (const stalePath of this.persistedChatFiles) {
              if (!nextChatFiles.has(stalePath)) {
                // Prefer the Go delete endpoint: it also removes the chat's
                // `.backups` directory and writes a tombstone, so the chat can
                // never be silently restored later. The legacy bridge removes
                // only the primary and is used solely when Go has no route.
                const staleTarget = this.persistedChatTargets.get(stalePath);
                try {
                  const deleteResult = staleTarget
                    ? await this.deleteStorageFile(
                      this.getStorageTarget('chat', staleTarget.projectId, staleTarget.chatId),
                      stalePath,
                      deleteFile
                    )
                    : (deleteFile ? await deleteFile(stalePath) : { success: false, error: 'Storage unavailable' });
                  if (!deleteResult?.success) {
                    console.warn('[STORAGE] Failed to delete stale chat file:', stalePath, deleteResult?.error);
                  }
                } catch (err) {
                  console.warn('[STORAGE] Failed to delete stale chat file:', stalePath, err);
                }
              }
            }
          }

          this.persistedChatFiles = nextChatFiles;
          this.persistedChatTargets = nextChatTargets;
          this.persistedChatHashes = nextChatHashes;
          this.persistedChatFingerprints = nextChatFingerprints;
          this.persistedManifestJson = committedManifestJson;

          if (failedChatIds.size > 0) {
            // The manifest committed, so every chat that did write is now
            // referenced and will survive a relaunch. The failed ones stay
            // dirty (via the finally block, which sees committed === false) so
            // the next flush retries them, and the recovery/sweep bookkeeping
            // stays untouched because this flush is not a clean one.
            console.warn(`[STORAGE] Flush committed with ${failedChatIds.size} failed chat write(s); will retry`);
            for (const failedChatId of failedChatIds) {
              this.markChatLocallyDirty(failedChatId);
            }
            return false;
          }

          await this.deleteLegacyProjectsFile();
          const wasRecoveryFlush = this.storageRecoveryPending;
          this.storageRecoveryPending = false;
          committed = true;
          // A committed, non-recovery flush means the manifest on disk is
          // current and healthy — the only state in which sweeping leftover
          // backup directories is safe. Fire and forget; failures are inert.
          if (!wasRecoveryFlush) {
            this.requestStorageSweep().catch(() => {});
          }
          return true;
        } catch (err) {
          console.warn('[STORAGE] Filesystem write error:', err);
        }
      }

      // Fall back to localStorage (shouldn't happen in Electron)
      console.warn('[STORAGE] Falling back to localStorage');
      try {
        storage.setJSON(storage.KEYS.projects, dataToSave);
      } catch (err) {
        console.error('[STORAGE] localStorage also failed (quota?):', err);
      }
      return false;
    } finally {
      if (!committed) {
        // Flush failed or fell back — keep these chats marked so the next
        // attempt reserializes them instead of trusting stale hashes.
        for (const chatId of dirtyChatIds) {
          this.locallyDirtyChatIds.add(chatId);
        }
      }
    }
  }

  // Synchronous save for backward compatibility (schedules async save)
  saveToLocal() {
    // Saves are requested right after mutations, but most callers don't say
    // which chat changed. The active chat and any streaming chats are the
    // ones mutated in place, so conservatively mark them dirty every request.
    this.markChatLocallyDirty(this.app?.activeChat?.id);
    const processingChatIds = store.get('processingChatIds');
    if (processingChatIds) {
      for (const chatId of processingChatIds) {
        this.markChatLocallyDirty(chatId);
      }
    }

    // Coalesce without postponing: an already-scheduled flush keeps its
    // deadline, so back-to-back saves during streaming can't defer
    // persistence indefinitely (the old trailing debounce could). The window
    // scales with the biggest chat the last flush serialized — a dirty chat
    // re-stringifies fully every flush, so a multi-MB streaming chat should
    // not do that every 150 ms. Capped so a crash still loses at most ~2 s.
    if (this.localSaveTimer) return;
    const costDelayMs = Math.round(this.lastFlushLargestChatChars / 5000);
    const delayMs = Math.min(2000, Math.max(this.localSaveDelayMs, costDelayMs));

    this.localSaveTimer = setTimeout(() => {
      this.localSaveTimer = null;
      this.saveToStorage().catch((err) => {
        console.error('[STORAGE] Debounced save failed:', err);
      });
    }, delayMs);
  }

  // Save projects with cloud sync
  // DISABLED: Chat sync disabled pending efficiency improvements
  save() {
    this.saveToLocal();
    // this.syncToServer();
  }

  // Sync projects to server (debounced)
  syncToServer() {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }

    this.syncTimer = setTimeout(async () => {
      await this.performIncrementalSync();
    }, 1000);
  }

  // Perform incremental sync - only send changed data
  async performIncrementalSync() {
    // Check if we can sync
    if (!this.app.chatSync.canSync()) {
      console.log('[SYNC] Cannot sync - offline or no API key');
      return;
    }

    // Check if we have any changes to sync
    const hasChanges = this.dirtyProjects.size > 0 ||
                       this.dirtyChats.size > 0 ||
                       this.pendingMessages.size > 0 ||
                       this.pendingTruncates.size > 0;

    if (!hasChanges && !this.needsFullSync) {
      console.log('[SYNC] No changes to sync');
      return;
    }

    // If full sync is needed, do it
    if (this.needsFullSync) {
      console.log('[SYNC] Performing full sync (fallback)');
      await this.performFullSync();
      return;
    }

    console.log('[SYNC] Performing incremental sync:',
      'projects:', this.dirtyProjects.size,
      'chats:', this.dirtyChats.size,
      'messages:', this.pendingMessages.size,
      'truncates:', this.pendingTruncates.size);

    // Take a snapshot of current dirty state and clear it
    const projectChanges = new Map(this.dirtyProjects);
    const chatChanges = new Map(this.dirtyChats);
    const messageChanges = new Map(this.pendingMessages);
    const truncateChanges = new Map(this.pendingTruncates);

    this.dirtyProjects.clear();
    this.dirtyChats.clear();
    this.pendingMessages.clear();
    this.pendingTruncates.clear();

    let allSucceeded = true;

    try {
      // Process project changes
      for (const [projectId, change] of projectChanges) {
        try {
          if (change.changeType === 'delete') {
            await this.app.chatSync.deleteProject(projectId);
            console.log('[SYNC] Deleted project:', projectId);
          } else if (change.changeType === 'create' || change.changeType === 'update') {
            const project = change.project || this.app.projects.find(p => p.id === projectId);
            if (project) {
              await this.app.chatSync.saveProject(await this.prepareProjectForSync(project));
              console.log('[SYNC] Saved project:', projectId);
            }
          }
        } catch (err) {
          console.error('[SYNC] Failed to sync project:', projectId, err);
          // Re-add to dirty for retry
          this.dirtyProjects.set(projectId, change);
          allSucceeded = false;
        }
      }

      // Process chat deletions first (before creates to avoid conflicts)
      for (const [chatId, change] of chatChanges) {
        if (change.changeType !== 'delete') continue;
        try {
          await this.app.chatSync.deleteChat(chatId);
          console.log('[SYNC] Deleted chat:', chatId);
        } catch (err) {
          console.error('[SYNC] Failed to delete chat:', chatId, err);
          this.dirtyChats.set(chatId, change);
          allSucceeded = false;
        }
      }

      // Process chat creates
      for (const [chatId, change] of chatChanges) {
        if (change.changeType !== 'create') continue;
        try {
          const chat = change.chat || this.findChatById(chatId);
          if (chat) {
            await this.app.chatSync.createChat(change.projectId, this.prepareChatForSync(chat));
            console.log('[SYNC] Created chat:', chatId);
          }
        } catch (err) {
          console.error('[SYNC] Failed to create chat:', chatId, err);
          this.dirtyChats.set(chatId, change);
          allSucceeded = false;
        }
      }

      // Process truncates (before adding messages)
      for (const [chatId, afterIndex] of truncateChanges) {
        try {
          await this.app.chatSync.updateChat(chatId, { truncateAfter: afterIndex });
          console.log('[SYNC] Truncated chat:', chatId, 'after index:', afterIndex);
        } catch (err) {
          console.error('[SYNC] Failed to truncate chat:', chatId, err);
          this.pendingTruncates.set(chatId, afterIndex);
          allSucceeded = false;
        }
      }

      // Process pending messages (addMessage for each)
      for (const [chatId, messages] of messageChanges) {
        for (const message of messages) {
          try {
            await this.app.chatSync.updateChat(chatId, { addTimelineItem: message });
            console.log('[SYNC] Added message to chat:', chatId);
          } catch (err) {
            console.error('[SYNC] Failed to add message to chat:', chatId, err);
            // Re-queue the failed message and all subsequent ones
            if (!this.pendingMessages.has(chatId)) {
              this.pendingMessages.set(chatId, []);
            }
            this.pendingMessages.get(chatId).push(message);
            allSucceeded = false;
          }
        }
      }

      // Process chat updates (title changes, full replaces, etc.)
      for (const [chatId, change] of chatChanges) {
        if (change.changeType !== 'update') continue;

        try {
          if (change.updates?.fullReplace && change.chat) {
            // Full chat replacement - send the entire chat
            await this.app.chatSync.updateChat(chatId, {
              fullReplace: true,
              chat: this.prepareChatForSync(change.chat)
            });
            console.log('[SYNC] Full replaced chat:', chatId);
          } else if (change.updates) {
            // Incremental update (title, etc.)
            await this.app.chatSync.updateChat(chatId, change.updates);
            console.log('[SYNC] Updated chat:', chatId, change.updates);
          }
        } catch (err) {
          console.error('[SYNC] Failed to update chat:', chatId, err);
          this.dirtyChats.set(chatId, change);
          allSucceeded = false;
        }
      }

      if (!allSucceeded) {
        console.warn('[SYNC] Some changes failed, will retry on next sync');
      } else {
        console.log('[SYNC] Incremental sync completed successfully');
      }
    } catch (err) {
      console.error('[SYNC] Incremental sync failed, falling back to full sync:', err);
      // Restore dirty state for full sync
      for (const [k, v] of projectChanges) this.dirtyProjects.set(k, v);
      for (const [k, v] of chatChanges) this.dirtyChats.set(k, v);
      for (const [k, v] of messageChanges) this.pendingMessages.set(k, v);
      for (const [k, v] of truncateChanges) this.pendingTruncates.set(k, v);
      this.needsFullSync = true;
    }
  }

  // Prepare a project for sync (exclude device-specific fields)
  async prepareProjectForSync(project) {
    const chats = [];
    // Snapshot: hydrating a stub can drop a tombstoned chat from project.chats.
    for (const chat of [...(project.chats || [])]) {
      if (this.isStorageStubChat(chat)) {
        const loadedChat = await this.ensureChatLoaded(chat, project.id);
        if (!loadedChat) continue;
        chats.push(this.prepareChatForSync(loadedChat));
      } else {
        chats.push(this.prepareChatForSync(chat));
      }
    }

    return {
      id: project.id,
      name: project.name,
      chats,
      expanded: project.expanded,
      createdAt: project.createdAt,
      updatedAt: Date.now()
    };
  }

  // Prepare a chat for sync
  prepareChatForSync(chat) {
    return {
      id: chat.id,
      title: chat.title,
      timeline: chat.timeline || [],
      activities: chat.activities || [],
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt || Date.now(),
      diffs: chat.diffs,
      pathMappings: chat.pathMappings,
      scriptTypes: chat.scriptTypes,
      sourcecontrolState: chat.sourcecontrolState,
      contextUsage: chat.contextUsage || null,
      claudeSessionId: chat.claudeSessionId || null,
      codexThreadId: chat.codexThreadId || null,
      hasHistory: !!chat.hasHistory,
      // Timeline index of the last confirmed Codex compact. Without it a
      // restored chat re-sends its whole pre-compact timeline as
      // reconstruction context and undoes the compact.
      codexCompactedTimelineIndex: Number(chat.codexCompactedTimelineIndex) || 0,
      turnCheckpoints: chat.turnCheckpoints || {},
      studioErrors: Array.isArray(chat.studioErrors) ? chat.studioErrors : [],
      provider: chat.provider || null,
      model: chat.model || null
    };
  }

  // Full sync fallback
  async performFullSync() {
    try {
      const projectsToSync = await this.prepareProjectsForSync(this.app.projects);

      await this.app.chatSync.saveProjects(projectsToSync);
      console.log('[SYNC] Full sync completed');

      // Clear all dirty tracking
      this.dirtyProjects.clear();
      this.dirtyChats.clear();
      this.pendingMessages.clear();
      this.pendingTruncates.clear();
      this.needsFullSync = false;
    } catch (err) {
      console.error('[SYNC] Full sync failed:', err);
      // Keep needsFullSync true to retry
    }
  }

  // Force a full sync on next save (used after initial load or API key change)
  requestFullSync() {
    this.needsFullSync = true;
    this.syncToServer();
  }

  // Helper to find a chat by ID (used internally for sync)
  findChatById(chatId) {
    return store.getChatById(chatId);
  }
}
