import { selectConnectionConfig } from './js/core/connection-origins.js';
// Ropilot Desktop App
import { ChatSyncService } from './js/chat-sync.js';
import { ChatSyncCommitService } from './js/chat-sync-commit.js';
import { createElectronChatSyncFileAdapter } from './js/chat-sync-file-adapter.js';
import { FrontendChatSync } from './js/frontend-chat-sync.js';
import { StatusManager } from './js/status-manager.js';
import { PlaytestPanel } from './js/playtest-panel.js';
import { DiffPreview } from './js/diff-preview.js';
import { Settings } from './js/settings.js';
import { WebSocketManager } from './js/websocket.js';
import { ProjectManager } from './js/project-manager.js';
import { ChatManager } from './js/chat-manager.js';
import { MessageRenderer } from './js/message-renderer.js';
import { RouteRetryAutopilot } from './js/route-retry-autopilot.js';

// Every composer model / provider / AI-mode write goes through
// updateModelSelection. Log the transition with a trimmed stack so a flip the
// user never asked for (the composer landing on the managed default mid-turn,
// 2026-09-27) can be traced from ropilot-renderer.log to the path that wrote it.
const TRACED_MODEL_SELECTION_KEYS = ['model', 'provider', 'useRopilotCredits'];
function traceModelSelectionChange(current, patch) {
  const changes = TRACED_MODEL_SELECTION_KEYS
    .filter((key) => key in patch && patch[key] !== current[key])
    .map((key) => `${key}: ${String(current[key] ?? '(unset)')} -> ${String(patch[key])}`);
  if (changes.length === 0) return;
  const stack = String(new Error().stack || '')
    .split('\n')
    .slice(3, 9)
    .map((frame) => frame.trim().replace(/^at /, ''))
    .join(' <- ');
  console.info(`[MODEL] ${changes.join('; ')} | ${stack}`);
}
import { MessageEditor } from './js/message-editor.js';
import { PendingMessageUI } from './js/message-queue.js';
import { setupApiKeyValidation, validateApiKeyAtStartup, isApiKeyValidated, onValidationChange, setEdgeUrl } from './js/api-validation.js';
import { escapeHtml, autoResizeTextarea, isTempPath, generateId, formatDuration, highlightLua, truncateMiddle, getScriptIcon, inferScriptTypeFromPath, scrollChatMessagesToEnd } from './js/utils.js';
import { formatMessage } from './js/message-formatter.js';
import { categorizeToolUse } from './js/tool-categorizer.js';
import { store } from './js/state-store.js';
import { wsUrlToHttpOrigin, siteUrlFromConfig } from './js/core/urls.js';
import { RojoManager } from './js/rojo-manager.js';
import { MessageHandler } from './js/message-handler.js';
import { MessageSender } from './js/message-sender.js';
import { SetupFlow } from './js/setup-flow.js';
import { DragDrop } from './js/drag-drop.js';
import { PlanModeManager } from './js/plan-mode-manager.js';
import { SlashCommandManager } from './js/slash-commands.js';
import { TaskNotificationManager } from './js/task-notification-manager.js';
import { TtfwAnalytics } from './js/ttfw-analytics.js';
import { AiProviderAnalytics } from './js/ai-provider-analytics.js';
import { RopilotHarness } from './js/ropilot-harness/index.js';
import {
  appendContextWindowActivity,
  clearContextWindowActivities,
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  migrateLegacyContextWindowActivities,
} from './js/context-window.js';
import { electronAPI } from './js/core/platform.js';
import { bindAllEvents } from './js/wiring/index.js';
import * as modelCatalog from './js/models/model-catalog.js';
import { isModelAvailableOnPlatform } from './js/models/release-availability.js';
import * as storage from './js/core/storage.js';
import { ComposerDropdowns } from './js/composer/composer-dropdowns.js';
import { ComposerFooter } from './js/composer/composer-footer.js';
import { Sidebar } from './js/ui/sidebar.js';
import { Modals } from './js/ui/modals.js';
import { ImagePreview } from './js/ui/image-preview.js';
import { SettingsNav } from './js/ui/settings-nav.js';
import { TitlebarTabs } from './js/ui/titlebar-tabs.js';
import { SidebarHoverCard } from './js/ui/sidebar-hover-card.js';
import { CreditsWall } from './js/credits/credits-wall.js';

const MAX_COMPOSER_IMAGES = 4;
const MAX_COMPOSER_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_COMPOSER_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

function normalizeComposerImageMimeType(rawMimeType) {
  const mimeType = typeof rawMimeType === 'string' ? rawMimeType.trim().toLowerCase() : '';
  switch (mimeType) {
    case 'image/x-png':
      return 'image/png';
    case 'image/pjpeg':
      return 'image/jpeg';
    default:
      return mimeType;
  }
}

const COMPOSER_CONTEXT_RING_CIRCUMFERENCE = 81.68;
const PENDING_GPT55_SOL_MIGRATION_KEY = 'ropilot_pending_gpt55_sol_reasoning_migration';

class RopilotApp {
  constructor() {
    // Reactive store first: the store-backed accessors below delegate to it,
    // including assignments made later in this constructor.
    this.store = store;
    this.ws = null;
    this.wsUrl = null;
    this._projects = [];  // Backing store for compatibility getter
    this.activeProjectId = localStorage.getItem('ropilot_active_project') || 'default';
    this._activeChat = null;  // Backing store for compatibility getter
    this.projectDir = null;
    this.apiKey = localStorage.getItem('ropilot_api_key') || '';
    this.config = { isTest: false, siteUrl: 'https://ropilot.ai', appUrl: 'https://app.ropilot.ai', edgeUrl: 'https://ropilot.ai/edge', releasesUrl: 'https://ropilot.ai/releases', claudeApiProxyEnabled: true };
    this.claudeInstalled = false;
    // Credits-session state (actionsRemaining/actionsLimit/userTier/
    // bonusClaimed) lives in the store under the 'credits' key; see the
    // store-backed accessors below. Session-only — populated from edge.
    this.codexAccountPlanRaw = '';
    this.codexAccountPlan = '';
    // Sidebar collapsed/preference state is seeded by the Sidebar manager
    // (instantiated with the other module managers below).
    const persistedProvider = localStorage.getItem('ropilot_model_provider') || 'claude';
    this.modelProvider = this.normalizeModelProvider(persistedProvider);
    if (this.modelProvider !== persistedProvider) {
      localStorage.setItem('ropilot_model_provider', this.modelProvider);
    }
    const persistedModel = localStorage.getItem('ropilot_selected_model') || modelCatalog.DEFAULT_MODEL_BY_PROVIDER.claude;
    this.selectedModel = this.coerceModelForProvider(this.modelProvider, persistedModel);
    if (this.selectedModel !== persistedModel) {
      localStorage.setItem('ropilot_selected_model', this.selectedModel);
    }
    const persistedUseRopilotCredits = localStorage.getItem('ropilot_use_ropilot_credits');
    const persistedBringYourOwnSubscription = localStorage.getItem('ropilot_byo_subscription');
    this.useRopilotCredits = persistedUseRopilotCredits !== null
      ? persistedUseRopilotCredits === 'true'
      : (persistedBringYourOwnSubscription !== null ? persistedBringYourOwnSubscription !== 'true' : false);
    this.ropilotPlusActive = localStorage.getItem('ropilot_plus_active') === 'true';
    this.lockedRopilotCreditsReasoningLevels = this.ropilotPlusActive ? [] : ['high', 'xhigh'];
    this.hasAuthoritativeManagedAiAccess = false;
    this.pendingRopilotCreditsDefaultMigration = null;
    if (this.useRopilotCredits && modelCatalog.ROPILOT_CREDITS_LEGACY_DEFAULT_MODELS.has(this.selectedModel)) {
      const legacyCreditsModel = this.selectedModel;
      this.setPendingRopilotCreditsDefaultMigration({
        sourceModel: legacyCreditsModel,
        reasoningLevel: localStorage.getItem(`ropilot_reasoning_level_credits_${legacyCreditsModel}`)
      });
    } else if (
      this.useRopilotCredits
      && this.selectedModel === modelCatalog.ROPILOT_CREDITS_DEFAULT_MODEL
      && (localStorage.getItem(PENDING_GPT55_SOL_MIGRATION_KEY) === 'high'
        || localStorage.getItem(PENDING_GPT55_SOL_MIGRATION_KEY) === 'xhigh')
    ) {
      this.setPendingRopilotCreditsDefaultMigration({
        sourceModel: 'gpt-5.5',
        reasoningLevel: localStorage.getItem(PENDING_GPT55_SOL_MIGRATION_KEY)
      });
    }
    this.ropilotCreditsRoutePriority = this.normalizeRopilotCreditsRoutePriority(
      localStorage.getItem('ropilot_credits_route_priority')
    );
    localStorage.setItem('ropilot_credits_route_priority', this.ropilotCreditsRoutePriority);
    // Seed the per-model reasoning maps into local objects first, then assign
    // once — the accessors put a fresh container into the store per write.
    const seededReasoningLevelsByModel = {};
    const seededCreditsReasoningLevelsByModel = {};
    for (const model of modelCatalog.MODEL_CATALOG) {
      const persistedModelLevel = localStorage.getItem(`ropilot_reasoning_level_${model.value}`);
      const persistedProviderLevel = localStorage.getItem(`ropilot_reasoning_level_${model.provider}`);
      const normalizedLevel = this.normalizeReasoningLevelForModel(model.value, persistedModelLevel, { useRopilotCredits: false })
        || this.normalizeReasoningLevelForModel(model.value, persistedProviderLevel, { useRopilotCredits: false })
        || this.getDefaultReasoningLevelForModel(model.value, { useRopilotCredits: false });
      seededReasoningLevelsByModel[model.value] = normalizedLevel;
      localStorage.setItem(`ropilot_reasoning_level_${model.value}`, normalizedLevel);

      const persistedCreditsLevel = localStorage.getItem(`ropilot_reasoning_level_credits_${model.value}`);
      const pendingLegacyLevel = this.pendingRopilotCreditsDefaultMigration?.sourceModel === model.value
        ? this.normalizeReasoningLevel(this.pendingRopilotCreditsDefaultMigration.reasoningLevel)
        : '';
      const normalizedCreditsLevel = pendingLegacyLevel
        || this.normalizeReasoningLevelForModel(model.value, persistedCreditsLevel, { useRopilotCredits: true })
        || this.getDefaultReasoningLevelForModel(model.value, { useRopilotCredits: true });
      seededCreditsReasoningLevelsByModel[model.value] = normalizedCreditsLevel;
      localStorage.setItem(`ropilot_reasoning_level_credits_${model.value}`, normalizedCreditsLevel);
    }
    this.reasoningLevelsByModel = seededReasoningLevelsByModel;
    this.ropilotCreditsReasoningLevelsByModel = seededCreditsReasoningLevelsByModel;
    this.codexFastMode = localStorage.getItem('ropilot_codex_fast_mode') === 'true';
    // Managed Fast is restored only from its own key. It is never derived
    // from the personal Codex flag, so flipping BYO -> Credits cannot carry
    // a free preference over into a 2.5x-credits one.
    this.ropilotCreditsFastMode = localStorage.getItem('ropilot_credits_fast_mode') === 'true';
    const persistedAutoPlaytest = localStorage.getItem('ropilot_auto_playtest');
    const persistedAutoPlaytestUserSet = localStorage.getItem('ropilot_auto_playtest_user_set') === 'true';
    this.hasAutoPlaytestPreference = persistedAutoPlaytestUserSet || persistedAutoPlaytest === 'false';
    this.autoPlaytest = this.hasAutoPlaytestPreference
      ? persistedAutoPlaytest !== 'false'
      : this.getDefaultAutoPlaytestForMode(this.useRopilotCredits);
    this.codexPlaytestSubagentModel = this.normalizeCodexPlaytestSubagentModelPreference(
      localStorage.getItem('ropilot_codex_playtest_subagent_model') || modelCatalog.DEFAULT_CODEX_PLAYTEST_SUBAGENT_MODEL
    );
    localStorage.setItem('ropilot_codex_playtest_subagent_model', this.codexPlaytestSubagentModel);
    this.customPrompt = localStorage.getItem('ropilot_custom_prompt') || '';

    // Processing state is store-backed (single source of truth)

    // Keep chat sync orchestration in the renderer and resolve local
    // transcript files through the local Go server, not Electron IPC.
    const cloudChatSync = new ChatSyncService(() => this.apiKey, () => this.config.edgeUrl);
    const commitChatSync = new ChatSyncCommitService(this, {
      fileAdapter: createElectronChatSyncFileAdapter({
        getWsUrl: () => this.wsUrl
      })
    });
    this.chatSync = new FrontendChatSync({
      cloudSync: cloudChatSync,
      commitSync: commitChatSync
    });
    this.pendingSyncReplayScheduled = false;

    // Initialize module managers
    this.statusManager = new StatusManager(this);
    this.sidebar = new Sidebar(this);
    this.modals = new Modals(this);
    this.imagePreview = new ImagePreview(this);
    this.settingsNav = new SettingsNav(this);
    this.settingsNav.bind();
    this.titlebarTabs = new TitlebarTabs(this);
    this.titlebarTabs.bind();
    this.sidebarHoverCard = new SidebarHoverCard(this);
    this.sidebarHoverCard.bind();
    this.creditsWall = new CreditsWall(this);
    this.composerDropdowns = new ComposerDropdowns(this);
    this.composerFooter = new ComposerFooter(this);
    this.playtestPanel = new PlaytestPanel(this);
    this.diffPreview = new DiffPreview(this);
    this.settings = new Settings(this);
    this.settings.applyDiffTheme(localStorage.getItem('ropilot_diff_theme') || 'studio');
    this.wsManager = new WebSocketManager(this);
    this.projectManager = new ProjectManager(this);
    this.chatManager = new ChatManager(this);
    this.messageRenderer = new MessageRenderer(this);
    this.routeRetryAutopilot = new RouteRetryAutopilot(this);
    this.messageEditor = new MessageEditor(this);
    this.pendingMessageUI = new PendingMessageUI(this);
	    this.rojoManager = new RojoManager(this);
	    this.messageHandler = new MessageHandler(this);
	    this.messageSender = new MessageSender(this);
	    this.setupFlow = new SetupFlow(this);
	    this.dragDrop = new DragDrop(this);
	    this.planModeEnabled = false;
	    this.planModeManager = new PlanModeManager(this);
    this.slashCommandManager = new SlashCommandManager(this);
    this.taskNotificationManager = new TaskNotificationManager(this);
    this.ttfwAnalytics = new TtfwAnalytics(this);
    this.aiProviderAnalytics = new AiProviderAnalytics(this);
    this.ropilotHarness = new RopilotHarness(this);
    // Live Studio diagnostics feature is postponed; panel removed (see git history).
    this.studioErrorPanel = null;

    // Prompt stash - saves typed drafts and drafts from chat switches to localStorage.
    this.promptStash = new Map();
    this.promptStashDirtyFlag = false;
    this.promptStashSaveTimer = null;
    this.composerImageStash = new Map(); // chatId -> [{ mime_type, data }]

    // Tool call abstraction state
    this.currentActivity = null;
    this.activityPaths = [];

    // Message editing state
    this.editingMessageIndex = null;
    this.pendingEditIndex = null;
    this.pendingRewind = false; // Set to true after rewind, cleared after sending message
    this.pendingCodexRewindStrict = false;
    this.noActionsCreditRefreshTimer = null;
    this.noActionsAutoRetryInFlight = false;
    this.noActionsUpgradeToRopilotCreditsPending = false;
    this.noActionsChatGptUsageLimitRetryAt = '';
    // Managed credits-wall auto-resume guards (see js/credits/credits-wall.js):
    // episode = chat + last user message; attempts are capped per episode and
    // a dismissal ("Maybe later" / Stop) suppresses re-shows until the key
    // changes on the next user-initiated send.
    this.noActionsWallEpisodeKey = '';
    this.noActionsWallDismissedKey = '';
    this.noActionsWallShownBalance = null;
    this.noActionsAutoResumeAttempts = 0;
    this.noActionsLastAutoResumeAt = 0;
    this.noActionsAutoResumeCapReached = false;
    this.preserveRopilotCreditsModeUntilMs = 0;
    this.latestManagedAiCreditsBalance = null;
    this.latestManagedAiCreditsPayload = null;
    this.managedAiCreditAccess = null;
    // Anthropic models are open to every Credits account (2026-09-24); only a
    // persisted explicit hide from the server locks them, never a Plus default.
    this.hideAnthropicManagedCreditModels = localStorage.getItem('ropilot_hide_anthropic_managed_credit_models') === 'true';

    // Project editing state
    this.editingProjectId = null;

    // Chat editing state (for rename)
    this.editingChatId = null;
    this.pendingDeleteChat = null;
    this.pendingAppAlertFocusSelector = null;
    this.modalFocusReturnTargets = new Map();
    this.composerImageHoverPreviewEl = null;
    this.composerImageHoverPreviewImageEl = null;
    this.activeComposerHoverAnchor = null;
    this.composerImageHoverPreviewListenersBound = false;
    this.chatFloatingClearanceObserver = null;
    this.pendingChatFloatingClearanceFrame = null;

    // Message queue for handling messages while processing
    // Map of chatId -> array of message contents (truly per-chat queuing)
    this.messageQueues = new Map();
    this.processingStartedAt = new Map();

    // Pending messages per chat - Map of chatId -> pending message content
    // Replaces global pendingMessage/pendingMessageChatId for true per-chat state
    this.pendingMessages = new Map();

    // Track if emit was received during processing (to keep loading visible until emit)
    this.receivedEmit = false;

    this.init();
  }

  // =============================================================
  // COMPATIBILITY GETTERS - Delegate to store for gradual migration
  // =============================================================

  get activeChat() {
    return this.store?.getActiveChat() ?? this._activeChat;
  }

  set activeChat(chat) {
    if (this.store) {
      if (chat) {
        this.store.setActiveChat(chat.id);
      } else {
        this.store.set('activeChatId', null);
      }
    }
    this._activeChat = chat;
  }

  // Store-backed accessors: the store owns this state; these keep legacy
  // `app.x` reads and writes working while call sites migrate.
  get activeProjectId() {
    return this.store.get('activeProjectId');
  }

  set activeProjectId(id) {
    this.store.set('activeProjectId', id);
  }

  get playtestActive() {
    return this.store.get('playtestActive');
  }

  set playtestActive(active) {
    this.store.set('playtestActive', active);
  }

  get activePlaytestPanelId() {
    return this.store.get('activePlaytestPanelId');
  }

  set activePlaytestPanelId(id) {
    this.store.set('activePlaytestPanelId', id);
  }

  get activePlaytestChatId() {
    return this.store.get('activePlaytestChatId');
  }

  set activePlaytestChatId(id) {
    this.store.set('activePlaytestChatId', id);
  }

  // Model-selection state lives in the store under the single 'modelSelection'
  // key. The `_modelSelection` fallback keeps prototype-only test stubs
  // (Object.create(RopilotApp.prototype), no constructor/store) working,
  // mirroring the activeChat compatibility accessor above.
  getModelSelectionState() {
    return (this.store ? this.store.get('modelSelection') : this._modelSelection) || {};
  }

  updateModelSelection(patch) {
    const current = this.getModelSelectionState();
    let changed = false;
    for (const key of Object.keys(patch)) {
      if (current[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    traceModelSelectionChange(current, patch);
    // A fresh object on purpose: set() no-ops on identical references, so a
    // patch must produce a new container for notify to fire. This is the
    // intended exception to the mutate-in-place convention.
    const next = { ...current, ...patch };
    if (this.store) {
      this.store.set('modelSelection', next);
    } else {
      this._modelSelection = next;
    }
  }

  get modelProvider() {
    return this.getModelSelectionState().provider;
  }

  set modelProvider(v) {
    this.updateModelSelection({ provider: v });
  }

  get selectedModel() {
    return this.getModelSelectionState().model;
  }

  set selectedModel(v) {
    this.updateModelSelection({ model: v });
  }

  get useRopilotCredits() {
    return this.getModelSelectionState().useRopilotCredits;
  }

  set useRopilotCredits(v) {
    this.updateModelSelection({ useRopilotCredits: v });
  }

  get codexFastMode() {
    return this.getModelSelectionState().codexFastMode;
  }

  set codexFastMode(v) {
    this.updateModelSelection({ codexFastMode: v });
  }

  get ropilotCreditsFastMode() {
    return this.getModelSelectionState().ropilotCreditsFastMode === true;
  }

  set ropilotCreditsFastMode(v) {
    this.updateModelSelection({ ropilotCreditsFastMode: v === true });
  }

  get reasoningLevelsByModel() {
    return this.getModelSelectionState().reasoningLevelsByModel;
  }

  set reasoningLevelsByModel(v) {
    this.updateModelSelection({ reasoningLevelsByModel: v });
  }

  get ropilotCreditsReasoningLevelsByModel() {
    return this.getModelSelectionState().creditsReasoningLevelsByModel;
  }

  set ropilotCreditsReasoningLevelsByModel(v) {
    this.updateModelSelection({ creditsReasoningLevelsByModel: v });
  }

  // Credits-session state lives in the store under the single 'credits' key
  // (session-only account balance/tier fields from edge; no localStorage
  // persistence). The `_credits` fallback keeps prototype-only test stubs
  // working, mirroring the modelSelection accessors above.
  getCreditsState() {
    return (this.store ? this.store.get('credits') : this._credits) || {};
  }

  updateCredits(patch) {
    const current = this.getCreditsState();
    let changed = false;
    for (const key of Object.keys(patch)) {
      if (current[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    // A fresh object on purpose: set() no-ops on identical references, so a
    // patch must produce a new container for notify to fire.
    const next = { ...current, ...patch };
    if (this.store) {
      this.store.set('credits', next);
    } else {
      this._credits = next;
    }
  }

  get actionsRemaining() {
    return this.getCreditsState().actionsRemaining;
  }

  set actionsRemaining(v) {
    this.updateCredits({ actionsRemaining: v });
  }

  get actionsLimit() {
    return this.getCreditsState().actionsLimit;
  }

  set actionsLimit(v) {
    this.updateCredits({ actionsLimit: v });
  }

  get userTier() {
    return this.getCreditsState().userTier;
  }

  set userTier(v) {
    this.updateCredits({ userTier: v });
  }

  get bonusClaimed() {
    return this.getCreditsState().bonusClaimed;
  }

  set bonusClaimed(v) {
    this.updateCredits({ bonusClaimed: v });
  }

  // Persist model-selection changes centrally — replaces the
  // localStorage.setItem calls that sat beside every provider/model/credits/
  // fast-mode/reasoning assignment. Subscribed once from init(); the
  // reasoning maps are diffed so only changed models re-persist their keys.
  initModelSelectionPersistence() {
    this.store.subscribe('modelSelection', (next, prev) => {
      const before = prev || {};
      if (next.provider !== before.provider && next.provider) {
        storage.set(storage.KEYS.modelProvider, next.provider);
      }
      if (next.model !== before.model && next.model) {
        storage.set(storage.KEYS.selectedModel, next.model);
      }
      if (next.useRopilotCredits !== before.useRopilotCredits) {
        storage.set(storage.KEYS.useRopilotCredits, next.useRopilotCredits === true);
        storage.set(storage.KEYS.byoSubscription, next.useRopilotCredits !== true);
      }
      if (next.codexFastMode !== before.codexFastMode) {
        storage.set(storage.KEYS.codexFastMode, next.codexFastMode === true);
      }
      if (next.ropilotCreditsFastMode !== before.ropilotCreditsFastMode) {
        storage.set(storage.KEYS.ropilotCreditsFastMode, next.ropilotCreditsFastMode === true);
      }
      const beforeLevels = before.reasoningLevelsByModel || {};
      for (const [model, level] of Object.entries(next.reasoningLevelsByModel || {})) {
        if (beforeLevels[model] !== level) {
          storage.set(storage.reasoningLevelKey(model), level);
        }
      }
      const beforeCreditsLevels = before.creditsReasoningLevelsByModel || {};
      for (const [model, level] of Object.entries(next.creditsReasoningLevelsByModel || {})) {
        if (beforeCreditsLevels[model] !== level) {
          storage.set(storage.reasoningLevelKey(model, { credits: true }), level);
        }
      }
      // The provider settling on 'codex' is the moment a chat opened earlier
      // in boot (when it still read 'claude') becomes prewarmable.
      if (next.provider !== before.provider && next.provider === 'codex') {
        this.maybePrewarmActiveCodexSession();
      }
    });
  }

  async loadRuntimeConfig() {
    const siteUrl = siteUrlFromConfig(this.config, '');
    if (!siteUrl) return;

    try {
      const response = await fetch(`${siteUrl}/api/desktop-runtime-config`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`runtime config failed: ${response.status}`);
      }

      const runtimeConfig = await response.json();
      if (typeof runtimeConfig?.claude_api_proxy_enabled === 'boolean') {
        this.config.claudeApiProxyEnabled = runtimeConfig.claude_api_proxy_enabled;
      } else if (typeof runtimeConfig?.claudeApiProxyEnabled === 'boolean') {
        this.config.claudeApiProxyEnabled = runtimeConfig.claudeApiProxyEnabled;
      }
    } catch (err) {
      console.warn('Failed to load Ropilot runtime config:', err);
      if (typeof this.config.claudeApiProxyEnabled !== 'boolean') {
        this.config.claudeApiProxyEnabled = true;
      }
    }
  }

  isClaudeAPIProxyEnabled() {
    return this.config?.claudeApiProxyEnabled !== false;
  }

  get projects() {
    return this.store?.get('projects') ?? this._projects;
  }

  set projects(value) {
    if (this.store) {
      this.store.setProjects(value);
    }
    this._projects = value;
  }

  async init() {
    // Install the model-selection persistence subscriber before anything
    // (edge settings load, model refresh) can change the store.
    this.initModelSelectionPersistence();

    const api = electronAPI();
    // Load environment config (test vs production URLs)
    if (api?.getConfig) {
      this.config = await api.getConfig();
      if (typeof this.config.claudeApiProxyEnabled !== 'boolean') {
        this.config.claudeApiProxyEnabled = true;
      }
      setEdgeUrl(this.config.edgeUrl);
    }
    this.config = await selectConnectionConfig(this.config);
    setEdgeUrl(this.config.edgeUrl);
    await this.loadRuntimeConfig();

    // Apply platform class for styling
    const platform = api.getPlatform();
    document.body.classList.add(`platform-${platform}`);

    // Set platform-specific terminal name and alt login commands
    if (platform === 'win32') {
      const instruction = document.getElementById('login-instruction');
      if (instruction) instruction.textContent = 'Run the installer, then run in PowerShell or Command Prompt:';
      const altLine = document.getElementById('login-alt-line');
      if (altLine) altLine.innerHTML = 'or <code>~\\.local\\bin\\claude.exe /login</code> or <code>%USERPROFILE%\\.local\\bin\\claude.exe /login</code>';
    }

    // Apply Windows version class
    if (platform === 'win32') {
      const isWin11 = await api.isWindows11();
      const userTransparency = await api.getTransparencySetting?.() ?? false;

      api.onTransparencySetting?.((enabled) => {
        document.body.classList.toggle('transparency-disabled-by-user', !enabled);
      });

      if (userTransparency) {
        if (isWin11) {
          // Default to CSS fallback - native-blur-success will override if native effects work
          document.body.classList.add('win11-css-fallback');

          // Register DWM nudge fix unconditionally on Win11
          // (Previously was inside onNativeBlurStatus which had a race condition)
          try {
            api.onWindowFocus?.(() => {
              try {
                const w = window.outerWidth;
                const h = window.outerHeight;
                window.resizeTo(w + 1, h);
                setTimeout(() => window.resizeTo(w, h), 16);
              } catch (e) { console.warn('DWM resize nudge failed:', e.message); }
            });
          } catch (e) { console.warn('Failed to register DWM focus fix:', e.message); }
        } else {
          document.body.classList.add('win10-fallback');
        }

        // Listen for native blur status from main process
        api.onNativeBlurStatus?.((status) => {
          // Handle both old (boolean) and new (object) formats
          const applied = typeof status === 'object' ? status.applied : status;
          const osTransparency = typeof status === 'object' ? status.transparencyEnabled : true;

          console.log('Native blur status:', { applied, osTransparency });

          if (applied) {
            document.body.classList.remove('win11-css-fallback');
            document.body.classList.add('native-blur-success');

            // If OS transparency effects are disabled, blur won't render - use more opaque background
            if (!osTransparency) {
              console.log('Transparency effects disabled - using opaque fallback');
              document.body.classList.add('transparency-disabled');
            } else {
              document.body.classList.remove('transparency-disabled');
            }
          } else {
            document.body.classList.remove('native-blur-success');
            document.body.classList.remove('transparency-disabled');
            console.log('Using CSS backdrop-filter as fallback');
          }
        });
      } else {
        // User disabled transparency in settings
        document.body.classList.add('transparency-disabled-by-user');
      }
    }

    // Load account settings before setup routing so returning managed-credit
    // users are not sent back through provider auth on startup. Local flags are
    // only a signal to wait for fresh account state; edge remains authoritative.
    if (this.apiKey) {
      const needsAuthoritativeAccountState =
        localStorage.getItem('ropilot_use_ropilot_credits') === 'true'
        || localStorage.getItem('ropilot_free_offer_claimed') === '1'
        || !!localStorage.getItem('ropilot_free_offer_claim_unavailable_reason');
      await this.settings.loadFromEdge({
        timeoutMs: needsAuthoritativeAccountState ? 1200 : 600,
        refreshManagedCredits: false
      });
    }
    this.applyPendingRopilotCreditsDefaultMigration();

    // Check Claude CLI installation
    await this.setupFlow.checkClaudeInstallation();

    // Get WebSocket URL from main process
    this.wsUrl = await api.getWsUrl();

    // Bind events
    this.bindEvents();
    this.sidebar.bindSidebarAutoCollapse();
    this.taskNotificationManager.bindWindowState();
    this.sidebar.setupChatFloatingComposerClearanceSync();

    // Setup API key validation
    setupApiKeyValidation();

    // Validate existing API key at startup (non-blocking)
    const effectiveKey = this.apiKey || this.projectManager?.getEffectiveApiKey?.();
    if (effectiveKey) {
      validateApiKeyAtStartup(effectiveKey);  // Fire and forget
    }

    onValidationChange(() => {
      this.chatSync?.handleApiKeyChange();
    });

    // Load projects (with cloud sync if available)
    await this.projectManager.loadWithSync();

    // Mirror the global custom prompt into Go-backed durable settings. Import
    // localStorage once for existing installs; thereafter it is only a cache.
    const durableSettings = await this.projectManager.syncManager.loadGoSettings();
    if (durableSettings && typeof durableSettings.customPrompt === 'string') {
      this.customPrompt = durableSettings.customPrompt;
      localStorage.setItem('ropilot_custom_prompt', this.customPrompt);
    } else if (durableSettings && this.customPrompt) {
      await this.projectManager.syncManager.saveGoSettings({ customPrompt: this.customPrompt });
    }

    // Initialize store with loaded data
    this.store.setProjects(this._projects);

    // Persist project selection centrally - replaces the manual
    // localStorage.setItem calls that sat beside every assignment.
    this.store.subscribe('activeProjectId', (id) => {
      if (id) localStorage.setItem('ropilot_active_project', id);
    });

    // Subscribe to state changes for auto-render
    this.store.subscribe('projects', () => {
      this.projectManager.renderList();
    });

    this.store.subscribe('activeChatId', (chatId) => {
      if (chatId) {
        this.messageRenderer.render();
      }
      this.messageSender.updateButton();
      this.renderComposerContextUsage(chatId ? this.store.getChatById(chatId) : null);
      // Opening an empty chat — including the deferred restore of the last
      // active chat at boot — is the same prewarm opportunity as creating one.
      if (chatId) this.maybePrewarmActiveCodexSession();
    });

    this.store.subscribe('processingChatIds', () => {
      this.messageSender.updateButton();
      this.projectManager.renderList();
    });

    // Load prompt stash from localStorage and clean up stale entries
    this.loadPromptStash();

    // Render initial state
    this.projectManager.renderList();

    // Restore last active chat (if it still exists) — deferred until after
    // first paint so hydrating a large chat file can't block initial
    // interactivity (window chrome, sidebar, composer).
    this.scheduleActiveChatRestore();

    // Initialize project directory from active project
    const activeProject = this.projectManager.getActive();
    if (activeProject && activeProject.workingDir) {
      this.projectDir = activeProject.workingDir;
    }
    this.updateProjectDirDisplay();

    // Check if Rojo is already running (e.g., from previous session)
    this.rojoManager.checkStatus();

    // Load API key into settings
    document.getElementById('input-api-key').value = this.apiKey;

    // Load model selection with auth-based filtering per provider.
    await this.refreshModelOptions();
    this.refreshReasoningOptions();
    this.renderComposerContextUsage();

    // Load auto playtest setting
    const autoPlaytestCheckbox = document.getElementById('auto-playtest-checkbox');
    if (autoPlaytestCheckbox) {
      autoPlaytestCheckbox.checked = this.autoPlaytest;
    }
    this.syncComposerFooterControls();

    // Apply saved sidebar state
    this.sidebar.applySidebarState();

    // Connect WebSocket
    this.wsManager.connect();

    // Load and flush legacy pending sync state after the initial UI settles.
    this.schedulePendingSyncReplay();

    // Start polling for server updates (enables multi-instance sync)
    this.projectManager.startPolling();

    // Load settings from edge again after the UI is fully initialized. The
    // early load above is for setup routing; this keeps the visible account
    // controls fresh after projects/chats are restored.
    this.settings.loadFromEdge();
  }

  normalizeSelectedModel(model) {
    return modelCatalog.normalizeSelectedModel(model);
  }

  normalizeModelProvider(provider) {
    return modelCatalog.normalizeModelProvider(provider);
  }

  getChatProvider(chat, fallbackProvider = this.modelProvider) {
    if (chat && typeof chat.provider === 'string' && chat.provider.trim()) {
      return this.normalizeModelProvider(chat.provider);
    }
    if (chat?.codexThreadId && !chat?.claudeSessionId) {
      return 'codex';
    }
    if (chat?.claudeSessionId && !chat?.codexThreadId) {
      return 'claude';
    }
    return this.normalizeModelProvider(fallbackProvider);
  }

  normalizeReasoningLevel(level) {
    return modelCatalog.normalizeReasoningLevel(level);
  }

  getModelConfig(modelValue) {
    return modelCatalog.getModelConfig(modelValue);
  }

  setModelProvider(provider) {
    this.modelProvider = this.normalizeModelProvider(provider);
    if (this.isUseRopilotCreditsEnabled?.() === true) {
      this.selectedModel = this.coerceRopilotCreditsModel(this.selectedModel);
      this.modelProvider = this.getProviderForModel(this.selectedModel) || this.modelProvider;
    } else {
      this.selectedModel = this.coerceModelForProvider(this.modelProvider, this.selectedModel);
    }
    this.applyDefaultAutoPlaytestForMode(this.isUseRopilotCreditsEnabled(), this.modelProvider);
    const activeChat = this.activeChat;
    if (activeChat) {
      const hadExplicitProvider = typeof activeChat.provider === 'string' && activeChat.provider.trim() !== '';
      const previousProvider = this.getChatProvider(activeChat);
      activeChat.provider = this.modelProvider;
      if (!hadExplicitProvider || previousProvider !== this.modelProvider) {
        this.saveProjects();
      }
    }
    this.refreshReasoningOptions();
    if (this.activeChat) {
      this.messageRenderer.render();
    }
    this.renderComposerContextUsage();
    this.refreshModelOptions().catch((err) => {
      console.warn('Failed to refresh model options after provider change:', err);
    });
  }

  toFiniteNumber(value) {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  parseCompactTokenCount(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.replace(/,/g, '').trim();
    if (!trimmed) return null;

    const match = trimmed.match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
    if (!match) return null;

    const base = Number(match[1]);
    if (!Number.isFinite(base)) return null;

    const suffix = (match[2] || '').toUpperCase();
    const multiplier = suffix === 'K'
      ? 1_000
      : suffix === 'M'
        ? 1_000_000
        : suffix === 'B'
          ? 1_000_000_000
          : 1;

    return Math.round(base * multiplier);
  }

  formatCompactTokenCount(value) {
    const numericValue = this.toFiniteNumber(value);
    if (!Number.isFinite(numericValue) || numericValue < 0) {
      return '0';
    }

    if (numericValue >= 1_000_000) {
      const millions = numericValue / 1_000_000;
      return millions >= 100 || Number.isInteger(millions)
        ? `${Math.round(millions)}M`
        : `${millions.toFixed(1)}M`;
    }

    if (numericValue >= 1_000) {
      const thousands = numericValue / 1_000;
      return thousands >= 100 || Number.isInteger(thousands)
        ? `${Math.round(thousands)}K`
        : `${thousands.toFixed(1)}K`;
    }

    return Math.round(numericValue).toString();
  }

  formatContextUsagePercentage(value) {
    const numericValue = this.toFiniteNumber(value);
    if (!Number.isFinite(numericValue) || numericValue < 0) {
      return null;
    }

    if (numericValue < 10) {
      return `${numericValue.toFixed(1).replace(/\.0$/, '')}%`;
    }

    return `${Math.round(numericValue)}%`;
  }

  getProviderDisplayName(provider) {
    return modelCatalog.getProviderDisplayName(provider);
  }

  getContextUsageModelLabel(model, provider) {
    const modelValue = typeof model === 'string' ? model.trim() : '';
    if (!modelValue) return '';

    const normalizedProvider = this.normalizeModelProvider(provider || this.getProviderForModel(modelValue));
    const normalizedModel = this.normalizeSelectedModel(modelValue);
    const config = this.getModelConfig(normalizedModel);
    if (config?.label) return config.label;

    if (normalizedProvider === 'claude') {
      if (/fable/i.test(modelValue) && /5[.-]?1/.test(modelValue) && /\[1m\]/i.test(modelValue)) return 'Claude Fable 5.1 [1M]';
      if (/fable/i.test(modelValue) && /5[.-]?1/.test(modelValue)) return 'Claude Fable 5.1';
      if (/fable/i.test(modelValue) && /\[1m\]/i.test(modelValue)) return 'Claude Fable 5 [1M]';
      if (/fable/i.test(modelValue)) return 'Claude Fable 5';
      if (/opus/i.test(modelValue)) return 'Claude Opus';
      if (/sonnet/i.test(modelValue)) return 'Claude Sonnet';
      if (/haiku/i.test(modelValue)) return 'Claude Haiku';
    }

    return modelValue;
  }

  getChatContextUsage(chat = this.activeChat) {
    if (!chat) return null;
    migrateLegacyContextWindowActivities(chat, {
      fallbackProvider: this.getChatProvider(chat, this.modelProvider),
      fallbackModel: chat?.model || this.selectedModel,
    });
    return deriveLatestContextWindowSnapshot(chat.activities || []);
  }

  updateChatContextUsage(chat, rawUsage) {
    if (!chat) return null;

    const result = appendContextWindowActivity(chat, rawUsage, {
      fallbackProvider: this.getChatProvider(chat, this.modelProvider),
      fallbackModel: chat?.model || this.selectedModel,
    });
    if (!result.usage) {
      return null;
    }

    if (!result.changed) {
      if (this.activeChat?.id === chat.id) {
        this.renderComposerContextUsage(chat);
      }
      return result.usage;
    }

    chat.updatedAt = Date.now();
    this.projectManager.markChatForFullUpdate(chat.id);
    this.saveProjects();

    if (this.activeChat?.id === chat.id) {
      this.renderComposerContextUsage(chat);
    }

    return result.usage;
  }

  clearChatContextUsage(chat, { persist = true, rerender = true } = {}) {
    if (!chat) {
      return false;
    }

    if (!clearContextWindowActivities(chat)) {
      if (rerender && this.activeChat?.id === chat?.id) {
        this.renderComposerContextUsage(chat);
      }
      return false;
    }

    chat.updatedAt = Date.now();
    this.projectManager.markChatForFullUpdate(chat.id);
    if (persist) {
      this.saveProjects();
    }

    if (rerender && this.activeChat?.id === chat.id) {
      this.renderComposerContextUsage(chat);
    }

    return true;
  }

  renderComposerContextUsage(chat = this.activeChat) {
    const indicator = document.getElementById('composer-context-indicator');
    const button = document.getElementById('composer-context-button');
    const ringProgress = document.getElementById('composer-context-ring-progress');
    const tipPrimary = document.getElementById('composer-context-tip-primary');
    const tipSecondary = document.getElementById('composer-context-tip-secondary');
    if (!indicator || !button || !ringProgress || !tipPrimary || !tipSecondary) {
      return;
    }

    const usage = this.getChatContextUsage(chat);
    if (!usage) {
      indicator.classList.add('hidden');
      button.setAttribute('aria-label', 'Context usage unavailable');
      tipPrimary.textContent = '';
      tipSecondary.textContent = '';
      ringProgress.style.strokeDashoffset = `${COMPOSER_CONTEXT_RING_CIRCUMFERENCE}`;
      ringProgress.style.stroke = '';
      return;
    }

    const percentage = this.toFiniteNumber(usage.usedPercentage);
    const hasPercentage = Number.isFinite(percentage);
    const normalizedPercentage = hasPercentage ? Math.max(0, Math.min(100, percentage)) : 0;
    const percentageLabel = hasPercentage
      ? (this.formatContextUsagePercentage(normalizedPercentage) || `${Math.round(normalizedPercentage)}%`)
      : null;
    const usedLabel = formatContextWindowTokens(usage.usedTokens);
    const maxLabel = usage.maxTokens != null ? formatContextWindowTokens(usage.maxTokens) : null;
    const dashOffset = hasPercentage
      ? COMPOSER_CONTEXT_RING_CIRCUMFERENCE - ((normalizedPercentage / 100) * COMPOSER_CONTEXT_RING_CIRCUMFERENCE)
      : COMPOSER_CONTEXT_RING_CIRCUMFERENCE;

    let accentColor = 'rgba(148, 163, 184, 0.82)';
    if (normalizedPercentage >= 90) {
      accentColor = 'rgba(248, 113, 113, 0.98)';
    } else if (normalizedPercentage >= 75) {
      accentColor = 'rgba(251, 191, 36, 0.98)';
    } else if (hasPercentage) {
      accentColor = 'rgba(245, 245, 245, 0.72)';
    }

    const modelLabel = this.getContextUsageModelLabel(usage.model, usage.provider);
    const providerLabel = this.getProviderDisplayName(usage.provider);
    const sourceLabel = usage.compactsAutomatically
      ? 'Codex compacts context automatically when needed.'
      : 'Current conversation context window usage.';
    const processedLabel = usage.totalProcessedTokens != null && usage.totalProcessedTokens > usage.usedTokens
      ? `Total processed: ${formatContextWindowTokens(usage.totalProcessedTokens)} tokens`
      : '';

    indicator.classList.remove('hidden');
    ringProgress.style.strokeDashoffset = `${dashOffset}`;
    ringProgress.style.stroke = accentColor;
    button.setAttribute(
      'aria-label',
      hasPercentage && percentageLabel
        ? `Context window ${percentageLabel} used`
        : `Context window ${usedLabel} tokens used`
    );
    tipPrimary.textContent = hasPercentage && percentageLabel && maxLabel
      ? `${percentageLabel} • ${usedLabel}/${maxLabel} context used`
      : `${usedLabel} tokens used so far`;
    tipSecondary.textContent = processedLabel
      ? `${processedLabel} • ${modelLabel ? `${providerLabel} • ${modelLabel}` : providerLabel} • ${sourceLabel}`
      : modelLabel
        ? `${providerLabel} • ${modelLabel} • ${sourceLabel}`
        : `${providerLabel} • ${sourceLabel}`;
  }

  getDefaultModelForProvider(provider) {
    return modelCatalog.getDefaultModelForProvider(provider, this.isCodexFreeAccount());
  }

  supportsXHighReasoningForModel(model = this.selectedModel) {
    return modelCatalog.supportsXHighReasoningForModel(model);
  }

  getSupportedReasoningLevelsForModel(model = this.selectedModel, options = {}) {
    return modelCatalog.getSupportedReasoningLevelsForModel(
      model,
      typeof options.useRopilotCredits === 'boolean' ? options.useRopilotCredits : this.isUseRopilotCreditsEnabled?.() === true,
      this.hasRopilotPlusAccess(),
      this.isCodexFreeAccount()
    );
  }

  normalizeReasoningLevelForModel(model = this.selectedModel, level, options = {}) {
    return modelCatalog.normalizeReasoningLevelForModel(
      model,
      level,
      typeof options.useRopilotCredits === 'boolean' ? options.useRopilotCredits : this.isUseRopilotCreditsEnabled?.() === true,
      this.hasRopilotPlusAccess(),
      this.isCodexFreeAccount()
    );
  }

  getDefaultReasoningLevelForModel(model = this.selectedModel, options = {}) {
    return modelCatalog.getDefaultReasoningLevelForModel(
      model,
      typeof options.useRopilotCredits === 'boolean' ? options.useRopilotCredits : this.isUseRopilotCreditsEnabled?.() === true,
      this.modelProvider
    );
  }

  getDefaultReasoningLevelForProvider(provider, options = {}) {
    return this.getDefaultReasoningLevelForModel(this.getDefaultModelForProvider(provider), options);
  }

  getMigratedRopilotCreditsReasoningLevel(sourceModel, level, options = {}) {
    const hasRopilotPlusAccess = typeof options.hasRopilotPlusAccess === 'boolean'
      ? options.hasRopilotPlusAccess
      : this.hasRopilotPlusAccess();
    return modelCatalog.getMigratedRopilotCreditsReasoningLevel(
      sourceModel,
      level,
      hasRopilotPlusAccess
    );
  }

  normalizeCodexAccountPlanRaw(raw) {
    return modelCatalog.normalizeCodexAccountPlanRaw(raw);
  }

  isCodexFreeAccount() {
    // free build: the plan no longer gates models, fast mode or defaults.
    return false;
  }

  updateCodexAccountPlanFromStatus(status) {
    const raw = this.normalizeCodexAccountPlanRaw(status?.account_plan_raw ?? status?.accountPlanRaw);
    if (!raw) return false;
    this.codexAccountPlanRaw = raw;
    this.codexAccountPlan = status?.account_plan || status?.accountPlan || raw;
    return true;
  }

  clearCodexAccountPlan() {
    this.codexAccountPlanRaw = '';
    this.codexAccountPlan = '';
  }

  applyCodexFreeAccountDefaults() {
    const hasDefault = modelCatalog.MODEL_CATALOG.some((model) => model.value === modelCatalog.CODEX_FREE_DEFAULT_MODEL && model.provider === 'codex');
    if (!hasDefault) return false;

    this.modelProvider = 'codex';
    this.selectedModel = modelCatalog.CODEX_FREE_DEFAULT_MODEL;
    this.setReasoningLevelForModel(modelCatalog.CODEX_FREE_DEFAULT_MODEL, modelCatalog.CODEX_FREE_DEFAULT_REASONING_LEVEL);
    this.codexFastMode = false;
    return true;
  }

  getReasoningLevelForModel(model = this.selectedModel, options = {}) {
    const normalizedModel = this.normalizeSelectedModel(model);
    const useRopilotCredits = typeof options.useRopilotCredits === 'boolean'
      ? options.useRopilotCredits
      : this.isUseRopilotCreditsEnabled?.() === true;
    const reasoningMap = useRopilotCredits
      ? this.ropilotCreditsReasoningLevelsByModel
      : this.reasoningLevelsByModel;
    const selected = this.normalizeReasoningLevelForModel(normalizedModel, reasoningMap?.[normalizedModel], { useRopilotCredits });
    return selected || this.getDefaultReasoningLevelForModel(normalizedModel, { useRopilotCredits });
  }

  getReasoningLevelForProvider(provider = this.modelProvider, options = {}) {
    const normalizedProvider = this.normalizeModelProvider(provider);
    const modelValue = this.getProviderForModel(this.selectedModel) === normalizedProvider
      ? this.selectedModel
      : this.getDefaultModelForProvider(normalizedProvider);
    return this.getReasoningLevelForModel(modelValue, options);
  }

  setReasoningLevelForModel(model, level, options = {}) {
    const normalizedModel = this.normalizeSelectedModel(model);
    const useRopilotCredits = typeof options.useRopilotCredits === 'boolean'
      ? options.useRopilotCredits
      : this.isUseRopilotCreditsEnabled?.() === true;
    const normalizedLevel = this.normalizeReasoningLevelForModel(normalizedModel, level, { useRopilotCredits })
      || this.getDefaultReasoningLevelForModel(normalizedModel, { useRopilotCredits });
    // Store-backed maps: build a fresh object per change so the
    // modelSelection subscriber can diff and persist just this model's key.
    if (useRopilotCredits) {
      const creditsLevels = (this.ropilotCreditsReasoningLevelsByModel && typeof this.ropilotCreditsReasoningLevelsByModel === 'object')
        ? this.ropilotCreditsReasoningLevelsByModel
        : {};
      if (creditsLevels[normalizedModel] === normalizedLevel) return;
      this.ropilotCreditsReasoningLevelsByModel = { ...creditsLevels, [normalizedModel]: normalizedLevel };
      return;
    }

    const levels = (this.reasoningLevelsByModel && typeof this.reasoningLevelsByModel === 'object')
      ? this.reasoningLevelsByModel
      : {};
    if (levels[normalizedModel] === normalizedLevel) return;
    this.reasoningLevelsByModel = { ...levels, [normalizedModel]: normalizedLevel };
  }

  setReasoningLevelForProvider(provider, level, options = {}) {
    const normalizedProvider = this.normalizeModelProvider(provider);
    const modelValue = this.getProviderForModel(this.selectedModel) === normalizedProvider
      ? this.selectedModel
      : this.getDefaultModelForProvider(normalizedProvider);
    this.setReasoningLevelForModel(modelValue, level, options);
  }

  supportsFastModeForModel(model = this.selectedModel) {
    return modelCatalog.supportsFastModeForModel(model, this.isUseRopilotCreditsEnabled?.() === true);
  }

  shouldUseFastModeForModel(model = this.selectedModel) {
    return this.supportsFastModeForModel(model) && this.codexFastMode;
  }

  setCodexFastMode(enabled) {
    this.codexFastMode = this.isCodexFreeAccount() ? false : !!enabled;
    this.refreshReasoningOptions();
  }

  // --- Managed Fast (Ropilot Credits, service_tier 'priority') ---
  // Separate from the personal Codex toggle above: different state key,
  // different wire value, different cost. The ChatGPT Free/Go guard does not
  // apply here because Credits users are billed by Ropilot, not by OpenAI.

  supportsRopilotCreditsFastModeForModel(model = this.selectedModel) {
    if (this.isUseRopilotCreditsEnabled?.() !== true) return false;
    return modelCatalog.supportsRopilotCreditsFastModeForModel(model);
  }

  shouldUseRopilotCreditsFastModeForModel(model = this.selectedModel) {
    return this.supportsRopilotCreditsFastModeForModel(model) && this.ropilotCreditsFastMode === true;
  }

  getRopilotCreditsFastModeCostMultiplier() {
    return modelCatalog.ROPILOT_CREDITS_FAST_MODE_COST_MULTIPLIER;
  }

  setRopilotCreditsFastMode(enabled) {
    this.ropilotCreditsFastMode = enabled === true;
    // Luna's Free pills depend on Fast, so the menus re-render too.
    this.syncComposerFooterControls?.();
  }

  hideCodexFastInfoTip() {
    const tip = document.getElementById('codex-fast-info-tip');
    const toggle = document.getElementById('codex-fast-info-toggle');
    tip?.classList.add('hidden');
    toggle?.setAttribute('aria-expanded', 'false');
  }

  hasRopilotPlusAccess() {
    return this.ropilotPlusActive === true;
  }

  getLockedRopilotCreditsReasoningLevels() {
    if (this.hasRopilotPlusAccess()) return [];
    const levels = Array.isArray(this.lockedRopilotCreditsReasoningLevels)
      ? this.lockedRopilotCreditsReasoningLevels
      : ['high', 'xhigh'];
    return levels
      .map((level) => this.normalizeReasoningLevel(level))
      .filter(Boolean);
  }

  isRopilotCreditsReasoningLevelLocked(level) {
    return this.isUseRopilotCreditsEnabled?.() === true
      && this.getLockedRopilotCreditsReasoningLevels().includes(this.normalizeReasoningLevel(level));
  }

  getVisibleReasoningLevelsForModel(model = this.selectedModel, options = {}) {
    const useRopilotCredits = typeof options.useRopilotCredits === 'boolean'
      ? options.useRopilotCredits
      : this.isUseRopilotCreditsEnabled?.() === true;
    if (useRopilotCredits) {
      return [...modelCatalog.ROPILOT_CREDITS_PLUS_REASONING_LEVELS];
    }
    return this.getSupportedReasoningLevelsForModel(model, { useRopilotCredits: false });
  }

  normalizeRopilotCreditsRoutePriority(value) {
    return modelCatalog.normalizeRopilotCreditsRoutePriority(value, this.hasRopilotPlusAccess());
  }

  getRopilotCreditsRoutePriority() {
    this.ropilotCreditsRoutePriority = this.normalizeRopilotCreditsRoutePriority(this.ropilotCreditsRoutePriority);
    return this.ropilotCreditsRoutePriority;
  }

  setRopilotCreditsRoutePriority(value) {
    this.ropilotCreditsRoutePriority = this.normalizeRopilotCreditsRoutePriority(value);
    localStorage.setItem('ropilot_credits_route_priority', this.ropilotCreditsRoutePriority);
    const select = document.getElementById('ropilot-credit-priority-select');
    if (select) {
      select.value = this.ropilotCreditsRoutePriority;
    }
    this.syncComposerFooterControls();
  }

  toggleCodexFastInfoTip() {
    const tip = document.getElementById('codex-fast-info-tip');
    const toggle = document.getElementById('codex-fast-info-toggle');
    if (!tip || !toggle) return;

    const willShow = tip.classList.contains('hidden');
    tip.classList.toggle('hidden', !willShow);
    toggle.setAttribute('aria-expanded', willShow ? 'true' : 'false');
  }

  getModelsForProvider(provider) {
    return modelCatalog.getModelsForProvider(provider).filter((model) => isModelAvailableOnPlatform(model.value));
  }

  getRopilotCreditsModels() {
    return modelCatalog.MODEL_CATALOG.filter((model) => {
      if (!isModelAvailableOnPlatform(model.value)) return false;
      if (!modelCatalog.ROPILOT_CREDITS_MODEL_VALUES.has(model.value)) return false;
      return !this.shouldHideAnthropicManagedCreditModels()
        || this.normalizeModelProvider(model.provider) !== 'claude';
    });
  }

  getDefaultRopilotCreditsModel() {
    const models = this.getRopilotCreditsModels();
    return models.some((model) => model.value === modelCatalog.ROPILOT_CREDITS_DEFAULT_MODEL)
      ? modelCatalog.ROPILOT_CREDITS_DEFAULT_MODEL
      : (models[0]?.value || modelCatalog.DEFAULT_MODEL_BY_PROVIDER.codex);
  }

  coerceRopilotCreditsModel(modelValue) {
    const normalizedModel = this.normalizeSelectedModel(modelValue);
    const allowedModels = this.getRopilotCreditsModels();
    return allowedModels.some((model) => model.value === normalizedModel)
      ? normalizedModel
      : this.getDefaultRopilotCreditsModel();
  }

  getRawRopilotCreditsMigrationReasoningLevel(sourceModel, chat = null, explicitLevel = '') {
    return this.normalizeReasoningLevel(explicitLevel)
      || this.normalizeReasoningLevel(chat?.reasoningLevel)
      || this.normalizeReasoningLevel(this.ropilotCreditsReasoningLevelsByModel?.[sourceModel])
      || this.normalizeReasoningLevel(localStorage.getItem(`ropilot_reasoning_level_credits_${sourceModel}`));
  }

  setPendingRopilotCreditsDefaultMigration(migration) {
    if (!migration) {
      this.pendingRopilotCreditsDefaultMigration = null;
      localStorage.removeItem(PENDING_GPT55_SOL_MIGRATION_KEY);
      return;
    }
    const sourceModel = this.normalizeSelectedModel(migration.sourceModel);
    const reasoningLevel = this.normalizeReasoningLevel(migration.reasoningLevel);
    this.pendingRopilotCreditsDefaultMigration = { sourceModel, reasoningLevel };
    if (sourceModel === 'gpt-5.5' && (reasoningLevel === 'high' || reasoningLevel === 'xhigh')) {
      localStorage.setItem(PENDING_GPT55_SOL_MIGRATION_KEY, reasoningLevel);
    } else {
      localStorage.removeItem(PENDING_GPT55_SOL_MIGRATION_KEY);
    }
  }

  shouldDeferRopilotCreditsPremiumMigration(sourceModel, reasoningLevel) {
    const normalizedModel = this.normalizeSelectedModel(sourceModel);
    const normalizedLevel = this.normalizeReasoningLevel(reasoningLevel);
    return normalizedModel === 'gpt-5.5'
      && (normalizedLevel === 'high' || normalizedLevel === 'xhigh')
      && this.hasAuthoritativeManagedAiAccess !== true;
  }

  invalidateCodexThreadForModelChange(chat, sourceModel, targetModel) {
    if (!chat || this.normalizeSelectedModel(sourceModel) === this.normalizeSelectedModel(targetModel)) {
      return false;
    }
    if (this.getProviderForModel(sourceModel) !== 'codex' && !chat.codexThreadId) {
      return false;
    }
    const changed = !!chat.codexThreadId || chat.hasHistory === true;
    chat.codexThreadId = null;
    chat.hasHistory = false;
    return changed;
  }

  applyPendingRopilotCreditsDefaultMigration() {
    const pending = this.pendingRopilotCreditsDefaultMigration;
    if (!pending) return false;
    if (this.isUseRopilotCreditsEnabled?.() !== true) {
      this.setPendingRopilotCreditsDefaultMigration(null);
      return false;
    }
    const currentModel = this.normalizeSelectedModel(this.selectedModel);
    const defaultModel = this.getDefaultRopilotCreditsModel();
    if (currentModel !== this.normalizeSelectedModel(pending.sourceModel) && currentModel !== defaultModel) {
      this.setPendingRopilotCreditsDefaultMigration(null);
      return false;
    }
    this.applyRopilotCreditsDefaultModel({
      migrationSourceModel: pending.sourceModel,
      migrationReasoningLevel: pending.reasoningLevel,
      updateActiveChat: false
    });
    return true;
  }

  migrateLegacyRopilotCreditsChat(chat) {
    if (!chat) return null;
    const sourceModel = this.normalizeSelectedModel(chat.model || this.selectedModel);
    if (!modelCatalog.ROPILOT_CREDITS_LEGACY_DEFAULT_MODELS.has(sourceModel)) return null;

    const model = this.getDefaultRopilotCreditsModel();
    const provider = this.getProviderForModel(model) || 'codex';
    const rawReasoningLevel = this.getRawRopilotCreditsMigrationReasoningLevel(sourceModel, chat);
    const deferred = this.shouldDeferRopilotCreditsPremiumMigration(sourceModel, rawReasoningLevel);
    const reasoningLevel = this.getMigratedRopilotCreditsReasoningLevel(sourceModel, rawReasoningLevel, {
      hasRopilotPlusAccess: this.hasAuthoritativeManagedAiAccess === true && this.hasRopilotPlusAccess()
    });
    if (deferred) {
      this.setPendingRopilotCreditsDefaultMigration({ sourceModel, reasoningLevel: rawReasoningLevel });
    }

    this.invalidateCodexThreadForModelChange(chat, sourceModel, model);
    chat.provider = provider;
    chat.model = model;
    chat.reasoningLevel = deferred ? rawReasoningLevel : reasoningLevel;
    chat.fastMode = false;
    this.setReasoningLevelForModel(model, reasoningLevel, { useRopilotCredits: true });
    this.clearChatContextUsage?.(chat, { persist: false, rerender: false });
    return { sourceModel, model, provider, reasoningLevel, deferred };
  }

  applyRopilotCreditsDefaultModel(options = {}) {
    const previousModel = this.normalizeSelectedModel(options.migrationSourceModel || this.selectedModel);
    const shouldMigrateLegacyDefault = modelCatalog.ROPILOT_CREDITS_LEGACY_DEFAULT_MODELS.has(previousModel);
    // Keep the user's pick whenever Credits can run it. Entering Credits mode
    // used to land on the managed default, so every re-application of the
    // mode (a settings echo, an edge sync, a balance refresh) swapped the
    // composer, and the chat's thread, off the selected model. The mid-turn
    // guard alone was not enough: the composer still flipped to the default
    // 50-80s into a turn (2026-09-27). Only a legacy default or a model
    // Credits can't run is replaced.
    const canKeepPreviousModel = !shouldMigrateLegacyDefault
      && typeof this.coerceRopilotCreditsModel === 'function'
      && this.coerceRopilotCreditsModel(previousModel) === previousModel;
    if (canKeepPreviousModel) {
      const midTurn = !!(this.activeChat && this.isChatProcessing?.(this.activeChat.id));
      console.warn(`[CREDITS] Keeping ${previousModel}${midTurn ? ' (the active chat is mid-turn)' : ''}`);
      this.modelProvider = this.getProviderForModel(previousModel) || this.modelProvider;
      this.selectedModel = previousModel;
      if (!midTurn) {
        // Paid Fast still starts off when the mode is (re)entered between
        // turns; the user opts in again with the cost visible on the pill.
        this.codexFastMode = false;
        this.ropilotCreditsFastMode = false;
      }
      return previousModel;
    }
    const activeChat = options.updateActiveChat === true ? this.activeChat : null;
    const previousCreditsLevel = this.getRawRopilotCreditsMigrationReasoningLevel(
      previousModel,
      activeChat,
      options.migrationReasoningLevel
    );
    const deferred = shouldMigrateLegacyDefault
      && this.shouldDeferRopilotCreditsPremiumMigration(previousModel, previousCreditsLevel);
    const reasoningLevel = shouldMigrateLegacyDefault
      ? this.getMigratedRopilotCreditsReasoningLevel(previousModel, previousCreditsLevel, {
        hasRopilotPlusAccess: this.hasAuthoritativeManagedAiAccess === true && this.hasRopilotPlusAccess()
      })
      : 'low';
    if (deferred) {
      this.setPendingRopilotCreditsDefaultMigration({
        sourceModel: previousModel,
        reasoningLevel: previousCreditsLevel
      });
    } else if (this.pendingRopilotCreditsDefaultMigration?.sourceModel === previousModel) {
      this.setPendingRopilotCreditsDefaultMigration(null);
    }
    const model = this.getDefaultRopilotCreditsModel();
    const provider = this.getProviderForModel(model) || 'ropilot';
    this.modelProvider = provider;
    this.selectedModel = model;
    this.codexFastMode = false;
    // Entering Credits mode always starts with paid Fast off; the user must
    // opt in again with the cost visible on the pill.
    this.ropilotCreditsFastMode = false;
    this.setReasoningLevelForModel(model, reasoningLevel, { useRopilotCredits: true });

    if (activeChat) {
      const activeChatSourceModel = this.normalizeSelectedModel(activeChat.model || previousModel);
      this.invalidateCodexThreadForModelChange(activeChat, activeChatSourceModel, model);
      activeChat.provider = provider;
      activeChat.model = model;
      activeChat.reasoningLevel = deferred ? previousCreditsLevel : reasoningLevel;
      activeChat.fastMode = false;
      // Settings are re-applied during startup as well as actual model changes.
      // Keep the saved reading when the effective model has not changed.
      if (activeChatSourceModel !== model) {
        this.clearChatContextUsage?.(activeChat, { persist: false, rerender: false });
      }
      activeChat.updatedAt = Date.now();
      this.saveProjects?.();
    }

    return model;
  }

  shouldHideAnthropicManagedCreditModels() {
    if (this.isUseRopilotCreditsEnabled?.() !== true) return false;
    if (this.hasRopilotPlusAccess()) return false;
    // 2026-09-24: Anthropic models are open to every Credits account. The
    // server now always reports hide_anthropic_models=false; only an explicit
    // true from a (stale) payload hides them, never the pre-fetch default.
    return this.hideAnthropicManagedCreditModels === true;
  }

  getProviderForModel(modelValue) {
    return modelCatalog.getProviderForModel(modelValue);
  }

  coerceModelForProvider(provider, model) {
    const normalizedProvider = this.normalizeModelProvider(provider);
    const normalizedModel = this.normalizeSelectedModel(model);
    const providerModels = this.getModelsForProvider(normalizedProvider);
    if (providerModels.some((entry) => entry.value === normalizedModel)) {
      return normalizedModel;
    }
    return this.getDefaultModelForProvider(normalizedProvider);
  }

  // Discord Rich Presence is on by default; the Go server runs the actual
  // presence connection and we only relay the toggle + active model over the WS.
  isDiscordRpcEnabled() {
    const stored = localStorage.getItem('ropilot_discord_rpc_enabled');
    return stored === null ? true : stored === 'true';
  }

  setDiscordRpcEnabled(enabled) {
    localStorage.setItem('ropilot_discord_rpc_enabled', enabled ? 'true' : 'false');
    this.sendDiscordPresence();
  }

  // Push the current toggle + active model to the Go server (which owns the
  // Discord IPC connection). No-op if the websocket isn't open yet.
  sendDiscordPresence() {
    if (!this.wsManager) return;
    const enabled = this.isDiscordRpcEnabled();
    const provider = this.normalizeModelProvider(this.modelProvider);
    const model = this.selectedModel;
    this._lastDiscordPresenceKey = `${enabled}|${provider}|${model}`;
    this.wsManager.send({
      type: 'discord_presence',
      discord_rpc_enabled: enabled,
      provider,
      model,
      model_label: this.getComposerModelDisplayLabel(model),
    });
  }

  // Only send when the toggle or active model actually changed (called from the
  // frequently-invoked composer sync).
  maybeSendDiscordPresence() {
    const enabled = this.isDiscordRpcEnabled();
    const provider = this.normalizeModelProvider(this.modelProvider);
    const key = `${enabled}|${provider}|${this.selectedModel}`;
    if (key === this._lastDiscordPresenceKey) return;
    this.sendDiscordPresence();
  }

  isAddRopilotMCPServerEnabled() {
    const stored = localStorage.getItem('ropilot_add_mcp_server');
    return stored === null ? true : stored === 'true';
  }

  setAddRopilotMCPServerEnabled(enabled) {
    localStorage.setItem('ropilot_add_mcp_server', enabled ? 'true' : 'false');
    this.sendAddRopilotMCPServerPreference();
  }

  // A chat is prewarmable only while it is still empty. Prewarm starts a
  // brand-new codex thread; firing it for a chat that already owns a thread
  // (or any history) would leave the session holding a prewarmed thread the
  // first prompt could drive instead of resuming the real one.
  canPrewarmCodexSession(chat) {
    if (!chat || chat._storageState === 'stub') return false;
    if (chat.codexThreadId || chat.claudeSessionId || chat.hasHistory) return false;
    if (Array.isArray(chat.timeline) && chat.timeline.length > 0) return false;
    return true;
  }

  // Re-fire the prewarm for the active chat once it becomes possible. At boot
  // the persisted provider ('codex') is not in the store yet and the socket is
  // not open, so the chat-creation prewarm is a no-op and the user's first
  // prompt pays the full 5-7s codex bootstrap inside the turn. Called from the
  // model-selection subscription (provider settles), ws open (transport
  // settles) and composer focus (belt and braces); prewarmCodexSession dedupes
  // so only the first of those actually sends.
  maybePrewarmActiveCodexSession() {
    try {
      const chat = this.activeChat;
      if (!chat) return false;
      return this.prewarmCodexSession(chat);
    } catch (err) {
      console.warn('[PREWARM] Deferred prewarm check failed:', err);
      return false;
    }
  }

  // Prewarm the Go/codex session for a freshly opened chat so the
  // app-server + thread boot while the user is still typing. Purely an
  // optimization: the server treats it as best-effort and a prompt that
  // arrives mid-boot simply waits for it (never double-boots).
  prewarmCodexSession(chat) {
    try {
      if (!chat || !this.wsManager) return false;
      if (!this.canPrewarmCodexSession(chat)) return false;
      const provider = this.normalizeModelProvider(this.modelProvider);
      if (provider !== 'codex') return false;
      // Never prewarm on behalf of a chat pinned to another provider: the
      // request would carry this.selectedModel, which belongs to the global
      // provider, not to the chat.
      if (this.getChatProvider(chat, provider) !== 'codex') return false;
      const apiKey = this.getEffectiveApiKey?.() || '';
      if (!apiKey) return false;
      // One prewarm per chat per connection. The Go side also refuses a
      // second one (BeginCodexPrewarm / IsCodexThreadPrewarmed); this keeps
      // the repeated triggers from putting redundant traffic on the socket.
      if (!this.prewarmedChatIds) this.prewarmedChatIds = new Set();
      if (this.prewarmedChatIds.has(chat.id)) return false;
      const useRopilotCredits = this.isUseRopilotCreditsEnabled?.() === true;
      const sent = this.wsManager.send({
        type: 'prewarm',
        session_id: chat.id,
        provider,
        api_key: apiKey,
        model: this.selectedModel,
        message_index: 1,
        use_ropilot_credits: useRopilotCredits,
        bring_your_own_ai_subscription: this.isBringYourOwnSubscriptionEnabled?.() !== false,
        ropilot_credit_route_priority: useRopilotCredits
          ? (this.getRopilotCreditsRoutePriority?.() || 'economy')
          : undefined,
        codex_playtest_subagent_model: modelCatalog.resolveCodexPlaytestExecutionModel(this.getEffectiveCodexPlaytestSubagentModelPreference()),
        sourcecontrol_state: chat.sourcecontrolState || undefined,
      });
      // Only a message that actually left the socket counts as prewarmed;
      // a send blocked by a closed socket must stay retryable.
      if (sent) this.prewarmedChatIds.add(chat.id);
      return sent === true;
    } catch (err) {
      console.warn('[PREWARM] Failed to send prewarm message:', err);
      return false;
    }
  }

  sendAddRopilotMCPServerPreference() {
    if (!this.wsManager) return;
    this.wsManager.send({
      type: 'set_add_ropilot_mcp_server',
      add_ropilot_mcp_server: this.isAddRopilotMCPServerEnabled(),
      api_key: this.getEffectiveApiKey?.() || '',
    });
  }

  normalizeCodexPlaytestSubagentModelPreference(value) {
    const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!normalizedValue || normalizedValue === 'auto' || normalizedValue === 'default') {
      return modelCatalog.DEFAULT_CODEX_PLAYTEST_SUBAGENT_MODEL;
    }

    const model = this.normalizeSelectedModel(normalizedValue);
    return this.getProviderForModel(model) === 'codex'
      ? model
      : modelCatalog.DEFAULT_CODEX_PLAYTEST_SUBAGENT_MODEL;
  }

  getCodexPlaytestSubagentModelOptions() {
    const useRopilotCredits = this.isUseRopilotCreditsEnabled?.() === true;
    const isFreeAccount = !useRopilotCredits && this.isCodexFreeAccount();
    const models = this.getModelsForProvider('codex').filter((model) => (
      (!useRopilotCredits || modelCatalog.ROPILOT_CREDITS_MODEL_VALUES.has(model.value)) &&
      (useRopilotCredits || !modelCatalog.ROPILOT_ACTIONS_HIDDEN_MODEL_VALUES.has(model.value)) &&
      (!isFreeAccount || modelCatalog.CODEX_FREE_ALLOWED_MODELS.has(model.value))
    ));
    return [
      {
        value: modelCatalog.DEFAULT_CODEX_PLAYTEST_SUBAGENT_MODEL,
        label: 'Automatic'
      },
      ...models.map((model) => ({
        value: model.value,
        label: model.label
      }))
    ];
  }

  getEffectiveCodexPlaytestSubagentModelPreference() {
    const preference = this.normalizeCodexPlaytestSubagentModelPreference(this.codexPlaytestSubagentModel);
    if (!isModelAvailableOnPlatform(preference)) return modelCatalog.DEFAULT_CODEX_PLAYTEST_SUBAGENT_MODEL;
    if (preference === modelCatalog.DEFAULT_CODEX_PLAYTEST_SUBAGENT_MODEL) {
      return preference;
    }
    if (this.isUseRopilotCreditsEnabled?.() === true) {
      return modelCatalog.ROPILOT_CREDITS_MODEL_VALUES.has(preference)
        ? preference
        : modelCatalog.DEFAULT_CODEX_PLAYTEST_SUBAGENT_MODEL;
    }
    if (this.isCodexFreeAccount() && !modelCatalog.CODEX_FREE_ALLOWED_MODELS.has(preference)) {
      return modelCatalog.DEFAULT_CODEX_PLAYTEST_SUBAGENT_MODEL;
    }
    return preference;
  }

  setCodexPlaytestSubagentModelPreference(value) {
    this.codexPlaytestSubagentModel = this.normalizeCodexPlaytestSubagentModelPreference(value);
    localStorage.setItem('ropilot_codex_playtest_subagent_model', this.codexPlaytestSubagentModel);

    const select = document.getElementById('codex-playtest-subagent-select');
    if (select) {
      select.value = this.codexPlaytestSubagentModel;
    }
  }

  // =============================================================
  // COMPOSER FOOTER + DROPDOWNS - one-line delegators
  // Bodies live in js/composer/composer-footer.js and
  // js/composer/composer-dropdowns.js; wiring/, settings and setup-flow
  // keep calling these through the app object.
  // =============================================================

  getModelAuthMap() { return this.composerFooter.getModelAuthMap(); }

  refreshModelOptions() { return this.composerFooter.refreshModelOptions(); }

  refreshReasoningOptions() { return this.composerFooter.refreshReasoningOptions(); }

  getComposerModelDisplayLabel(modelValue = this.selectedModel) { return this.composerFooter.getComposerModelDisplayLabel(modelValue); }

  syncComposerFooterControls() { return this.composerFooter.syncComposerFooterControls(); }

  initComposerDropdowns() { return this.composerDropdowns.initComposerDropdowns(); }

  syncComposerDropdowns() { return this.composerDropdowns.syncComposerDropdowns(); }

  syncComposerDropdown(controlId) { return this.composerDropdowns.syncComposerDropdown(controlId); }

  closeComposerDropdowns(exceptControlId = null) { return this.composerDropdowns.closeComposerDropdowns(exceptControlId); }

  setUseRopilotCredits(enabled) { return this.composerDropdowns.setUseRopilotCredits(enabled); }

  activateRopilotCreditsMode(options = {}) { return this.composerDropdowns.activateRopilotCreditsMode(options); }

  applyDefaultAutoPlaytestForMode(useRopilotCredits = this.isUseRopilotCreditsEnabled(), provider = this.modelProvider) { return this.composerDropdowns.applyDefaultAutoPlaytestForMode(useRopilotCredits, provider); }

  forceAutoPlaytestOffForAiModeToggle() { return this.composerDropdowns.forceAutoPlaytestOffForAiModeToggle(); }

  setAutoPlaytest(nextValue) { return this.composerDropdowns.setAutoPlaytest(nextValue); }

  toggleAutoPlaytest() { return this.composerDropdowns.toggleAutoPlaytest(); }

  isBringYourOwnSubscriptionEnabled() {
    return !this.isUseRopilotCreditsEnabled();
  }

  isUseRopilotCreditsEnabled() {
    // free build: always bring-your-own (Claude Code / Codex login). Ropilot
    // Credits is the paid managed route; this keeps every call site off it.
    if (typeof this.useRopilotCredits === 'boolean') {
      return false;
    }
    return false;
  }

  hasExplicitAutoPlaytestPreference() {
    return this.hasAutoPlaytestPreference === true
      || localStorage.getItem('ropilot_auto_playtest_user_set') === 'true'
      || localStorage.getItem('ropilot_auto_playtest') === 'false';
  }

  getDefaultAutoPlaytestForMode(useRopilotCredits = this.isUseRopilotCreditsEnabled(), provider = this.modelProvider) {
    if (useRopilotCredits === true) return false;
    return this.normalizeModelProvider(provider) !== 'codex';
  }

  shouldPreserveLocalRopilotCreditsModeDowngrade(source = '') {
    const normalizedSource = String(source || '').trim().toLowerCase();
    if (!normalizedSource.startsWith('edge')) return false;
    if (this.isUseRopilotCreditsEnabled?.() !== true && this.useRopilotCredits !== true) return false;
    return Date.now() < (this.preserveRopilotCreditsModeUntilMs || 0);
  }

  // Records an explicit AI-mode choice (user toggle or deliberate mode switch)
  // so stale edge reads cannot override it while KV propagation settles.
  recordAiModeUserChoice(useCredits) {
    this.aiModeUserChoiceValue = !!useCredits;
    this.aiModeUserChoiceUntilMs = Date.now() + 120000;
    try {
      localStorage.setItem('ropilot_ai_mode_user_choice', JSON.stringify({
        value: this.aiModeUserChoiceValue,
        untilMs: this.aiModeUserChoiceUntilMs
      }));
    } catch { /* localStorage unavailable */ }
  }

  hydrateAiModeUserChoice() {
    if (typeof this.aiModeUserChoiceValue === 'boolean') return;
    try {
      const raw = localStorage.getItem('ropilot_ai_mode_user_choice');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.value === 'boolean' && Number.isFinite(parsed?.untilMs)) {
        this.aiModeUserChoiceValue = parsed.value;
        this.aiModeUserChoiceUntilMs = parsed.untilMs;
      }
    } catch { /* ignore malformed persisted choice */ }
  }

  // Symmetric counterpart to shouldPreserveLocalRopilotCreditsModeDowngrade:
  // an edge-sourced value that contradicts a recent explicit user choice is
  // treated as stale in BOTH directions (credits -> BYO and BYO -> credits).
  shouldPreserveLocalAiModeChoice(source = '', incomingValue) {
    const normalizedSource = String(source || '').trim().toLowerCase();
    if (!normalizedSource.startsWith('edge')) return false;
    this.hydrateAiModeUserChoice();
    if (typeof this.aiModeUserChoiceValue !== 'boolean') return false;
    if (typeof incomingValue !== 'boolean' || incomingValue === this.aiModeUserChoiceValue) return false;
    return Date.now() < (this.aiModeUserChoiceUntilMs || 0);
  }

  isLowQualityRopilotCreditsModel(modelValue) {
    return this.isUseRopilotCreditsEnabled?.() === true
      && modelCatalog.LOW_QUALITY_ROPILOT_CREDITS_MODEL_VALUES.has(this.normalizeSelectedModel(modelValue));
  }

  isRecommendedRopilotCreditsModel(modelValue) {
    return this.isUseRopilotCreditsEnabled?.() === true
      && modelCatalog.RECOMMENDED_ROPILOT_CREDITS_MODEL_VALUES.has(this.normalizeSelectedModel(modelValue));
  }

  getRopilotCreditsModelBadgeMeta(modelValue) {
    if (this.isRecommendedRopilotCreditsModel(modelValue)) {
      return { kind: 'recommended', label: 'Recommended' };
    }
    if (this.isLowQualityRopilotCreditsModel(modelValue)) {
      return { kind: 'low-quality', label: 'Low quality' };
    }
    return null;
  }

  // =============================================================
  // PER-CHAT STATE HELPERS
  // =============================================================

  // Check if the currently active chat is processing
  get isProcessing() {
    return this.activeChat ? this.store.isChatProcessing(this.activeChat.id) : false;
  }

  // Legacy setter - sets processing state for the active chat
  set isProcessing(value) {
    if (!this.activeChat) return;
    if (value) this.store.startProcessing(this.activeChat.id);
    else this.store.stopProcessing(this.activeChat.id);
  }

  // Get the processing chat ID (for backward compat - returns first processing chat)
  get processingChatId() {
    // Return the first processing chat ID, or null
    for (const chatId of this.store.get('processingChatIds')) {
      return chatId;
    }
    return null;
  }

  // Legacy setter for processingChatId
  set processingChatId(value) {
    // This is a no-op now - processing state is managed via StateStore
    // The setter exists to prevent errors from old code patterns
  }

  // Check if a specific chat is processing
  isChatProcessing(chatId) {
    return this.store.isChatProcessing(chatId);
  }

  // Check if ANY chat is currently processing
  isAnyChatProcessing() {
    return this.store.isAnyChatProcessing();
  }

  // Start processing for a specific chat
  startProcessingChat(chatId) {
    this.store.startProcessing(chatId);
    this.processingStartedAt.set(chatId, Date.now());
  }

  // Stop processing for a specific chat
  stopProcessingChat(chatId) {
    this.store.stopProcessing(chatId);
    this.processingStartedAt.delete(chatId);
  }

  isPlaytestActive() {
    return this.store.get('playtestActive');
  }

  setPlaytestState(active, panelId = null, chatId = null) {
    this.store.setPlaytestActive(active, panelId, chatId);
  }

  clearPlaytestState(reason = '') {
    if (reason) {
      console.log(`[PLAYTEST] Clearing state: ${reason}`);
    }
    this.setPlaytestState(false, null, null);
  }

  // Get pending message for the current active chat
  get pendingMessage() {
    return this.activeChat ? this.pendingMessages.get(this.activeChat.id) : null;
  }

  // Set pending message for the current active chat
  set pendingMessage(value) {
    if (!this.activeChat) return;
    if (value) {
      this.pendingMessages.set(this.activeChat.id, value);
    } else {
      this.pendingMessages.delete(this.activeChat.id);
    }
  }

  // Get pending message chat ID (for backward compat)
  get pendingMessageChatId() {
    // Return first chat with a pending message, or null
    for (const [chatId] of this.pendingMessages) {
      return chatId;
    }
    return null;
  }

  // Legacy setter for pendingMessageChatId - no-op
  set pendingMessageChatId(value) {
    // No-op - pending messages are managed via pendingMessages Map
  }

  // Rojo state compatibility getters - delegate to RojoManager
  get rojoRunning() { return this.rojoManager.running; }
  set rojoRunning(v) { this.rojoManager.running = v; }
  get rojoStarting() { return this.rojoManager.starting; }
  set rojoStarting(v) { this.rojoManager.starting = v; }
  get rojoLogs() { return this.rojoManager.logs; }
  set rojoLogs(v) { this.rojoManager.logs = v; }

  // Get pending message for a specific chat
  getPendingMessage(chatId) {
    return this.pendingMessages.get(chatId);
  }

  // Set pending message for a specific chat
  setPendingMessage(chatId, content) {
    if (content) {
      this.pendingMessages.set(chatId, content);
    } else {
      this.pendingMessages.delete(chatId);
    }
  }

  // =============================================================

  // Restore the persisted active chat after the first paint instead of during
  // init(): hydrating a large chat file JSON.parses the whole thing, and doing
  // that before paint blanks the window until the parse finishes.
  scheduleActiveChatRestore() {
    const run = () => {
      try {
        // Respect a chat the user opened before the deferred restore ran.
        if (this.activeChat) return;
        this.restoreActiveChat().catch((err) => {
          console.warn('[INIT] Deferred active-chat restore failed:', err);
        });
      } catch (err) {
        console.warn('[INIT] Deferred active-chat restore failed:', err);
      }
    };
    if (typeof requestAnimationFrame === 'function' && !document.hidden) {
      // rAF fires just before the next paint; the nested macrotask runs after
      // that paint, so the window is visible before hydration starts.
      requestAnimationFrame(() => setTimeout(run, 0));
    } else {
      setTimeout(run, 0);
    }
  }

  async restoreActiveChat() {
    const savedChatId = localStorage.getItem('ropilot_active_chat');
    if (!savedChatId) {
      return;  // No saved chat to restore
    }

    // Try to find the saved chat
    const chat = this.chatManager.findById(savedChatId);
    if (chat) {
      // Chat still exists, switch to it
      // Find the project that contains this chat
      let projectId = null;
      for (const project of this.projects) {
        if (project.chats.some(c => c.id === savedChatId)) {
          projectId = project.id;
          break;
        }
      }
      if (projectId) {
        await this.chatManager.setActive(savedChatId, projectId);
      }
    } else {
      // Chat was deleted, clear the saved ID
      localStorage.removeItem('ropilot_active_chat');
    }
  }

  // Setup Flow delegates
  checkClaudeInstallation(showProgress) { return this.setupFlow.checkClaudeInstallation(showProgress); }
  installPluginSetup() { this.setupFlow.installPlugin(); }
  confirmPluginAlreadyInstalledSetup() { this.setupFlow.confirmPluginAlreadyInstalled(); }
  saveSetupApiKey() { this.setupFlow.saveSetupApiKey(); }
  updateStatusIcon(itemId, status, resultText) { this.setupFlow.updateStatusIcon(itemId, status, resultText); }

  bindEvents() {
    bindAllEvents(this);
  }

  // Sidebar delegates (see src/js/ui/sidebar.js)
  updateChatFloatingComposerClearance() { this.sidebar.updateChatFloatingComposerClearance(); }
  navigateChat(direction) { this.sidebar.navigateChat(direction); }
  toggleSidebar() { this.sidebar.toggleSidebar(); }

  // Message Handler delegates
  handleMessage(msg) {
    if (this.ropilotHarness?.handleMessage(msg)) return;
    if (this.ropilotHarness?.handleFSResponse(msg)) return;
    this.messageHandler.handle(msg);
  }
  handleTextMessage(msg) { this.messageHandler.handleText(msg); }
  handleWorkingHint(msg) { this.messageHandler.handleWorkingHint(msg); }
  processNextQueuedMessage() { this.messageSender.processNextQueued(); }

  // Message Sender delegates
  sendMessage(options) { this.messageSender.send(options); }
  sendMessageContent(content, skipAddMessage, images, options) { this.messageSender.sendContent(content, skipAddMessage, images, options); }
  sendMessageContentToChat(content, targetChat, skipAddMessage, images, options) { this.messageSender.sendContentToChat(content, targetChat, skipAddMessage, images, options); }
  retryCodexPlanRestrictedFailureWithGpt56Terra() {
    const targetChat = this.activeChat;
    if (!targetChat || this.isChatProcessing(targetChat.id)) return false;

    const lastUserMessage = Array.isArray(targetChat.timeline)
      ? [...targetChat.timeline].reverse().find((item) => item?.type === 'user')
      : null;
    if (!lastUserMessage) return false;

    this.modelProvider = 'codex';
    this.selectedModel = modelCatalog.CODEX_FREE_DEFAULT_MODEL;
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
      modelSelect.value = modelCatalog.CODEX_FREE_DEFAULT_MODEL;
    }

    targetChat.provider = 'codex';
    targetChat.model = modelCatalog.CODEX_FREE_DEFAULT_MODEL;
    this.clearChatContextUsage(targetChat, { persist: false, rerender: false });
    targetChat.updatedAt = Date.now();
    this.saveProjects();
    this.refreshReasoningOptions();
    this.renderComposerContextUsage();
    this.renderProjectList();

    return this.messageSender.sendContentToChat(
      lastUserMessage.content || '',
      targetChat,
      true,
      Array.isArray(lastUserMessage.images) ? lastUserMessage.images : [],
      {
        executionProvider: 'codex',
        executionModel: modelCatalog.CODEX_FREE_DEFAULT_MODEL,
        displayContent: lastUserMessage.content || '',
        transportContent: lastUserMessage.content || '',
      }
    );
  }
  retryRopilotCreditsRouteFailure(routePriority = 'priority') {
    const targetChat = this.activeChat;
    if (!targetChat || this.isChatProcessing(targetChat.id)) return false;
    this.setRopilotCreditsRoutePriority('economy');
    return this.resendLastUserTurn(targetChat);
  }

  // Degeneration-guard recovery retry (agent_loop_degenerated): the Go server
  // already quarantined the poisoned Codex thread, so re-dispatching the last
  // user turn rebuilds clean context and usually just works. Unlike the route
  // failure retry, the chat's route priority is left untouched — this is not
  // a routing problem.
  retryDegenerationRecovery() {
    const targetChat = this.activeChat;
    if (!targetChat || this.isChatProcessing(targetChat.id)) return false;
    return this.resendLastUserTurn(targetChat);
  }

  // Re-dispatch the active chat's last user turn through the normal send
  // path ('Continue' when the thread already holds confirmed progress, the
  // original prompt otherwise). Shared by the route-failure retry and the
  // degeneration recovery retry.
  resendLastUserTurn(targetChat) {
    const timeline = Array.isArray(targetChat.timeline) ? targetChat.timeline : [];
    const lastUserMessageIndex = (() => {
      for (let i = timeline.length - 1; i >= 0; i--) {
        if (timeline[i]?.type === 'user') return i;
      }
      return -1;
    })();
    const lastUserMessage = lastUserMessageIndex >= 0
      ? timeline[lastUserMessageIndex]
      : null;
    if (!lastUserMessage) return false;

    const executionProvider = this.getChatProvider(targetChat, this.modelProvider);
    const executionModel = this.coerceModelForProvider(executionProvider, targetChat.model || this.selectedModel);

    const hasCodexThread = typeof targetChat.codexThreadId === 'string' && targetChat.codexThreadId.trim() !== '';
    const hasConfirmedHistory = targetChat.hasHistory === true;
    const hasAssistantOutputAfterLastUser = timeline
      .slice(lastUserMessageIndex + 1)
      .some((item) => (
        item?.type === 'assistant' ||
        item?.type === 'emit'
      ) && typeof item.content === 'string' && item.content.trim() !== '');
    const canContinueExistingThread = hasCodexThread && hasConfirmedHistory && hasAssistantOutputAfterLastUser;
    const originalPrompt = typeof lastUserMessage.content === 'string' ? lastUserMessage.content : '';
    const originalImages = Array.isArray(lastUserMessage.images) ? lastUserMessage.images : [];
    const retryPrompt = canContinueExistingThread ? 'Continue' : originalPrompt;
    if (!retryPrompt && originalImages.length === 0) return false;

    return this.messageSender.sendContentToChat(
      retryPrompt,
      targetChat,
      true,
      canContinueExistingThread ? [] : originalImages,
      {
        executionProvider,
        executionModel,
        displayContent: canContinueExistingThread ? 'Continue' : originalPrompt,
        transportContent: retryPrompt,
      }
    );
  }
  buildInferenceMessage(content, messageIndex) { return this.messageSender.buildMessage(content, messageIndex); }
  buildInferenceMessageForChat(content, messageIndex, targetChat) { return this.messageSender.buildMessageForChat(content, messageIndex, targetChat); }
  recordStudioDiagnostics(payload, targetChatId) {
    // Temporarily disabled while the live Studio diagnostics feature is postponed.
    return false;
  }

  submitAutoPromptToChat(content, targetChat, options = {}) {
    const normalizedContent = typeof content === 'string' ? content.trim() : '';
    if (!normalizedContent || !targetChat) return false;
    const displayContent = typeof options.displayContent === 'string' && options.displayContent.trim()
      ? options.displayContent.trim()
      : normalizedContent;

    // free build: same as the send path — a local provider does not need
    // a Ropilot key, because the hosted route it authenticates is gone.
    if (this.normalizeModelProvider(this.modelProvider) === 'ropilot' && !this.getEffectiveApiKey()) {
      this.showApiKeyReminder();
      return false;
    }

    if (this.isProcessing) {
      const chatId = targetChat.id;
      const executionProvider = options.executionProvider
        ? this.normalizeModelProvider(options.executionProvider)
        : this.normalizeModelProvider(targetChat.provider || this.modelProvider);
      const executionModel = this.coerceModelForProvider(
        executionProvider,
        options.executionModel || targetChat.model || this.getDefaultModelForProvider(executionProvider)
      );

      if (!this.messageQueues.has(chatId)) {
        this.messageQueues.set(chatId, []);
      }

      this.messageQueues.get(chatId).push({
        content: normalizedContent,
        displayContent,
        images: [],
        executionProvider,
        executionModel,
        userBubbleVariant: options.userBubbleVariant || '',
        queuedAt: Date.now(),
      });
      this.updateQueueIndicator();
      return true;
    }

    return this.messageSender.sendContentToChat(normalizedContent, targetChat, false, [], {
      ...options,
      displayContent,
    });
  }

  async selectProjectDir() {
    const dir = await electronAPI().selectDirectory();
    if (dir) {
      this.projectDir = dir;
      // Save to active project
      const project = this.getActiveProject();
      if (project) {
        project.workingDir = dir;
        this.saveProjects();
      }
      this.updateProjectDirDisplay();
    }
  }

  updateProjectDirDisplay() {
    const display = document.getElementById('project-dir-display');
    if (display) {
      if (this.projectDir) {
        // Show just the folder name for brevity, with full path on hover
        const folderName = this.projectDir.split(/[/\\]/).pop() || this.projectDir;
        display.textContent = folderName;
        display.title = this.projectDir;
        display.classList.remove('no-project');
      } else {
        display.textContent = 'No project selected';
        display.title = '';
        display.classList.add('no-project');
      }
    }
    // Update Rojo button visibility
    this.rojoManager.updateButton();
  }

  // Rojo Manager delegates
  toggleRojoServer() { this.rojoManager.toggle(); }
  updateRojoButton() { this.rojoManager.updateButton(); }
  showRojoSetupModal() { this.rojoManager.showSetupModal(); }
  closeRojoSetupModal() { this.rojoManager.closeSetupModal(); }
  showRojoError(message, details) { this.rojoManager.showError(message, details); }
  closeRojoErrorModal() { this.rojoManager.closeErrorModal(); }
  openDebugModal() { this.rojoManager.openDebugModal(); }
  closeDebugModal() { this.rojoManager.closeDebugModal(); }
  checkRojoStatus() { return this.rojoManager.checkStatus(); }
  showRojoContextMenu(x, y) { this.rojoManager.showContextMenu(x, y); }
  hideRojoContextMenu() { this.rojoManager.hideContextMenu(); }
  addRojoLog(type, message) { this.rojoManager.addLog(type, message); }
  updateRojoLogsDisplay() { this.rojoManager.updateLogsDisplay(); }
  showRojoLogsModal() { this.rojoManager.showLogsModal(); }
  closeRojoLogsModal() { this.rojoManager.closeLogsModal(); }
  clearRojoLogs() { this.rojoManager.clearLogs(); }

  // Action cost delegates
  getTurnActionCostMeta() {
    const useRopilotCredits = this.isUseRopilotCreditsEnabled?.() === true
      || this.useRopilotCredits === true;

    return {
      actionCostLabel: useRopilotCredits ? 'Ropilot Credits' : 'Ropilot Actions',
      actionCostBalanceType: useRopilotCredits ? 'managed_ai_credits' : 'ropilot_actions',
      useRopilotCredits,
    };
  }
  beginTurnActionCost(chatId) { this.statusManager.beginTurnActionCost(chatId, this.actionsRemaining, this.getTurnActionCostMeta()); }
  resetTurnActionCost(chatId) { this.statusManager.resetTurnActionCost(chatId); }
  ensureManagedTurnActionCostMeta(chatId) {
    this.statusManager.ensureTurnActionCostMeta(chatId, {
      actionCostLabel: 'Ropilot Credits',
      actionCostBalanceType: 'managed_ai_credits',
      useRopilotCredits: true,
    });
  }
  addTurnActionCost(chatId, deltaCost) { return this.statusManager.addTurnActionCost(chatId, deltaCost); }
  cancelTurnActionCost(chatId) { this.statusManager.cancelTurnActionCost(chatId); }
  completeTurnActionCost(chatId) { return this.statusManager.completeTurnActionCost(chatId); }
  getTurnActionCost(chatId) { return this.statusManager.getTurnActionCost(chatId); }
  getStoredTurnActionCostMeta(chatId) { return this.statusManager.getTurnActionCostMeta(chatId); }
  syncLatestTurnActionCost(chatId, durationMs = null) { this.messageRenderer.syncLatestTurnActionCost(chatId, durationMs); }

  // Drag and Drop delegates
  setupDragAndDrop() { this.dragDrop.setup(); }
  handleDroppedFolder(folderPath) { return this.dragDrop.handleDroppedFolder(folderPath); }

  // Persistence
  saveChats() {
    // Update the active chat's updatedAt timestamp
    if (this.activeChat) {
      this.activeChat.updatedAt = Date.now();
    }

    // Save happens through saveProjects() now
    this.saveProjects();
  }

  updateSendButton() { this.messageSender.updateButton(); }
  stopInference() { this.messageSender.stopInference(); }

  createRipple(event, button) {
    // Skip if button is disabled
    if (button.disabled) return;

    // Remove any existing ripple
    const existingRipple = button.querySelector('.ripple');
    if (existingRipple) {
      existingRipple.remove();
    }

    // Create ripple element
    const ripple = document.createElement('span');
    ripple.className = 'ripple';

    // Calculate ripple size and position
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (event.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (event.clientY - rect.top - size / 2) + 'px';

    button.appendChild(ripple);

    // Remove ripple after animation
    ripple.addEventListener('animationend', () => {
      ripple.remove();
    });
  }

  // =============================================================
  // DELEGATION METHODS - Forward to module managers for compatibility
  // =============================================================

  // Status Manager delegates
  showStatus(label, detail, command) { this.statusManager.show(label, detail, command); }
  hideStatus() { this.statusManager.hide(); }
  finalizeStatusInChat(chatId) { this.statusManager.finalizeInChat(chatId); }
  saveStatusToChat(chatId, label, detail, command) { this.statusManager.saveToChat(chatId, label, detail, command); }

  // Ensure a "Working" status is shown while processing (if no other status active)
  ensureWorkingStatus() {
    if (!this.isProcessing) return;

    const container = document.getElementById('messages');
    if (!container) return;

    // Check if there's already an active status
    const activeStatus = container.querySelector('.message-status.status-active');
    if (activeStatus) return; // Already have an active status

    // Show "Working" status
    this.showStatus('Working');
  }

  // Playtest Panel delegates
  showPlaytestPanel(targetChatId) { this.playtestPanel.show(targetChatId); }
  hidePlaytestPanel(finalMessage) { this.playtestPanel.hide(finalMessage); }
  setPlaytestResult(message, targetChatId = null) { this.playtestPanel.setResult(message, targetChatId); }
  updatePlaytestStatus(text) { this.playtestPanel.updateStatus(text); }
  addPlaytestScript(scriptId, runContext, code, targetChatId = null) { this.playtestPanel.addScript(scriptId, runContext, code, targetChatId); }
  addPlaytestScriptScreenshots(scriptId, screenshots, targetChatId = null) { this.playtestPanel.addScriptScreenshots(scriptId, screenshots, targetChatId); }
  togglePlaytestPanelById(panelId) { this.playtestPanel.toggleById(panelId); }
  createPlaytestPanelElement(data) { return this.playtestPanel.createElement(data); }

  // Diff Preview delegates
  showDiffPreview(data) { this.diffPreview.show(data); }
  showDiffPreviewToChat(data, targetChat, shouldUpdateUI) { this.diffPreview.showToChat(data, targetChat, shouldUpdateUI); }
  renderDiffMessage(diffData, startExpanded) { return this.diffPreview.renderMessage(diffData, startExpanded); }
  openScriptInStudio(scriptPath) { return this.diffPreview.openScriptInStudio(scriptPath); }
  restoreScriptViaEdge(scriptPath, originalContent) { return this.diffPreview.restoreScriptViaEdge(scriptPath, originalContent); }

  // Settings delegates
  openSettings() { this.settings.open(); }
  closeSettings() { this.settings.close(); }
  saveSettings() { this.settings.save(); }
  updatePluginStatus() { this.settings.updatePluginStatus(); }
  installPlugin() { this.settings.installPlugin(); }
  loadSettingsFromEdge() { this.settings.loadFromEdge(); }
  syncAutoPlaytestToEdge() { this.settings.syncAutoPlaytestToEdge(); }

  // WebSocket delegates
  connectWebSocket() { this.wsManager.connect(); }
  showConnectionErrorModal() { this.wsManager.showErrorModal(); }
  hideConnectionErrorModal() { this.wsManager.hideErrorModal(); }

  // Credits wall delegates (see src/js/credits/credits-wall.js)
  showNoActionsModal(options = {}) { this.creditsWall.showNoActionsModal(options); }
  hideNoActionsModal() { this.creditsWall.hideNoActionsModal(); }
  clearNoActionsUpgradeRecoveryState() { this.creditsWall.clearNoActionsUpgradeRecoveryState(); }
  getManagedCreditsRemaining() { return this.creditsWall.getManagedCreditsRemaining(); }
  updateNoActionsCard() { this.creditsWall.updateNoActionsCard(); }
  startNoActionsCreditRecoveryWatcher() { this.creditsWall.startNoActionsCreditRecoveryWatcher(); }
  handleAccountBalanceUpdated(previousBalance, nextBalance) { this.creditsWall.handleAccountBalanceUpdated(previousBalance, nextBalance); }
  handleManagedAiCreditsBalanceUpdated(previousBalance, nextBalance) { this.creditsWall.handleManagedAiCreditsBalanceUpdated(previousBalance, nextBalance); }
  createNoActionsCard() { return this.creditsWall.createNoActionsCard(); }
  postWallEvent(event, surface = 'no_actions') { this.creditsWall.postWallEvent(event, surface); }

  applyRopilotCreditsPurchaseDefaults() {
    this.activateRopilotCreditsMode({
      source: 'managed_credits_upgrade',
      syncToEdge: true,
    });
    const model = this.applyRopilotCreditsDefaultModel({ updateActiveChat: true });
    this.setRopilotCreditsRoutePriority('economy');
    this.setAutoPlaytest(false);

    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
      modelSelect.value = model;
    }
    this.refreshReasoningOptions();
    this.refreshModelOptions?.().catch((err) => {
      console.warn('Failed to refresh models after Ropilot Credits purchase defaults:', err);
    });
    this.syncComposerDropdown?.('composer-model-control');
    this.syncComposerFooterControls?.();
  }

  // Modal delegates (see src/js/ui/modals.js)
  showDeleteChatModal(chatId, projectId, chatTitle = '') { this.modals.showDeleteChatModal(chatId, projectId, chatTitle); }
  closeDeleteChatModal() { this.modals.closeDeleteChatModal(); }
  confirmDeleteChat() { this.modals.confirmDeleteChat(); }
  showDeleteProjectModal(projectId, projectName = '') { this.modals.showDeleteProjectModal(projectId, projectName); }
  closeDeleteProjectModal() { this.modals.closeDeleteProjectModal(); }
  updateDeleteProjectConfirmState() { this.modals.updateDeleteProjectConfirmState(); }
  confirmDeleteProject() { this.modals.confirmDeleteProject(); }
  showAppAlertModal(title, message, focusSelector = null, options = {}) { this.modals.showAppAlertModal(title, message, focusSelector, options); }
  closeAppAlertModal() { this.modals.closeAppAlertModal(); }

  // GPT-6 Astra launch announcement.
  async maybeShowAstraAnnouncement() {
    if (!isModelAvailableOnPlatform('gpt-6-astra')) return false;
    if (localStorage.getItem('ropilot_astra_announcement_shown') === 'true') return false;

    // Managed access uses the custom-only Credits route.
    const creditsMode = this.normalizeModelProvider(this.modelProvider) === 'ropilot'
      || this.isUseRopilotCreditsEnabled?.() === true;
    if (!creditsMode) {
      const authMap = await this.getModelAuthMap().catch(() => ({ codex: false }));
      if (!authMap?.codex || this.isCodexFreeAccount()) return false;
    }

    const modal = document.getElementById('astra-announcement-modal');
    if (!modal) return false;

    const access = document.getElementById('astra-announcement-access');
    if (access) access.textContent = creditsMode
      ? 'Available with Ropilot Credits. Astra’s token rates are 2.5× Sol’s.'
      : 'Use your connected OpenAI account. Astra access depends on your account’s rollout eligibility.';
    this.captureModalFocus('astra-announcement-modal');
    modal.classList.remove('hidden');

    document.getElementById('btn-astra-try')?.focus();

    // Focus trap: keep Tab cycling inside the dialog while it is open.
    if (!this._astraFocusTrapHandler) {
      this._astraFocusTrapHandler = (e) => {
        if (e.key !== 'Tab') return;
        const dialog = document.getElementById('astra-announcement-modal');
        if (!dialog || dialog.classList.contains('hidden')) return;
        const focusables = dialog.querySelectorAll('button:not([disabled])');
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      };
      document.addEventListener('keydown', this._astraFocusTrapHandler);
    }
    return true;
  }

  closeAstraAnnouncement() {
    const modal = document.getElementById('astra-announcement-modal');
    if (modal) modal.classList.add('hidden');
    if (this._astraFocusTrapHandler) {
      document.removeEventListener('keydown', this._astraFocusTrapHandler);
      this._astraFocusTrapHandler = null;
    }
    localStorage.setItem('ropilot_astra_announcement_shown', 'true');
    this.restoreFocusAfterModal('astra-announcement-modal');
  }

  selectAstraAndCloseAnnouncement() {
    const target = 'gpt-6-astra';
    if (!isModelAvailableOnPlatform(target)) return;
    const creditsMode = this.isUseRopilotCreditsEnabled?.() === true
      || this.normalizeModelProvider(this.modelProvider) === 'ropilot';
    this.modelProvider = 'codex';
    localStorage.setItem('ropilot_model_provider', 'codex');
    this.selectedModel = creditsMode
      ? this.coerceRopilotCreditsModel(target)
      : this.coerceModelForProvider('codex', target);
    localStorage.setItem('ropilot_selected_model', this.selectedModel);
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) modelSelect.value = this.selectedModel;
    this.setReasoningLevelForModel(target, 'medium');
    this.refreshReasoningOptions();
    this.syncComposerDropdown?.('composer-model-control');
    this.syncComposerFooterControls();
    this.closeAstraAnnouncement();
  }

  // Claude Fable 5.1 launch splash — BYOK (Actions) users with a connected
  // Claude subscription only. Managed-credits users and BYOK users without
  // Claude auth never see it (and it stays un-marked for them, so it can
  // still appear once they connect Claude later). Returns true when shown.
  async maybeShowFable51Announcement() {
    if (localStorage.getItem('ropilot_fable51_announcement_shown') === 'true') return false;

    // Gate 1: must be BYOK/Actions mode — never managed Ropilot Credits.
    const creditsMode = this.normalizeModelProvider(this.modelProvider) === 'ropilot'
      || this.isUseRopilotCreditsEnabled?.() === true;
    if (creditsMode) return false;

    // Gate 2: a Claude subscription must actually be connected.
    const authMap = await this.getModelAuthMap().catch(() => ({ claude: false }));
    if (!authMap?.claude) return false;

    const modal = document.getElementById('fable51-announcement-modal');
    if (!modal) return false;

    this.captureModalFocus('fable51-announcement-modal');
    modal.classList.remove('hidden');

    document.getElementById('btn-fable51-try')?.focus();

    // Focus trap: keep Tab cycling inside the dialog while it is open.
    if (!this._fable51FocusTrapHandler) {
      this._fable51FocusTrapHandler = (e) => {
        if (e.key !== 'Tab') return;
        const dialog = document.getElementById('fable51-announcement-modal');
        if (!dialog || dialog.classList.contains('hidden')) return;
        const focusables = dialog.querySelectorAll('button:not([disabled])');
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      };
      document.addEventListener('keydown', this._fable51FocusTrapHandler);
    }
    return true;
  }

  closeFable51Announcement() {
    const modal = document.getElementById('fable51-announcement-modal');
    if (modal) modal.classList.add('hidden');
    if (this._fable51FocusTrapHandler) {
      document.removeEventListener('keydown', this._fable51FocusTrapHandler);
      this._fable51FocusTrapHandler = null;
    }
    localStorage.setItem('ropilot_fable51_announcement_shown', 'true');
    this.restoreFocusAfterModal('fable51-announcement-modal');
  }

  selectFable51AndCloseAnnouncement() {
    const target = 'claude-fable-5-1[1m]';
    this.modelProvider = 'claude';
    localStorage.setItem('ropilot_model_provider', 'claude');
    this.selectedModel = this.coerceModelForProvider('claude', target);
    localStorage.setItem('ropilot_selected_model', this.selectedModel);
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) modelSelect.value = this.selectedModel;
    this.refreshReasoningOptions();
    this.syncComposerDropdown?.('composer-model-control');
    this.syncComposerFooterControls();
    this.closeFable51Announcement();
  }

  getLocalServerBaseUrl() {
    return wsUrlToHttpOrigin(this.wsUrl);
  }

  // Image preview delegates (see src/js/ui/image-preview.js)
  normalizeLocalPreviewSrc(src) { return this.imagePreview.normalizeLocalPreviewSrc(src); }
  openImagePreview(src, alt = 'Image preview') { this.imagePreview.openImagePreview(src, alt); }
  closeImagePreview() { this.imagePreview.closeImagePreview(); }

  captureModalFocus(modalId) { this.modals.captureModalFocus(modalId); }

  restoreFocusAfterModal(modalId, preferredSelector = null) { this.modals.restoreFocusAfterModal(modalId, preferredSelector); }

  // Project Manager delegates
  loadProjectsWithSync() { return this.projectManager.loadWithSync(); }
  mergeProjects(local, server) { return this.projectManager.mergeProjects(local, server); }
  mergeChats(local, server) { return this.projectManager.mergeChats(local, server); }
  saveProjects() { this.projectManager.save(); }
  saveProjectsToLocal() { this.projectManager.saveToLocal(); }
  syncProjectsToServer() { this.projectManager.syncToServer(); }
  getActiveProject() { return this.projectManager.getActive(); }
  findChatById(chatId) { return this.projectManager.findChatById(chatId); }
  createNewProject() { this.projectManager.create(); }
  showNewProjectModal() { this.projectManager.showNewModal(); }
  closeNewProjectModal() { this.projectManager.closeNewModal(); }
  createProjectWithoutDirectory() { this.projectManager.createWithoutDirectory(); }
  createProjectWithDirectory() { this.projectManager.createWithDirectory(); }
  deleteProject(projectId) { this.projectManager.delete(projectId); }
  renameProject(projectId, newName) { this.projectManager.rename(projectId, newName); }
  changeProjectDirectory(projectId) { return this.projectManager.changeDirectory(projectId); }
  removeProjectDirectory(projectId) { this.projectManager.removeDirectory(projectId); }
  getEffectiveApiKey() { return this.projectManager.getEffectiveApiKey(); }
  showFolderApiKeyModal(projectId) { this.projectManager.showFolderApiKeyModal(projectId); }
  closeFolderApiKeyModal() { this.projectManager.closeFolderApiKeyModal(); }
  saveFolderApiKey() { this.projectManager.saveFolderApiKey(); }
  clearProjectApiKey(projectId) { this.projectManager.clearApiKey(projectId); }
  toggleProjectExpanded(projectId) { this.projectManager.toggleExpanded(projectId); }
  setActiveProject(projectId) { this.projectManager.setActive(projectId); }
  startEditingProjectName(projectId) { this.projectManager.startEditingName(projectId); }
  finishEditingProjectName(projectId, newName) { this.projectManager.finishEditingName(projectId, newName); }
  renderProjectList() { this.projectManager.renderList(); }
  showProjectMenu(projectId, anchorEl, isDefaultProject) { this.projectManager.showMenu(projectId, anchorEl, isDefaultProject); }
  loadProjectsFromLocal() { return this.projectManager.loadFromLocal(); }

  schedulePendingSyncReplay() {
    if (this.pendingSyncReplayScheduled) return;
    this.pendingSyncReplayScheduled = true;

    const run = () => {
      try {
        this.chatSync.loadPendingState();
      } catch (err) {
        console.warn('[CHAT_SYNC] Failed to load pending startup state:', err);
      }
      void this.chatSync.flushPendingWork();
    };

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => run(), { timeout: 2000 });
      return;
    }

    window.setTimeout(run, 500);
  }

  // Chat Manager delegates
  createNewChat() { this.chatManager.create(); }
  createNewChatInProject(projectId) { this.chatManager.createInProject(projectId); }
  deleteChat(chatId, projectId) { this.chatManager.delete(chatId, projectId); }
  setActiveChat(chatId, projectId) { return this.chatManager.setActive(chatId, projectId); }
  startEditingChatName(chatId) { this.chatManager.startEditingName(chatId); }
  finishEditingChatName(chatId, newName) { this.chatManager.finishEditingName(chatId, newName); }
  renameChatById(chatId, newName) { this.chatManager.renameById(chatId, newName); }
  renderChatItem(chat, projectId) { return this.chatManager.renderItem(chat, projectId); }
  getSortedChats(chats) { return this.projectManager.getSortedChats(chats); }

  // Refresh activeChat to point to the canonical object from this.projects
  // Call this before any operation that reads from activeChat to avoid stale data
  refreshActiveChat() {
    if (!this.activeChat) return null;
    const freshChat = this.findChatById(this.activeChat.id);
    if (!freshChat) {
      // Chat was deleted - clear active chat
      console.warn('[REFRESH] Active chat no longer exists, clearing:', this.activeChat.id);
      this.activeChat = null;
      localStorage.removeItem('ropilot_active_chat');
      return null;
    }
    if (freshChat !== this.activeChat) {
      console.log('[REFRESH] Updating stale activeChat reference for', this.activeChat.id);
      this.activeChat = freshChat;
    }
    return this.activeChat;
  }

  // Validate all state references are consistent
  // Call this after any operation that might cause inconsistency
  validateState() {
    let needsRender = false;

    // 1. Validate activeChat exists
    if (this.activeChat) {
      const exists = this.findChatById(this.activeChat.id);
      if (!exists) {
        console.warn('[VALIDATE] Active chat missing, clearing');
        this.activeChat = null;
        localStorage.removeItem('ropilot_active_chat');
        needsRender = true;
      }
    }

    // 2. Validate processing chat IDs in store - remove any that no longer exist
    for (const chatId of new Set(this.store.get('processingChatIds'))) {
      if (!this.findChatById(chatId)) {
        console.warn('[VALIDATE] Processing chat missing, removing:', chatId);
        this.store.stopProcessing(chatId);
        this.processingStartedAt.delete(chatId);
        needsRender = true;
      }
    }

    // 3. Validate pendingMessages - remove any for deleted chats
    for (const chatId of this.pendingMessages.keys()) {
      if (!this.findChatById(chatId)) {
        console.warn('[VALIDATE] Pending message chat missing, removing:', chatId);
        this.pendingMessages.delete(chatId);
      }
    }

    // 4. Validate messageQueues - remove any for deleted chats
    for (const chatId of this.messageQueues.keys()) {
      if (!this.findChatById(chatId)) {
        console.warn('[VALIDATE] Message queue chat missing, removing:', chatId);
        this.messageQueues.delete(chatId);
      }
    }

    // 4b. Validate processing timestamps - remove any for deleted or non-processing chats
    for (const chatId of this.processingStartedAt.keys()) {
      if (!this.findChatById(chatId) || !this.store.isChatProcessing(chatId)) {
        this.processingStartedAt.delete(chatId);
      }
    }

    // 5. Validate clipboard image stash - remove any for deleted chats
    for (const chatId of this.composerImageStash.keys()) {
      if (!this.findChatById(chatId)) {
        console.warn('[VALIDATE] Composer image stash chat missing, removing:', chatId);
        this.composerImageStash.delete(chatId);
      }
    }

    if (needsRender) {
      this.renderProjectList();
      this.updateSendButton();
    }

    return needsRender;
  }

  // Message Renderer delegates
  renderMessages() { this.messageRenderer.render(); }
  ensureTimeline() { this.messageRenderer.ensureTimeline(); }
  ensureTimelineForChat(chat) { this.messageRenderer.ensureTimelineForChat(chat); }
  findTimelineIndexOfUserMessage(idx) { return this.messageRenderer.findTimelineIndexOfUserMessage(idx); }
  createStatusElement(data) { return this.messageRenderer.createStatusElement(data); }
  appendDiffElement(content, idx) { this.messageRenderer.appendDiffElement(content, idx); }
  addToTimeline(item, chat) { this.messageRenderer.addToTimeline(item, chat); }
  addUserMessage(content) { this.messageRenderer.addUserMessage(content); }
  addAssistantMessage(content) { this.messageRenderer.addAssistantMessage(content); }
  addEmitMessage(content) { this.messageRenderer.addEmitMessage(content); }
  addEmitMessageToChat(content, targetChat) { this.messageRenderer.addEmitMessageToChat(content, targetChat); }
  addAgentTextMessage(content, targetChat) { this.messageRenderer.addAgentTextMessage(content, targetChat); }
  addErrorMessage(error) { this.messageRenderer.addErrorMessage(error); }
  addErrorMessageToChat(error, targetChat, shouldUpdateUI, options) { this.messageRenderer.addErrorMessageToChat(error, targetChat, shouldUpdateUI, options); }
  appendMessageElement(role, content, type, idx, isStreaming) { this.messageRenderer.appendElement(role, content, type, idx, isStreaming); }
  beginCompactionInChat(chatId) { this.messageRenderer.beginCompactionInChat(chatId); }
  updateCompactionProgressInChat(chatId, usage) { return this.messageRenderer.updateCompactionProgressInChat(chatId, usage); }
  finalizeCompactionInChat(chatId) { return this.messageRenderer.finalizeCompactionInChat(chatId); }
  async returnToLoginScreen(provider = undefined, options = {}) {
    this.closeSettings();
    document.getElementById('chat-view')?.classList.add('hidden');
    document.getElementById('welcome-screen')?.classList.add('hidden');

    const activeProvider = this.activeChat
      ? this.getChatProvider(this.activeChat, this.modelProvider)
      : this.normalizeModelProvider(this.modelProvider);
    const targetProvider = this.normalizeModelProvider(provider || activeProvider);

    const shouldOpenProviderAuth = targetProvider === 'claude'
      && options.forceProviderAuth === true
      && this.isUseRopilotCreditsEnabled?.() !== true
      && this.useRopilotCredits !== true;
    if (shouldOpenProviderAuth) {
      this.setupFlow.showAuthOptions(targetProvider);
      if (options.openLogin === true) {
        setTimeout(() => this.setupFlow.openProviderLogin(targetProvider), 0);
      }
    } else {
      this.setupFlow.showInstallScreen(targetProvider);
    }

    const authStatus = document.getElementById('auth-recheck-status');
    if (authStatus) {
      if (shouldOpenProviderAuth) {
        authStatus.textContent = 'Opening Claude login...';
        authStatus.classList.remove('hidden');
      } else {
        authStatus.textContent = '';
        authStatus.classList.add('hidden');
      }
    }
  }

  async startCodexBrowserLoginFromChat() {
    const status = await this.setupFlow.getProviderStatus('codex');
    if (!status?.installed) {
      this.returnToLoginScreen('codex');
      return { success: false, error: 'Codex CLI is not installed yet.' };
    }
    this.setupFlow.setSelectedProvider('codex');
    return this.setupFlow.postGoSetup('/setup/start-codex-login?restart=1');
  }

  // Show a friendly reminder to set up API key
  showApiKeyReminder(customMessage) {
    const container = document.getElementById('messages');
    const existingReminder = container.querySelector('.api-key-reminder');
    if (existingReminder) {
      existingReminder.remove();
    }

    const message = customMessage || 'Please add your Studio API key in Settings to start chatting with Ropilot.';

    const div = document.createElement('div');
    div.className = 'message assistant api-key-reminder';
    div.innerHTML = `
      <div class="message-content" style="border-left: 3px solid var(--accent);">
        <p>${escapeHtml(message)}</p>
        <button class="btn btn-primary open-settings-btn" style="margin-top: 8px;">
          Open Settings
        </button>
      </div>
    `;

    div.querySelector('.open-settings-btn').addEventListener('click', () => {
      this.openSettings();
    });

    container.appendChild(div);
    scrollChatMessagesToEnd();
  }

  // Message Editor delegates
  requestEditMessage(messageIndex) { this.messageEditor.requestEdit(messageIndex); }
  closeEditConfirmModal() { this.messageEditor.closeConfirmModal(); }
  confirmRewind(withRevert) { return this.messageEditor.confirmRewind(withRevert); }
  enterEditMode(messageIndex) { this.messageEditor.enterEditMode(messageIndex); }
  cancelEdit(messageIndex) { this.messageEditor.cancel(messageIndex); }
  saveEdit(messageIndex, newContent) { this.messageEditor.save(messageIndex, newContent); }
  resendEditedMessage(content) { this.messageEditor.resend(content); }

  // Pending Message UI delegates
  updateQueueIndicator() { this.pendingMessageUI.updateIndicator(); }
  showPendingMessage() { this.pendingMessageUI.showPending(); }
  hidePendingMessage() { this.pendingMessageUI.hidePending(); }
  editPendingMessage() { this.pendingMessageUI.editPending(); }
  deletePendingMessage() { this.pendingMessageUI.deletePending(); }
  confirmPendingMessage() { this.pendingMessageUI.confirmPending(); }

  // Utility function delegates (keep in app for simplicity)
  escapeHtml(text) { return escapeHtml(text); }
  formatMessage(content) { return formatMessage(content); }
  autoResizeTextarea(textarea) {
    autoResizeTextarea(textarea);
    this.updateChatFloatingComposerClearance();
  }
  isTempPath(path) { return isTempPath(path); }
  highlightLua(code) { return highlightLua(code); }
  truncateMiddle(str, maxLen) { return truncateMiddle(str, maxLen); }
  getScriptIcon(scriptType) { return getScriptIcon(scriptType); }
  inferScriptTypeFromPath(path, fileName) { return inferScriptTypeFromPath(path, fileName); }
  getDiffDisplayName(data) { return this.diffPreview.getDisplayName(data); }

  getComposerImages(chatId = this.activeChat?.id) {
    if (!chatId) return [];
    return this.composerImageStash.get(chatId) || [];
  }

  setComposerImages(chatId, images) {
    if (!chatId) return;
    if (Array.isArray(images) && images.length > 0) {
      this.composerImageStash.set(chatId, images);
    } else {
      this.composerImageStash.delete(chatId);
    }
    if (this.activeChat?.id === chatId) {
      this.renderComposerImagePreview();
    }
  }

  clearComposerImages(chatId = this.activeChat?.id) {
    if (!chatId) return;
    this.composerImageStash.delete(chatId);
    if (this.activeChat?.id === chatId) {
      this.renderComposerImagePreview();
    }
  }

  removeComposerImage(index) {
    const activeChatId = this.activeChat?.id;
    if (!activeChatId) return;

    const current = this.getComposerImages(activeChatId);
    if (index < 0 || index >= current.length) return;

    const next = current.filter((_, i) => i !== index);
    this.setComposerImages(activeChatId, next);
    this.messageSender.updateButton();
  }

  openComposerFilePicker() {
    const picker = document.getElementById('input-image-file');
    if (!picker) return;
    picker.click();
  }

  async handleComposerFileSelection(event) {
    const input = event?.target;
    const files = Array.from(input?.files || []);
    if (files.length === 0) return;

    await this.addComposerImageFiles(files);

    // Allow selecting the same file again later.
    if (input) {
      input.value = '';
    }
  }

  async handleComposerPaste(event) {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItems = items.filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (imageItems.length === 0) return;

    const hasTextItem = items.some(item => item.kind === 'string' && item.type === 'text/plain');
    if (!hasTextItem) {
      event.preventDefault();
    }

    const files = imageItems
      .map(item => item.getAsFile())
      .filter(Boolean);

    await this.addComposerImageFiles(files);
  }

  async addComposerImageFiles(files) {
    const activeChatId = this.activeChat?.id;
    if (!activeChatId) return;

    const currentImages = this.getComposerImages(activeChatId);
    const openSlots = MAX_COMPOSER_IMAGES - currentImages.length;
    if (openSlots <= 0) {
      this.showAppAlertModal('Attachment Limit Reached', `You can attach up to ${MAX_COMPOSER_IMAGES} images per prompt.`);
      return;
    }

    const limitedFiles = files.slice(0, openSlots);
    if (limitedFiles.length === 0) return;

    const parsedImages = [];
    for (const file of limitedFiles) {
      try {
        const parsed = await this.readComposerImageFile(file);
        parsedImages.push(parsed);
      } catch (err) {
        const message = err?.message || 'Unable to read selected image.';
        this.showAppAlertModal('Image Attachment Failed', message);
        return;
      }
    }

    if (parsedImages.length === 0) return;

    this.setComposerImages(activeChatId, currentImages.concat(parsedImages));
    this.messageSender.updateButton();
  }

  readComposerImageFile(file) {
    return new Promise((resolve, reject) => {
      const mimeType = normalizeComposerImageMimeType(file.type);
      if (!mimeType || !mimeType.startsWith('image/')) {
        reject(new Error('Only image files are supported.'));
        return;
      }
      if (!SUPPORTED_COMPOSER_IMAGE_MIME_TYPES.has(mimeType)) {
        reject(new Error('Supported image formats are PNG, JPEG, WEBP, and GIF.'));
        return;
      }
      if (file.size > MAX_COMPOSER_IMAGE_BYTES) {
        reject(new Error(`Each image must be ${this.formatBytes(MAX_COMPOSER_IMAGE_BYTES)} or smaller.`));
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => {
        reject(new Error('Failed to read image from clipboard.'));
      };
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Clipboard image could not be processed.'));
          return;
        }

        const commaIndex = result.indexOf(',');
        if (commaIndex === -1) {
          reject(new Error('Clipboard image format is invalid.'));
          return;
        }

        const base64Data = result.slice(commaIndex + 1).trim();
        if (!base64Data) {
          reject(new Error('Clipboard image is empty.'));
          return;
        }

        resolve({
          mime_type: mimeType,
          data: base64Data,
        });
      };
      reader.readAsDataURL(file);
    });
  }

  renderComposerImagePreview() {
    const previewContainer = document.getElementById('composer-image-previews');
    if (!previewContainer) return;

    const images = this.getComposerImages();
    this.imagePreview.hideComposerImageHoverPreview();
    previewContainer.replaceChildren();

    if (images.length === 0) {
      previewContainer.classList.add('hidden');
      return;
    }

    images.forEach((image, index) => {
      const item = document.createElement('div');
      item.className = 'composer-image-preview-item';

      const img = document.createElement('img');
      img.src = `data:${image.mime_type};base64,${image.data}`;
      img.alt = `Attached image ${index + 1}`;
      img.loading = 'lazy';
      img.tabIndex = 0;

      const showHoverPreview = () => this.imagePreview.showComposerImageHoverPreview(item, img.src, img.alt);
      const hideHoverPreview = () => {
        if (this.activeComposerHoverAnchor === item) {
          this.imagePreview.hideComposerImageHoverPreview();
        }
      };

      item.addEventListener('mouseenter', showHoverPreview);
      item.addEventListener('mouseleave', hideHoverPreview);
      img.addEventListener('focus', showHoverPreview);
      img.addEventListener('blur', hideHoverPreview);
      img.addEventListener('click', () => {
        this.imagePreview.hideComposerImageHoverPreview();
        this.openImagePreview(img.src, img.alt);
      });
      img.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.imagePreview.hideComposerImageHoverPreview();
        this.openImagePreview(img.src, img.alt);
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'composer-image-remove';
      removeBtn.setAttribute('aria-label', `Remove image ${index + 1}`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        this.imagePreview.hideComposerImageHoverPreview();
        this.removeComposerImage(index);
      });

      item.appendChild(img);
      item.appendChild(removeBtn);
      previewContainer.appendChild(item);
    });

    previewContainer.classList.remove('hidden');
  }

  formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
  }

  // Prompt stash persistence
  stashPromptDraft(chatId, text) {
    if (!chatId || typeof text !== 'string') return;
    if (text.trim()) {
      if (this.promptStash.get(chatId) === text) return;
      this.promptStash.set(chatId, text);
    } else {
      if (!this.promptStash.delete(chatId)) return;
    }
    this.markPromptStashDirty();
  }

  isLikelyStalePromptDraft(chatId, text) {
    const draft = typeof text === 'string' ? text.trim() : '';
    if (!chatId || !draft) return false;

    const chat = this.chatManager.findById(chatId);
    if (!chat?.timeline) return false;

    const latestUserItem = [...chat.timeline].reverse().find((item) => item?.type === 'user');
    const latestUserText = typeof latestUserItem?.content === 'string' ? latestUserItem.content.trim() : '';
    if (!latestUserText) return false;

    return latestUserText === draft;
  }

  getRestorablePromptDraft(chatId) {
    const stashed = this.promptStash.get(chatId) || '';
    if (!stashed) return '';
    if (this.isLikelyStalePromptDraft(chatId, stashed)) {
      console.warn('[PROMPT_STASH] Removing stale prompt draft for chat:', chatId);
      this.promptStash.delete(chatId);
      this.markPromptStashDirty();
      return '';
    }
    return stashed;
  }

  loadPromptStash() {
    const storedData = localStorage.getItem('ropilot_prompt_stash');
    if (storedData) {
      try {
        const entries = JSON.parse(storedData);
        this.promptStash = new Map(entries);
      } catch (e) {
        console.error('Failed to load prompt stash:', e);
        this.promptStash = new Map();
      }
    }

    // Clean up stale entries for chats that no longer exist
    const allChatIds = new Set();
    for (const project of this.projects) {
      for (const chat of project.chats || []) {
        allChatIds.add(chat.id);
      }
    }

    // Remove stash entries for deleted chats or obviously stale drafts
    let hasChanges = false;
    for (const [chatId, text] of this.promptStash.entries()) {
      if (!allChatIds.has(chatId)) {
        this.promptStash.delete(chatId);
        hasChanges = true;
      } else if (this.isLikelyStalePromptDraft(chatId, text)) {
        console.warn('[PROMPT_STASH] Dropping stale persisted draft for chat:', chatId);
        this.promptStash.delete(chatId);
        hasChanges = true;
      }
    }

    // Save cleaned stash if we removed anything
    if (hasChanges) {
      this.savePromptStash();
    }
  }

  savePromptStash() {
    if (this.promptStashSaveTimer) {
      clearTimeout(this.promptStashSaveTimer);
      this.promptStashSaveTimer = null;
    }
    const entries = Array.from(this.promptStash.entries());
    try {
      localStorage.setItem('ropilot_prompt_stash', JSON.stringify(entries));
      this.promptStashDirtyFlag = false;
    } catch (e) {
      console.error('Failed to save prompt stash:', e);
    }
  }

  markPromptStashDirty() {
    // Coalesce without postponing: continuous typing still reaches disk.
    this.promptStashDirtyFlag = true;
    if (this.promptStashSaveTimer) return;
    this.promptStashSaveTimer = setTimeout(() => {
      this.promptStashSaveTimer = null;
      this.savePromptStash();
    }, 500);
  }
}

// Initialize app
function installGlobalRendererDiagnostics() {
  const report = (payload) => {
    try {
      electronAPI()?.logRendererDiagnostic?.(payload);
    } catch (_) {
      // Logging must never crash the renderer.
    }
  };

  window.addEventListener('error', (event) => {
    report({
      kind: 'error',
      message: event?.message || 'Unknown renderer error',
      source: event?.filename || '',
      line: event?.lineno || 0,
      column: event?.colno || 0,
      stack: event?.error?.stack || '',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    report({
      kind: 'unhandledrejection',
      message: reason?.message || String(reason || 'Unknown rejection'),
      source: '',
      line: 0,
      column: 0,
      stack: reason?.stack || '',
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  installGlobalRendererDiagnostics();
  window.app = new RopilotApp();
});
