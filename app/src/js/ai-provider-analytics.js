import { normalizeStreamDiagnostics } from './stream-diagnostics.js';

const LOG_PREFIX = '[AI_PROVIDER_ANALYTICS]';
const LONG_THINKING_STOP_THRESHOLD_MS = 120 * 1000;
const FIRST_OUTPUT_MAX_POST_ATTEMPTS = 3;
const ANALYTICS_RETRY_DELAY_MS = 100;

function normalizeLabel(value, fallback = 'unknown') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || fallback;
}

function truncateText(value, maxLength = 600) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

export class AiProviderAnalytics {
  static LONG_THINKING_STOP_THRESHOLD_MS = LONG_THINKING_STOP_THRESHOLD_MS;

  constructor(app, options = {}) {
    this.app = app;
    this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
    this.now = options.now || (() => Date.now());
    this.retryDelayMs = Number.isFinite(options.retryDelayMs)
      ? Math.max(0, options.retryDelayMs)
      : ANALYTICS_RETRY_DELAY_MS;
    this.sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.pendingByChatId = new Map();
    this.emittedKeys = new Set();
    // First user-visible AI output (status/tool activity, text, diff) per
    // chat's current turn. Used to scope long-thinking stop markers to
    // dead-air turns only.
    this.assistantOutputAtByChatId = new Map();
  }

  getEffectiveApiKey() {
    return typeof this.app.getEffectiveApiKey === 'function'
      ? this.app.getEffectiveApiKey()
      : this.app.apiKey;
  }

  getIngestEndpointUrl() {
    const siteUrl = typeof this.app.config?.siteUrl === 'string'
      ? this.app.config.siteUrl.trim().replace(/\/+$/, '')
      : '';
    if (siteUrl) {
      return `${siteUrl}/api/analytics/ai-provider-event`;
    }

    return 'https://ropilot.ai/api/analytics/ai-provider-event';
  }

  getChatContext(chatId, chatOverride = null) {
    const chat = chatOverride || this.app.chatManager?.findById?.(chatId) || this.app.activeChat || null;
    const provider = typeof this.app.getChatProvider === 'function'
      ? this.app.getChatProvider(chat, this.app.modelProvider)
      : (chat?.provider || this.app.modelProvider || 'unknown');
    const model = typeof this.app.normalizeSelectedModel === 'function'
      ? this.app.normalizeSelectedModel(chat?.model || this.app.selectedModel)
      : (chat?.model || this.app.selectedModel || 'unknown');
    const useRopilotCredits = this.app.isUseRopilotCreditsEnabled?.() === true;
    const routePriority = useRopilotCredits
      ? (this.app.getRopilotCreditsRoutePriority?.() || 'economy')
      : 'byo';

    return {
      chat,
      provider: normalizeLabel(provider),
      model: normalizeLabel(model),
      useRopilotCredits,
      routePriority: normalizeLabel(routePriority, useRopilotCredits ? 'economy' : 'byo'),
    };
  }

  getPendingTurn(chatId) {
    if (!chatId) return null;
    return this.pendingByChatId.get(chatId) || null;
  }

  buildEventId(chatId, turnId, eventType, source) {
    const safeChatId = normalizeLabel(chatId, 'unknown-chat');
    const safeTurnId = normalizeLabel(turnId, `${safeChatId}:${this.now()}`);
    const safeType = normalizeLabel(eventType, 'unknown');
    const safeSource = normalizeLabel(source, 'unknown');
    return `${safeTurnId}:${safeType}:${safeSource}`;
  }

  async postEvent(payload) {
    const apiKey = this.getEffectiveApiKey();
    if (!apiKey) {
      throw new Error('Missing API key');
    }

    const response = await this.fetchImpl(this.getIngestEndpointUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });

    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`AI provider analytics ingest failed (${response.status}): ${raw || 'empty response'}`);
    }
  }

  emit(payload, options = {}) {
    const eventId = payload.event_id || this.buildEventId(
      payload.chat_id,
      payload.turn_id,
      payload.event_type,
      payload.source
    );
    if (this.emittedKeys.has(eventId)) return false;
    this.emittedKeys.add(eventId);

    const retainedPayload = {
      ...payload,
      event_id: eventId,
    };
    const maxAttempts = Number.isFinite(options.maxAttempts)
      ? Math.max(1, Math.round(options.maxAttempts))
      : 1;

    void (async () => {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await this.postEvent(retainedPayload);
          options.onSuccess?.();
          return;
        } catch (err) {
          if (attempt < maxAttempts) {
            await this.sleep(this.retryDelayMs);
            continue;
          }
          this.emittedKeys.delete(eventId);
          options.onFailure?.(err);
          console.warn(`${LOG_PREFIX} Failed to post ${payload.event_type || 'event'}:`, err);
        }
      }
    })();
    return true;
  }

  startTurn({
    chatId,
    turnId,
    provider,
    model,
    routePriority,
    useRopilotCredits = false,
    projectDir = null,
    mode = null,
    startedAt = this.now(),
  }) {
    if (!chatId || !turnId) return false;

    const normalizedProjectDir = typeof projectDir === 'string' && projectDir.trim()
      ? projectDir.trim()
      : null;
    const existing = this.pendingByChatId.get(chatId);
    const isSameTurn = existing?.turnId === turnId;
    if (isSameTurn) return false;
    const normalizedStartedAt = Number(startedAt);
    const pending = {
      chatId,
      turnId,
      provider: normalizeLabel(provider),
      model: normalizeLabel(model),
      routePriority: normalizeLabel(routePriority, useRopilotCredits ? 'economy' : 'byo'),
      useRopilotCredits: useRopilotCredits === true,
      projectDir: normalizedProjectDir,
      mode: normalizeLabel(mode, normalizedProjectDir ? 'filesync' : 'sourcecontrol'),
      startedAt: Number.isFinite(normalizedStartedAt) && normalizedStartedAt > 0 ? normalizedStartedAt : this.now(),
      firstOutputEmitted: false,
      firstOutputInFlight: false,
      initialBareThinkingExcluded: false,
    };
    this.pendingByChatId.set(chatId, pending);
    this.assistantOutputAtByChatId.delete(chatId);

    this.emit({
      event_type: 'turn_started',
      source: 'desktop_turn_start',
      reason: 'turn_started',
      chat_id: chatId,
      turn_id: turnId,
      provider: pending.provider,
      model: pending.model,
      route_priority: pending.routePriority,
      use_ropilot_credits: pending.useRopilotCredits,
      project_dir: pending.projectDir,
      source_mode: pending.mode,
      duration_ms: 0,
      threshold_ms: 0,
    });
    return true;
  }

  /** The helper refunded the wasted tail of a loop-guard stop. */
  trackLoopWaiver({ chatId, chat, waivedCredits, wastedRequests, totalRequests, guard } = {}) {
    if (!chatId) return false;
    const pending = this.pendingByChatId.get(chatId);
    const turnId = pending?.turnId || `${chatId}:waiver:${Date.now()}`;
    return this.emit({
      event_type: 'loop_waiver',
      source: 'desktop_loop_waiver',
      reason: typeof guard === 'string' && guard ? guard : 'unknown',
      chat_id: chatId,
      turn_id: turnId,
      provider: pending?.provider || normalizeLabel(chat?.provider, 'codex'),
      model: pending?.model || normalizeLabel(chat?.model, 'unknown'),
      route_priority: pending?.routePriority || 'economy',
      use_ropilot_credits: true,
      project_dir: pending?.projectDir || '',
      source_mode: pending?.mode || 'sourcecontrol',
      duration_ms: Number.isFinite(waivedCredits) ? Math.round(waivedCredits * 1000) : 0,
      threshold_ms: Number.isFinite(wastedRequests) && Number.isFinite(totalRequests) ? wastedRequests * 1000 + totalRequests : 0,
    });
  }

  finishTurn(chatId) {
    if (!chatId) return;
    this.pendingByChatId.delete(chatId);
    this.assistantOutputAtByChatId.delete(chatId);
  }

  /** Mark that the AI emitted something user-visible this turn (status/tool
   * activity, assistant text, diff). Long-thinking stop markers are
   * suppressed once this fires: the marker means "user stopped after 120s of
   * dead air", not "user stopped a long but visibly working turn". */
  noteAssistantOutput(chatId) {
    if (!chatId) return;
    if (!this.assistantOutputAtByChatId.has(chatId)) {
      this.assistantOutputAtByChatId.set(chatId, this.now());
    }
  }

  noteWorkingHint(chatId, details = {}) {
    const label = normalizeLabel(details.label, 'Working');
    const detail = normalizeLabel(details.detail, '');
    const command = normalizeLabel(details.command, '');
    const isBareThinking = label.toLowerCase() === 'thinking' && !detail && !command;
    // Keep the existing long-thinking stop semantics: even the placeholder is
    // visible activity, but it is not the user-perceived first output metric.
    this.noteAssistantOutput(chatId);
    if (isBareThinking) {
      const pending = this.pendingByChatId.get(chatId);
      if (pending && !pending.initialBareThinkingExcluded) {
        pending.initialBareThinkingExcluded = true;
        return false;
      }
    }
    return this.noteFirstOutput(chatId, 'working_hint');
  }

  noteFirstOutput(chatId, reason) {
    if (!chatId) return false;
    const pending = this.pendingByChatId.get(chatId);
    if (!pending || pending.firstOutputEmitted || pending.firstOutputInFlight) return false;

    const durationMs = this.now() - pending.startedAt;
    if (!Number.isFinite(durationMs) || durationMs < 0) return false;

    const turnId = pending.turnId;
    pending.firstOutputInFlight = true;
    this.noteAssistantOutput(chatId);
    const accepted = this.emit({
      event_type: 'first_output',
      source: 'desktop_first_output',
      reason: normalizeLabel(reason, 'unknown'),
      chat_id: pending.chatId,
      turn_id: turnId,
      provider: pending.provider,
      model: pending.model,
      route_priority: pending.routePriority,
      use_ropilot_credits: pending.useRopilotCredits,
      project_dir: pending.projectDir,
      source_mode: pending.mode,
      duration_ms: Math.round(durationMs),
      threshold_ms: 0,
    }, {
      maxAttempts: FIRST_OUTPUT_MAX_POST_ATTEMPTS,
      onSuccess: () => {
        const current = this.pendingByChatId.get(chatId);
        if (current?.turnId !== turnId) return;
        current.firstOutputInFlight = false;
        current.firstOutputEmitted = true;
      },
      onFailure: () => {
        const current = this.pendingByChatId.get(chatId);
        if (current?.turnId === turnId) {
          current.firstOutputInFlight = false;
        }
      },
    });
    if (!accepted) {
      pending.firstOutputInFlight = false;
      return false;
    }
    return true;
  }

  trackProviderFail({
    chatId,
    chat = null,
    source,
    reason,
    errorText = '',
    diagnostics = null,
    durationMs = null,
    thresholdMs = 0,
  }) {
    if (!chatId) return;

    const pending = this.getPendingTurn(chatId);
    const context = this.getChatContext(chatId, chat || pending?.chat || null);
    const startedAt = Number(pending?.startedAt || this.app.processingStartedAt?.get?.(chatId) || 0);
    const measuredDurationMs = Number.isFinite(durationMs)
      ? durationMs
      : (startedAt > 0 ? this.now() - startedAt : null);
    const turnId = pending?.turnId || `${chatId}:${startedAt || this.now()}`;

    this.emit({
      event_type: 'provider_fail',
      source: normalizeLabel(source, 'unknown'),
      reason: normalizeLabel(reason, 'unknown'),
      chat_id: chatId,
      turn_id: turnId,
      provider: pending?.provider || context.provider,
      model: pending?.model || context.model,
      route_priority: pending?.routePriority || context.routePriority,
      use_ropilot_credits: pending?.useRopilotCredits ?? context.useRopilotCredits,
      project_dir: pending?.projectDir || null,
      source_mode: pending?.mode || null,
      duration_ms: Number.isFinite(measuredDurationMs) && measuredDurationMs >= 0
        ? Math.round(measuredDurationMs)
        : 0,
      threshold_ms: Number.isFinite(thresholdMs) && thresholdMs >= 0 ? Math.round(thresholdMs) : 0,
      error_text: truncateText(errorText),
      diagnostics: normalizeStreamDiagnostics(diagnostics),
    });
  }

  /** Emit a provider_fail marker when a codex stream-close error reached the
   * user (post any transparent retries). Source/reason feed the Reliability
   * page's Failure reasons table and the new Stream closed chart series. */
  trackStreamClosedError(chatId, errorText = '') {
    if (!chatId) return false;
    const text = String(errorText || '').toLowerCase();
    if (!text.includes('stream disconnected before completion') && !text.includes('stream closed before response.completed')) {
      return false;
    }
    this.trackProviderFail({
      chatId,
      source: 'stream_disconnect',
      reason: 'stream_closed_before_completion',
      errorText,
    });
    return true;
  }

  trackLongThinkingStop(chatId, options = {}) {
    const startedAt = Number(this.app.processingStartedAt?.get?.(chatId) || 0);
    if (!chatId || !startedAt) return false;

    // Only a dead-air stop counts: if the AI emitted anything user-visible
    // this turn, the user stopped a working turn, not a silent one.
    if (this.assistantOutputAtByChatId.has(chatId)) {
      return false;
    }

    const durationMs = this.now() - startedAt;
    const thresholdMs = Number.isFinite(options.thresholdMs)
      ? options.thresholdMs
      : LONG_THINKING_STOP_THRESHOLD_MS;
    if (!Number.isFinite(durationMs) || durationMs < thresholdMs) {
      return false;
    }

    this.trackProviderFail({
      chatId,
      source: 'user_stop_after_120s',
      reason: 'long_thinking_user_stopped',
      durationMs,
      thresholdMs,
    });
    return true;
  }
}
