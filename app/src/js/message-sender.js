// Message Sender - handles sending messages, queuing, stop inference, and send button state
import { isApiKeyValidated } from './api-validation.js';
import { scrollChatMessagesToEnd } from './utils.js';
import { findSlashCommand } from './slash-commands.js';
import { electronAPI } from './core/platform.js';
import { isModelAvailableOnPlatform } from './models/release-availability.js';
import { resolveCodexPlaytestExecutionModel, ROPILOT_CREDITS_FAST_MODE_SERVICE_TIER } from './models/model-catalog.js';

// Oversized pasted/attached images are downscaled before they are stored on
// the timeline (base64 there is re-serialized on every chat save) and sent
// over the socket. Images within both limits pass through byte-identical.
// Anthropic clamps every image to <=2000px in BOTH dimensions once a request
// carries more than 20 image blocks — and prior turns are resent, so
// tool_result screenshots from earlier in the thread count toward that. 2048
// was 48px over that ceiling, which meant our own downscaler emitted images
// the API then rejected. 1900 leaves rounding headroom under the clamp.
const IMAGE_MAX_DIMENSION = 1900;
const IMAGE_MAX_BASE64_CHARS = 1.5 * 1024 * 1024;
const IMAGE_JPEG_QUALITY = 0.85;
const MAX_RECONSTRUCTION_MESSAGES = 40;
// Mirrors the Go server's compactFallbackUserTurns. After a compact the
// server keeps 12 structured user turns, but buildContextPrompt prefers
// whichever source carries MORE prior user turns — so an unbounded 40-message
// flat list from the renderer wins and re-inflates the context on the very
// next turn, which is exactly what left users pinned at a full window.
// The assistant half is budgeted separately: a flat 12-message cap spends the
// whole budget on user turns and ships zero assistant context, which guts the
// fallback that rescues a failed thread resume.
const MAX_COMPACTED_RECONSTRUCTION_USERS = 12;
const MAX_COMPACTED_RECONSTRUCTION_MESSAGES = MAX_COMPACTED_RECONSTRUCTION_USERS * 2;

// Index of the first timeline item that is still part of the context after the
// most recent user-initiated compact that the server confirmed.
//
// Deliberately NOT derived from the timeline's own `compaction` items: those
// are also written for Codex's internal pre-sampling compaction (which trims
// nothing server-side) and are finalized even when a compact FAILS, so either
// would permanently truncate reconstruction for a compact that never happened.
function reconstructionStartIndex(chat) {
  const boundary = Number(chat?.codexCompactedTimelineIndex);
  if (!Number.isFinite(boundary) || boundary <= 0) return 0;
  const length = Array.isArray(chat?.timeline) ? chat.timeline.length : 0;
  // A rewind past the compact truncates the timeline and the boundary stops
  // describing anything real.
  if (boundary > length) return 0;
  return boundary;
}

function selectReconstructionMessages(
  candidates,
  maxMessages = MAX_RECONSTRUCTION_MESSAGES,
  maxUsers = maxMessages
) {
  const users = candidates.filter((candidate) => candidate.message.role === 'user');
  const assistants = candidates.filter((candidate) => candidate.message.role !== 'user' && !candidate.toolHint);
  // 2026-09-23 (GPT-6 loop regression): a reconstructed history must carry
  // completed turns. With users filling the whole budget, a long chat shipped
  // 40 "User:" rows and zero assistant answers, and GPT-6 Sol/Luna then idled
  // on no-op shell calls after answering. Reserve half the budget for
  // assistant answers whenever any exist.
  const assistantReserve = assistants.length > 0 ? Math.min(assistants.length, Math.floor(maxMessages / 2)) : 0;
  const keptUsers = users.slice(-Math.min(maxUsers, maxMessages - assistantReserve));
  const assistantBudget = maxMessages - keptUsers.length;
  const keptAssistants = assistantBudget > 0 ? assistants.slice(-assistantBudget) : [];
  const hintBudget = assistantBudget - keptAssistants.length;
  const keptHints = hintBudget > 0
    ? candidates.filter((candidate) => candidate.toolHint).slice(-hintBudget)
    : [];
  const selected = new Set([...keptUsers, ...keptAssistants, ...keptHints]);
  return candidates
    .filter((candidate) => selected.has(candidate))
    .map((candidate) => candidate.message);
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image decode failed'));
    img.src = dataUrl;
  });
}

async function downscaleImageIfNeeded(image) {
  const mimeType = typeof image?.mime_type === 'string' ? image.mime_type : '';
  const data = typeof image?.data === 'string' ? image.data : '';
  if (!data || !mimeType.startsWith('image/')) return image;
  // Canvas re-encode keeps only the first frame of an animated GIF.
  if (mimeType === 'image/gif') return image;

  try {
    const img = await loadImageFromDataUrl(`data:${mimeType};base64,${data}`);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return image;

    const maxDim = Math.max(width, height);
    if (maxDim <= IMAGE_MAX_DIMENSION && data.length <= IMAGE_MAX_BASE64_CHARS) {
      return image;
    }

    const scale = Math.min(1, IMAGE_MAX_DIMENSION / maxDim);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return image;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // PNG stays PNG to keep transparency; everything else re-encodes as JPEG.
    const outMime = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
    const dataUrl = outMime === 'image/png'
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
    const commaIndex = dataUrl.indexOf(',');
    const reencoded = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : '';
    // Re-encoding can inflate (e.g. photographic PNG) — keep the smaller bytes.
    if (!reencoded || reencoded.length >= data.length) return image;
    return { mime_type: outMime, data: reencoded };
  } catch (err) {
    // Never drop the user's image over a failed optimization pass.
    console.warn('[IMAGE] Downscale skipped:', err?.message || err);
    return image;
  }
}

export class MessageSender {
  constructor(app) {
    this.app = app;
    this.stopPendingChatIds = new Set();
    // Chats whose in-flight turn is a Codex /compact. The server's compact
    // "done" event carries only zero-valued session fields, which omitempty
    // strips from the wire, so older Go binaries give the renderer nothing to
    // key a context reset off. Tracking it here makes the renderer
    // self-authoritative and unsticks users without a binary update.
    this.pendingCodexCompactChatIds = new Set();
    // Correlates a steer acknowledgement with the exact prompt that produced
    // it. Entries are retained briefly because a rejection can race the
    // parent turn's terminal message.
    this.pendingSteerAttempts = new Map();
    this.steerRequestSequence = 0;
    this.managedRuntimeSetupPromise = null;
    this.managedRuntimeSetupChatIds = new Set();
    // Pending async image-normalize dispatch; later sends chain behind it so
    // dispatch order always matches send order.
    this.outgoingDispatchChain = null;
    this.bindManagedRuntimeInstallProgress();
  }

  warmRopilotHarnessForManagedTurn(useRopilotCredits) {
    if (useRopilotCredits !== true) return;
    this.app.ropilotHarness?.warmParser?.();
  }

  static STALE_PROCESSING_MS = 12 * 60 * 60 * 1000;
  static STALE_QUEUE_MS = 12 * 60 * 60 * 1000;
  static STALE_STEER_ATTEMPT_MS = 10 * 60 * 1000;
  static MAX_PENDING_STEER_ATTEMPTS = 200;

  createSteerRequestId() {
    this.steerRequestSequence += 1;
    return `steer-${this.steerRequestSequence}`;
  }

  createAnalyticsTurnId(chatId, messageIndex, submittedAt) {
    const timestamp = Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : Date.now();
    return `${chatId}:${messageIndex}:submit:${timestamp}`;
  }

  getSteerAttemptKey(chatId, requestId) {
    const normalizedChatId = typeof chatId === 'string' ? chatId.trim() : '';
    const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
    if (!normalizedChatId || !normalizedRequestId) return '';
    return `${normalizedChatId}:${normalizedRequestId}`;
  }

  prunePendingSteerAttempts(now = Date.now()) {
    for (const [key, attempt] of this.pendingSteerAttempts) {
      if ((now - Number(attempt?.createdAt || 0)) >= MessageSender.STALE_STEER_ATTEMPT_MS) {
        this.pendingSteerAttempts.delete(key);
      }
    }
    while (this.pendingSteerAttempts.size > MessageSender.MAX_PENDING_STEER_ATTEMPTS) {
      const oldestKey = this.pendingSteerAttempts.keys().next().value;
      if (!oldestKey) break;
      this.pendingSteerAttempts.delete(oldestKey);
    }
  }

  findPendingSteerAttempt(chatId, requestId, clientSentAtMs) {
    this.prunePendingSteerAttempts();
    const key = this.getSteerAttemptKey(chatId, requestId);
    if (key) {
      const attempt = this.pendingSteerAttempts.get(key);
      return attempt ? { key, attempt } : null;
    }

    // Transitional compatibility for a server that echoes the old timestamp
    // but not request_id. A timestamp is usable only when it identifies
    // exactly one attempt; otherwise replaying either prompt would be unsafe.
    const normalizedSentAt = typeof clientSentAtMs === 'string'
      ? clientSentAtMs.trim()
      : (Number.isFinite(clientSentAtMs) ? String(clientSentAtMs) : '');
    if (!normalizedSentAt) return null;
    let timestampMatch = null;
    for (const [candidateKey, attempt] of this.pendingSteerAttempts) {
      if (attempt?.chatId !== chatId || String(attempt.clientSentAtMs) !== normalizedSentAt) continue;
      if (timestampMatch) return null;
      timestampMatch = { key: candidateKey, attempt };
    }
    return timestampMatch;
  }

  handleSteerAccepted(msg = {}) {
    const match = this.findPendingSteerAttempt(msg.session_id, msg.request_id, msg.client_sent_at_ms);
    if (!match) return false;
    this.pendingSteerAttempts.delete(match.key);
    return true;
  }

  handleSteerRejected(msg = {}) {
    const chatId = typeof msg.session_id === 'string' ? msg.session_id.trim() : '';
    const match = this.findPendingSteerAttempt(chatId, msg.request_id, msg.client_sent_at_ms);
    if (!match) return { handled: false, queued: false, duplicate: false };

    const { attempt } = match;
    if (attempt.state === 'queued' || attempt.state === 'rejected') {
      return {
        handled: true,
        queued: attempt.state === 'queued',
        duplicate: true,
      };
    }

    const shouldQueue = msg.queue_for_next_turn === true;
    if (!shouldQueue) {
      attempt.state = 'rejected';
      return { handled: true, queued: false, duplicate: false };
    }

    const queued = this.queueMessageForChat(chatId, {
      content: attempt.content,
      images: attempt.images,
      executionProvider: attempt.executionProvider,
      executionModel: attempt.executionModel,
      skipAddMessage: true,
      sourceRequestId: attempt.requestId,
      sourceClientSentAtMs: attempt.clientSentAtMs,
    });
    attempt.state = queued ? 'queued' : 'rejected';

    // A terminal message can win the race with the rejection acknowledgement.
    // In that case there will be no later lifecycle event to release the queue.
    if (queued && !this.isActiveTurnInProgress(chatId, 'steer_rejected')) {
      this.processNextQueued(chatId);
    }
    return { handled: true, queued, duplicate: false };
  }

  pruneStaleQueuedMessages(chatId, now = Date.now()) {
    const queue = this.app.messageQueues.get(chatId);
    if (!Array.isArray(queue) || queue.length === 0) return 0;

    const freshItems = queue.filter((item) => {
      const queuedAt = typeof item === 'string' ? 0 : Number(item?.queuedAt || 0);
      if (!queuedAt) return true;
      return (now - queuedAt) < MessageSender.STALE_QUEUE_MS;
    });

    const removedCount = queue.length - freshItems.length;
    if (removedCount <= 0) return 0;

    if (freshItems.length > 0) {
      this.app.messageQueues.set(chatId, freshItems);
    } else {
      this.app.messageQueues.delete(chatId);
    }

    console.warn(`[QUEUE] Dropped ${removedCount} stale queued message(s) for chat ${chatId}`);
    return removedCount;
  }

  clearStaleProcessingIfNeeded(chatId, reason = 'send_attempt') {
    if (!chatId || !this.app.isChatProcessing(chatId)) return false;

    const startedAt = Number(this.app.processingStartedAt.get(chatId) || 0);
    if (!startedAt) return false;

    const ageMs = Date.now() - startedAt;
    if (ageMs < MessageSender.STALE_PROCESSING_MS) return false;

    console.warn(`[QUEUE] Clearing stale processing for chat ${chatId} after ${Math.round(ageMs / 60000)} minute(s) (${reason})`);
    this.app.stopProcessingChat(chatId);
    this.app.messageQueues.delete(chatId);
    this.app.setPendingMessage(chatId, null);
    this.app.updateQueueIndicator();
    if (this.app.activeChat?.id === chatId) {
      this.app.hidePendingMessage();
      this.app.hideStatus();
      this.updateButton();
      this.app.renderProjectList();
    }
    return true;
  }

  hasFreshProcessingTimestamp(chatId) {
    if (!chatId) return false;
    const startedAt = Number(this.app.processingStartedAt?.get?.(chatId) || 0);
    if (!startedAt) return false;

    const ageMs = Date.now() - startedAt;
    if (ageMs < MessageSender.STALE_PROCESSING_MS) return true;

    this.app.processingStartedAt?.delete?.(chatId);
    return false;
  }

  isActiveTurnInProgress(chatId, reason = 'active_turn_check') {
    if (!chatId) return false;
    if (this.clearStaleProcessingIfNeeded(chatId, reason)) return false;
    return this.app.isChatProcessing(chatId)
      || this.stopPendingChatIds.has(chatId)
      || this.hasFreshProcessingTimestamp(chatId);
  }

  clearPromptDraft(chatId) {
    if (!chatId) return;
    if (!this.app.promptStash.has(chatId)) return;
    this.app.promptStash.delete(chatId);
    this.app.markPromptStashDirty();
  }

  bindManagedRuntimeInstallProgress() {
    if (typeof window === 'undefined') return;
    const api = electronAPI();
    if (!api?.onCodexInstallProgress) return;
    api.onCodexInstallProgress((progress) => {
      if (this.managedRuntimeSetupChatIds.size === 0) return;
      const detail = this.formatManagedRuntimeSetupProgress(progress);
      for (const chatId of this.managedRuntimeSetupChatIds) {
        this.showManagedRuntimeSetupStatus(chatId, detail);
      }
    });
  }

  formatManagedRuntimeSetupProgress(progress) {
    const percent = Number(progress?.percent);
    if (Number.isFinite(percent)) {
      const rounded = Math.max(0, Math.min(100, Math.round(percent)));
      return `${rounded}%`;
    }
    const status = typeof progress?.status === 'string' ? progress.status : '';
    if (status === 'retrying') return 'retrying...';
    if (status === 'verifying' || status === 'validating') return 'verifying...';
    if (status === 'complete') return '100%';
    return '10%';
  }

  showManagedRuntimeSetupStatus(chatId, detail = '10%') {
    if (!chatId) return;
    if (this.app.activeChat?.id === chatId) {
      if (this.hasActiveManagedRuntimeSetupStatus()) {
        this.updateManagedRuntimeSetupTimeline(chatId, detail);
      } else {
        this.app.showStatus?.('Setting up Ropilot runtime...', detail);
      }
      this.decorateManagedRuntimeSetupStatus(detail);
    } else {
      this.app.saveStatusToChat?.(chatId, 'Setting up Ropilot runtime...', detail);
    }
  }

  hasActiveManagedRuntimeSetupStatus() {
    return [...document.querySelectorAll('.message-status.status-active')]
      .some((el) => el?.dataset?.label === 'Setting up Ropilot runtime...');
  }

  updateManagedRuntimeSetupTimeline(chatId, detail = '10%') {
    const chat = this.app.chatManager?.findById?.(chatId)
      || this.app.projects?.flatMap(project => project.chats || []).find(chat => chat.id === chatId);
    if (!chat?.timeline) return;
    const label = 'Setting up Ropilot runtime...';
    for (let i = chat.timeline.length - 1; i >= 0; i -= 1) {
      const item = chat.timeline[i];
      if (item?.type === 'status' && !item.finalized && typeof item.text === 'string' && item.text.startsWith(label)) {
        item.text = `${label} ${detail}`;
        break;
      }
    }
  }

  parseManagedRuntimeSetupPercent(detail) {
    const match = String(detail || '').match(/(\d+(?:\.\d+)?)\s*%/);
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, value));
  }

  decorateManagedRuntimeSetupStatus(detail = '10%') {
    const label = 'Setting up Ropilot runtime...';
    const statusEl = [...document.querySelectorAll('.message-status.status-active')]
      .reverse()
      .find((el) => el?.dataset?.label === label);
    if (!statusEl) return;

    const percent = this.parseManagedRuntimeSetupPercent(detail);
    const hasPercent = percent !== null;
    const percentLabel = hasPercent ? `${Math.round(percent)}%` : String(detail || 'Working');
    const progressBar = document.createElement('div');
    progressBar.className = hasPercent ? 'compaction-progress-bar' : 'compaction-progress-bar is-indeterminate';
    progressBar.setAttribute('role', 'progressbar');
    progressBar.setAttribute('aria-label', 'Ropilot runtime setup progress');
    progressBar.setAttribute('aria-valuemin', '0');
    progressBar.setAttribute('aria-valuemax', '100');
    if (hasPercent) {
      progressBar.setAttribute('aria-valuenow', String(Math.round(percent)));
    }

    const progressFill = document.createElement('div');
    progressFill.className = 'compaction-progress-fill';
    if (hasPercent) {
      progressFill.style.width = `${percent}%`;
    }
    progressBar.appendChild(progressFill);

    const content = document.createElement('div');
    content.className = 'message-content compaction-content';

    const row = document.createElement('div');
    row.className = 'compaction-row';

    const spinner = document.createElement('div');
    spinner.className = 'status-spinner';
    const title = document.createElement('span');
    title.className = 'status-text compaction-title';
    title.textContent = label;
    const percentNode = document.createElement('span');
    percentNode.className = 'compaction-percent';
    percentNode.textContent = percentLabel;

    row.appendChild(spinner);
    row.appendChild(title);
    row.appendChild(percentNode);

    const detailNode = document.createElement('div');
    detailNode.className = 'compaction-detail';
    detailNode.textContent = 'Installing the local runtime. This only needs to happen once.';

    content.appendChild(row);
    content.appendChild(progressBar);
    content.appendChild(detailNode);

    statusEl.classList.add('message-compaction', 'ropilot-runtime-setup');
    statusEl.replaceChildren(content);
  }

  clearManagedRuntimeSetupStatus(chatId) {
    if (!chatId) return;
    const label = 'Setting up Ropilot runtime...';
    const chat = this.app.chatManager?.findById?.(chatId)
      || this.app.projects?.flatMap(project => project.chats || []).find(chat => chat.id === chatId);

    if (chat?.timeline) {
      for (let i = chat.timeline.length - 1; i >= 0; i -= 1) {
        const item = chat.timeline[i];
        if (item?.type === 'status' && !item.finalized && typeof item.text === 'string' && item.text.startsWith(label)) {
          chat.timeline.splice(i, 1);
          break;
        }
      }
    }

    if (this.app.activeChat?.id === chatId) {
      const activeStatus = document.querySelector('.message-status.status-active');
      if (activeStatus?.dataset?.label === label) {
        activeStatus.remove();
      }
    }
  }

  getCodexBackgroundInstallPromise() {
    const promise = this.app.setupFlow?.getCodexCliBackgroundInstallPromise?.();
    return promise && typeof promise.then === 'function' ? promise : null;
  }

  async ensureManagedCodexRuntimeReady(targetChat, isOnTargetChat) {
    if (this.app.isUseRopilotCreditsEnabled?.() !== true) return true;
    if (!targetChat?.id) return true;

    const api = electronAPI();
    if (!api?.getCodexCliStatus || !api?.installCodexCli) {
      throw new Error('Ropilot runtime setup is unavailable. Please restart Ropilot Studio and try again.');
    }

    let status = null;
    try {
      status = await api.getCodexCliStatus();
    } catch (err) {
      console.warn('[RUNTIME] Failed to check Ropilot runtime status; attempting setup:', err);
    }
    if (status?.installed) return true;

    this.managedRuntimeSetupChatIds.add(targetChat.id);
    this.showManagedRuntimeSetupStatus(targetChat.id, '10%');

    if (!this.managedRuntimeSetupPromise) {
      const backgroundInstallPromise = this.getCodexBackgroundInstallPromise();
      this.managedRuntimeSetupPromise = (async () => {
        const installCodex = this.app.setupFlow?.installCodexCliViaShellOrGo
          ? () => this.app.setupFlow.installCodexCliViaShellOrGo()
          : () => api.installCodexCli();
        const result = backgroundInstallPromise
          ? await backgroundInstallPromise
          : await installCodex();
        if (!result?.success) {
          throw new Error(result?.error || 'Ropilot runtime setup failed.');
        }
        return result;
      })().finally(() => {
        this.managedRuntimeSetupPromise = null;
      });
    }

    await this.managedRuntimeSetupPromise;

    try {
      status = await api.getCodexCliStatus();
    } catch (err) {
      console.warn('[RUNTIME] Failed to verify Ropilot runtime after setup:', err);
    } finally {
      this.managedRuntimeSetupChatIds.delete(targetChat.id);
    }

    if (!status?.installed) {
      throw new Error('Ropilot runtime setup did not finish. Please try again.');
    }

    this.clearManagedRuntimeSetupStatus(targetChat.id);
    if (isOnTargetChat) {
      this.app.showStatus?.('Thinking');
    }
    return true;
  }

  handleManagedRuntimeSetupFailure(err, targetChat, isOnTargetChat) {
    const message = err?.message || 'Ropilot runtime setup failed. Please try again.';
    if (targetChat?.id) {
      this.managedRuntimeSetupChatIds.delete(targetChat.id);
      this.app.aiProviderAnalytics?.noteFirstOutput?.(targetChat.id, 'error');
      this.app.aiProviderAnalytics?.finishTurn?.(targetChat.id);
      this.app.cancelTurnActionCost?.(targetChat.id);
      this.app.stopProcessingChat?.(targetChat.id);
      this.clearManagedRuntimeSetupStatus(targetChat.id);
    }

    if (isOnTargetChat) {
      this.app.addErrorMessage?.(message);
      this.app.hideStatus?.();
      this.updateButton();
    } else if (targetChat) {
      this.app.addErrorMessageToChat?.(message, targetChat, false);
      this.app.finalizeStatusInChat?.(targetChat.id);
    }

    this.app.renderProjectList?.();
  }

  send(options = {}) {
    const fromButtonClick = typeof options === 'boolean'
      ? options
      : !!options?.fromButtonClick;
    const sendMode = typeof options === 'object' && options?.mode === 'queue'
      ? 'queue'
      : (typeof options === 'object' && options?.mode === 'steer' ? 'steer' : 'send');
    const input = document.getElementById('input-message');
    const btn = document.getElementById('btn-send');
    const content = input.value.trim();
    const attachedImages = this.app.getComposerImages();
    const hasText = content.length > 0;
    const hasImages = attachedImages.length > 0;
    const slashCommand = (hasText && !hasImages) ? findSlashCommand(content) : null;
    const requestContent = slashCommand ? slashCommand.command : content;
    const activeChatId = this.app.activeChat?.id || null;
    const submittedAt = Date.now();

    // If button is in stop-mode and clicked, always stop (regardless of text)
    if (fromButtonClick && btn.classList.contains('stop-mode')) {
      this.stopInference();
      return;
    }

    // Empty Enter while processing is a no-op — a double-tapped Enter must not
    // send and then immediately stop the turn. Esc is the keyboard stop.
    if ((!hasText && !hasImages) || !this.app.activeChat) return;

    // When plan review is in "Propose Changes" mode, treat the next message
    // as plan feedback instead of a normal prompt.
	    if (this.app.planModeEnabled && hasText && !hasImages && !slashCommand) {
	      const proposeResult = this.app.planModeManager.submitProposedPlanChanges(this.app.activeChat.id, content);
      if (proposeResult.handled) {
        if (proposeResult.success) {
          input.value = '';
          this.clearPromptDraft(this.app.activeChat.id);
          this.app.slashCommandManager.hide();
          this.app.autoResizeTextarea(input);
          this.updateButton();
        }
        return;
      }
    }

    if (this.blockUnavailableModel(this.app.selectedModel)) return;

    // Check for API key (either global or folder-specific)
    const effectiveKey = this.app.getEffectiveApiKey();
    if (!effectiveKey) {
      this.app.showApiKeyReminder();
      return;
    }

    // Check if API key is validated
    if (!isApiKeyValidated()) {
      this.app.showApiKeyReminder('Your API key is invalid. Please double check.');
      return;
    }

    const requestImages = attachedImages.map((image) => ({
      mime_type: image.mime_type,
      data: image.data
    }));

    // Clear input immediately for better UX
    input.value = '';
    this.app.slashCommandManager.hide();
    this.app.clearComposerImages();
    this.clearPromptDraft(this.app.activeChat.id);
    this.app.autoResizeTextarea(input);
    this.updateButton();

    const targetChat = this.app.activeChat;

    const dispatch = (outgoingImages) => {
      this.pruneStaleQueuedMessages(activeChatId);
      this.clearStaleProcessingIfNeeded(activeChatId);

      // If currently processing, queue the message in this chat's specific queue
      if (this.isActiveTurnInProgress(activeChatId, 'send_attempt')) {
        const execution = this.getExecutionSelection(this.app.modelProvider, this.app.selectedModel);
        const executionProvider = execution.provider;
        const executionModel = execution.model;
        if (sendMode === 'queue') {
          this.queueMessageForChat(activeChatId, {
            content: requestContent,
            images: outgoingImages,
            executionProvider,
            executionModel,
          });
        } else {
          // Steer the chat captured at send time — the async image path below
          // means the active chat may have changed by dispatch time.
          this.steerActiveTurn(requestContent, outgoingImages, {
            executionProvider,
            executionModel,
            targetChat,
            submittedAt,
          });
        }
        return;
      }

      // Send immediately with pending state
      this.sendContentToChat(requestContent, targetChat, false, outgoingImages, { submittedAt });
    };

    if (requestImages.length === 0 && !this.outgoingDispatchChain) {
      dispatch(requestImages);
      return;
    }

    // Downscaling decodes via <img> so it is async; the composer was already
    // cleared above, and a double-Enter re-entry no-ops on the empty input,
    // so the late dispatch only delays the network send slightly. Sends chain
    // behind any pending dispatch so order matches send order — a text-only
    // send must not start a turn that an earlier, still-normalizing image
    // send would then steer.
    const link = (this.outgoingDispatchChain || Promise.resolve())
      .then(() => (requestImages.length === 0
        ? requestImages
        // Never drop the message over a failed optimization pass.
        : this.normalizeOutgoingImages(requestImages).catch(() => requestImages)))
      .then(dispatch)
      .catch((err) => {
        console.error('[SEND] Deferred dispatch failed:', err);
      })
      .then(() => {
        if (this.outgoingDispatchChain === link) this.outgoingDispatchChain = null;
      });
    this.outgoingDispatchChain = link;
  }

  // Resolves to the same array shape ({ mime_type, data }) with oversized
  // images downscaled; small images are returned untouched.
  async normalizeOutgoingImages(images) {
    if (!Array.isArray(images) || images.length === 0) return images;
    return Promise.all(images.map((image) => downscaleImageIfNeeded(image)));
  }

  queueMessageForChat(chatId, queuedItem = {}) {
    if (!chatId) return false;
    const content = typeof queuedItem.content === 'string' ? queuedItem.content : '';
    const images = Array.isArray(queuedItem.images) ? queuedItem.images : [];
    if (!content && images.length === 0) return false;

    if (!this.app.messageQueues.has(chatId)) {
      this.app.messageQueues.set(chatId, []);
    }
    const queueEntry = {
      content,
      images,
      executionProvider: queuedItem.executionProvider,
      executionModel: queuedItem.executionModel,
      queuedAt: Date.now()
    };
    if (queuedItem.skipAddMessage === true) {
      queueEntry.skipAddMessage = true;
    }
    if (queuedItem.sourceClientSentAtMs !== undefined) {
      queueEntry.sourceClientSentAtMs = queuedItem.sourceClientSentAtMs;
    }
    if (typeof queuedItem.sourceRequestId === 'string' && queuedItem.sourceRequestId) {
      queueEntry.sourceRequestId = queuedItem.sourceRequestId;
    }
    this.app.messageQueues.get(chatId).push(queueEntry);
    this.app.updateQueueIndicator();
    return true;
  }

  moveActiveStatusAfterLatestTurnInput(chat) {
    if (!chat || !Array.isArray(chat.timeline)) return false;

    let statusIndex = -1;
    for (let i = chat.timeline.length - 1; i >= 0; i -= 1) {
      const item = chat.timeline[i];
      if (item?.type === 'status' && item.finalized !== true) {
        statusIndex = i;
        break;
      }
    }
    if (statusIndex < 0 || statusIndex === chat.timeline.length - 1) return false;

    const [statusItem] = chat.timeline.splice(statusIndex, 1);
    chat.timeline.push(statusItem);
    return true;
  }

  coalesceUnobservedSteerAnalytics(chatId) {
    const pending = this.app.aiProviderAnalytics?.getPendingTurn?.(chatId);
    if (!pending || pending.firstOutputEmitted || pending.firstOutputInFlight) return false;
    this.app.aiProviderAnalytics.finishTurn(chatId);
    return true;
  }

  steerActiveTurn(content, images = [], options = {}) {
    if (this.blockUnavailableModel(options.executionModel || this.app.selectedModel)) return false;
    // send()'s async image dispatch passes the chat captured at send time;
    // falling back to the live active chat covers direct callers.
    const targetChat = options.targetChat || this.app.activeChat;
    if ((!content && (!images || images.length === 0)) || !targetChat) return false;

    const normalizedImages = Array.isArray(images)
      ? images.map((image) => ({ mime_type: image.mime_type, data: image.data }))
      : [];
    const timelineContent = content || this.describeImageOnlyPrompt(normalizedImages.length);

    this.app.ensureTimelineForChat(targetChat);
    this.app.addToTimeline({
      type: 'user',
      content: timelineContent,
      images: normalizedImages,
      bubbleVariant: 'steer',
    }, targetChat);
    this.moveActiveStatusAfterLatestTurnInput(targetChat);

    this.app.renderMessages();
    scrollChatMessagesToEnd();
    this.app.saveProjects();

    if (this.app.ws && this.app.ws.readyState === WebSocket.OPEN) {
      const useRopilotCredits = this.app.isUseRopilotCreditsEnabled?.() === true;
      const clientSentAtMs = Date.now();
      const submittedAt = Number(options.submittedAt);
      const parentStartedAt = Number(this.app.processingStartedAt?.get?.(targetChat.id) || 0);
      const startedAt = Number.isFinite(submittedAt) && submittedAt > parentStartedAt
        ? submittedAt
        : clientSentAtMs;
      const requestId = this.createSteerRequestId();
      const turnId = `${targetChat.id}:steer:${requestId}`;
      this.coalesceUnobservedSteerAnalytics(targetChat.id);
      const msg = {
        type: 'steer',
        session_id: targetChat.id,
        prompt: content,
        images: normalizedImages,
        provider: options.executionProvider,
        model: options.executionModel,
        use_ropilot_credits: useRopilotCredits,
        bring_your_own_ai_subscription: this.app.isBringYourOwnSubscriptionEnabled?.() !== false,
        ropilot_credit_route_priority: useRopilotCredits ? 'economy' : undefined,
        client_sent_at_ms: clientSentAtMs,
        request_id: requestId,
        steer_rejection_supported: true,
      };
      const steerAttemptKey = this.getSteerAttemptKey(targetChat.id, requestId);
      this.prunePendingSteerAttempts(clientSentAtMs);
      this.pendingSteerAttempts.set(steerAttemptKey, {
        chatId: targetChat.id,
        requestId,
        clientSentAtMs,
        content,
        images: normalizedImages,
        executionProvider: options.executionProvider,
        executionModel: options.executionModel,
        createdAt: clientSentAtMs,
        state: 'pending',
      });
      this.app.ws.send(JSON.stringify(msg));
      this.warmRopilotHarnessForManagedTurn(useRopilotCredits);
      this.app.aiProviderAnalytics?.startTurn({
        chatId: targetChat.id,
        turnId,
        provider: options.executionProvider,
        model: options.executionModel,
        routePriority: msg.ropilot_credit_route_priority || 'byo',
        useRopilotCredits,
        projectDir: this.app.projectDir || null,
        mode: (this.app.projectDir || null) ? 'filesync' : 'sourcecontrol',
        startedAt,
      });
      return true;
    }

    this.app.addErrorMessage('Not connected to server');
    return false;
  }

  sendContent(content, skipAddMessage = false, images = [], options = {}) {
    if ((!content && (!images || images.length === 0)) || !this.app.activeChat) return false;
    // Delegate to the chat-aware version with the active chat
    return this.sendContentToChat(content, this.app.activeChat, skipAddMessage, images, options);
  }

  // Send message to a specific chat (used for queued messages that may target a different chat)
  sendContentToChat(content, targetChat, skipAddMessage = false, images = [], options = {}) {
    if ((!content && (!images || images.length === 0)) || !targetChat) return false;

    const normalizedContent = typeof content === 'string' ? content.trim() : '';
    const displayContent = typeof options?.displayContent === 'string'
      ? options.displayContent.trim()
      : '';
    const transportContent = typeof options?.transportContent === 'string' && options.transportContent.trim()
      ? options.transportContent.trim()
      : normalizedContent;
    const slashCommand = (transportContent && (!images || images.length === 0))
      ? findSlashCommand(transportContent)
      : null;
    const isCompactCommand = slashCommand?.id === 'compact';

    // Refresh the chat reference to ensure we have the canonical object
    const freshChat = this.app.chatManager.findById(targetChat.id);
    if (!freshChat) {
      console.warn('[SEND] Target chat no longer exists:', targetChat.id);
      return false;
    }
    targetChat = freshChat;
    this.clearPromptDraft(targetChat.id);

    // Clear stale playtest state if no playtest panel is visible
    // This prevents status from being routed to a non-existent playtest panel
    if (this.app.isPlaytestActive()) {
      const playtestPanel = document.querySelector('.playtest-panel:not(.hidden)');
      if (!playtestPanel) {
        console.log('[SEND] Clearing stale playtestActive flag');
        this.app.clearPlaytestState('stale panel in send');
      }
    }

    // Ensure timeline exists
    this.app.ensureTimelineForChat(targetChat);

    // Check if user is currently viewing this chat
    const isOnTargetChat = this.app.activeChat?.id === targetChat.id;
    const useManagedCredits = this.app.isUseRopilotCreditsEnabled?.() === true;
    const legacyCreditsMigration = useManagedCredits
      ? this.app.migrateLegacyRopilotCreditsChat?.(targetChat)
      : null;
    if (legacyCreditsMigration) {
      targetChat.updatedAt = Date.now();
      this.app.saveProjects();
      this.app.chatSync?.scheduleChatCommit({ chatId: targetChat.id, reason: 'provider_metadata_change' });
    }
    const normalizedImages = Array.isArray(images)
      ? images.map((image) => ({ mime_type: image.mime_type, data: image.data }))
      : [];
    const timelineContent = displayContent || content || '';
    const previewLabel = timelineContent || this.describeImageOnlyPrompt(normalizedImages.length);
    const shouldAddUserTimelineMessage = !skipAddMessage && !isCompactCommand;
    const userBubbleVariant = typeof options?.userBubbleVariant === 'string'
      ? options.userBubbleVariant.trim()
      : '';
    const requestedProvider = options.executionProvider
      ? this.app.normalizeModelProvider(options.executionProvider)
      : (isOnTargetChat
        ? this.app.normalizeModelProvider(this.app.modelProvider)
        : this.app.normalizeModelProvider(targetChat.provider || this.app.modelProvider));
    const requestedModel = options.executionModel
      || (isOnTargetChat ? this.app.selectedModel : (targetChat.model || this.app.selectedModel));
    if (this.blockUnavailableModel(requestedModel)) return false;
    const executionSelection = this.getExecutionSelection(requestedProvider, requestedModel);
    const safeProvider = executionSelection.provider;
    const safeModel = executionSelection.model;
    const useRopilotCredits = executionSelection.useRopilotCredits;
    const previousProvider = useRopilotCredits
      ? 'codex'
      : this.app.normalizeModelProvider(targetChat.provider || safeProvider);
    const previousModel = this.normalizeHistoryModelForProvider(
      previousProvider,
      targetChat.model || this.app.getDefaultModelForProvider(previousProvider)
    );
    const providerChanged = previousProvider !== safeProvider;
    const modelChanged = previousModel !== safeModel;

    // Add user message to timeline immediately (not pending)
    if (shouldAddUserTimelineMessage) {
      const userTimelineItem = { type: 'user', content: timelineContent, images: normalizedImages };
      if (userBubbleVariant) {
        userTimelineItem.bubbleVariant = userBubbleVariant;
      }
      this.app.addToTimeline(userTimelineItem, targetChat);

      // Only update UI if viewing the target chat
      if (isOnTargetChat) {
        this.app.renderMessages();
        scrollChatMessagesToEnd();
      }

      // Update chat title if first user message
      const userMessages = targetChat.timeline.filter(i => i.type === 'user');
      if (userMessages.length === 1) {
        targetChat.title = previewLabel.slice(0, 50) + (previewLabel.length > 50 ? '...' : '');
        this.app.renderProjectList();
      }

      this.app.saveProjects();
    }

    // Start processing for this specific chat. Preserve the button-press time
    // so managed runtime setup and deferred image work are part of first output.
    this.app.startProcessingChat(targetChat.id);
    const submittedAt = Number(options.submittedAt);
    const processingStartedAt = Number.isFinite(submittedAt) && submittedAt > 0
      ? submittedAt
      : Number(this.app.processingStartedAt?.get?.(targetChat.id) || Date.now());
    this.app.processingStartedAt?.set?.(targetChat.id, processingStartedAt);
    this.app.beginTurnActionCost(targetChat.id);

    // Compact commands use dedicated compaction timeline UI (not generic status),
    // otherwise we'd end up with duplicated "Compacted conversation history" entries.
    if (isCompactCommand) {
      if (isOnTargetChat) {
        this.app.hideStatus();
      } else {
        this.app.finalizeStatusInChat(targetChat.id);
      }
      this.app.beginCompactionInChat(targetChat.id);
    } else if (isOnTargetChat && !useRopilotCredits) {
      this.app.showStatus('Thinking');
    }
    this.updateButton();
    this.app.renderProjectList();

    // Message index for reconstruction (count user messages)
    const messageIndex = targetChat.timeline.filter(i => i.type === 'user').length;

    // Build the message with optional message history for reconstruction
    const msg = this.buildMessageForChat(transportContent, messageIndex, targetChat, normalizedImages, {
      provider: safeProvider,
      model: safeModel,
      providerChanged,
      modelChanged,
      historyProvider: previousProvider,
      historyModel: previousModel
    });
    if (isCompactCommand) {
      msg.type = 'compact';
      msg.prompt = '/compact';
    }
    // Recorded only once the compact is actually on the wire (see
    // sendPreparedMessage). The record is consumed by the terminal handlers,
    // and every send-failure path — socket closed, managed runtime setup
    // rejected — returns without producing a terminal event, so recording it
    // before the send leaves a record that the next unrelated turn's "done"
    // would inherit and mistake for a completed compact.
    const trackPendingCompact = isCompactCommand && safeProvider === 'codex';
    // A record can only ever describe the turn now starting, so anything left
    // over from an earlier turn on this chat is stale by definition.
    this.pendingCodexCompactChatIds.delete(targetChat.id);

    const chatDisplayProvider = useRopilotCredits
      ? (this.app.getProviderForModel(safeModel) || executionSelection.displayProvider)
      : safeProvider;
    if (targetChat.provider !== chatDisplayProvider || targetChat.model !== safeModel) {
      targetChat.provider = chatDisplayProvider;
      targetChat.model = safeModel;
      targetChat.updatedAt = Date.now();
      this.app.saveProjects();
      this.app.chatSync?.scheduleChatCommit({ chatId: targetChat.id, reason: 'provider_metadata_change' });
      if (isOnTargetChat) {
        this.app.renderProjectList();
      }
    }

    const analyticsTurnId = this.createAnalyticsTurnId(targetChat.id, messageIndex, processingStartedAt);
    this.app.aiProviderAnalytics?.startTurn({
      chatId: targetChat.id,
      turnId: analyticsTurnId,
      provider: safeProvider,
      model: safeModel,
      routePriority: msg.ropilot_credit_route_priority || 'byo',
      useRopilotCredits: msg.use_ropilot_credits === true,
      projectDir: msg.project_dir || null,
      mode: msg.project_dir ? 'filesync' : 'sourcecontrol',
      startedAt: processingStartedAt,
    });

    const sendPreparedMessage = () => {
      if (!(this.app.ws && this.app.ws.readyState === WebSocket.OPEN)) {
        this.app.aiProviderAnalytics?.noteFirstOutput?.(targetChat.id, 'error');
        this.app.aiProviderAnalytics?.finishTurn?.(targetChat.id);
        this.app.cancelTurnActionCost(targetChat.id);
        if (isOnTargetChat) {
          this.app.addErrorMessage('Not connected to server');
          this.app.hideStatus();
        }
        this.app.stopProcessingChat(targetChat.id);
        this.app.renderProjectList();
        return false;
      }

      msg.client_sent_at_ms = Date.now();
      this.app.ws.send(JSON.stringify(msg));
      if (trackPendingCompact) {
        this.pendingCodexCompactChatIds.add(targetChat.id);
      }
      const ttfwTurnId = `${targetChat.id}:${messageIndex}:${msg.client_sent_at_ms}`;
      this.app.ttfwAnalytics?.startTurn({
        chatId: targetChat.id,
        turnId: ttfwTurnId,
        provider: safeProvider,
        model: safeModel,
        projectDir: msg.project_dir || null,
        startedAt: msg.client_sent_at_ms
      });
      return true;
    };

    if (useRopilotCredits) {
      this.warmRopilotHarnessForManagedTurn(true);
      this.ensureManagedCodexRuntimeReady(targetChat, isOnTargetChat)
        .then(() => {
          if (isOnTargetChat) {
            this.app.showStatus?.('Thinking');
          }
          sendPreparedMessage();
        })
        .catch((err) => {
          this.handleManagedRuntimeSetupFailure(err, targetChat, isOnTargetChat);
        });
      return true;
    }

    return sendPreparedMessage();
  }

  // OpenAI service tier for the request, or '' to leave it unset.
  //   Ropilot Credits + managed Fast on  -> 'priority' (2.5x model credits)
  //   BYO ChatGPT + personal Fast on     -> 'fast'
  //   anything else                      -> unset
  // The two toggles never bleed into each other: a BYO 'fast' preference
  // must not become a paid 'priority' request after a mode switch.
  resolveServiceTier(provider, model) {
    if (provider !== 'codex') return '';
    if (this.app.isUseRopilotCreditsEnabled?.() === true) {
      return this.app.shouldUseRopilotCreditsFastModeForModel?.(model) === true
        ? ROPILOT_CREDITS_FAST_MODE_SERVICE_TIER
        : '';
    }
    return this.app.shouldUseFastModeForModel?.(model) === true ? 'fast' : '';
  }

  // Build inference request message with optional message history for session reconstruction
  buildMessage(content, messageIndex, images = []) {
    return this.buildMessageForChat(content, messageIndex, this.app.activeChat, images);
  }

  // Build inference request message for a specific chat
  buildMessageForChat(content, messageIndex, targetChat, images = [], execution = {}) {
    // Find the project that contains this chat to get the correct project dir, API key, and custom prompt
    let projectDir = this.app.projectDir;
    let apiKey = this.app.getEffectiveApiKey();
    let projectCustomPrompt = '';

    for (const project of this.app.projects) {
      if (project.chats.some(c => c.id === targetChat.id)) {
        projectDir = project.workingDir || null;
        apiKey = project.apiKey || this.app.apiKey;
        projectCustomPrompt = project.customPrompt || '';
        break;
      }
    }

    // Combine studio-level and project-level custom prompts
    const studioPrompt = this.app.customPrompt || '';
    const combinedCustomPrompt = [studioPrompt, projectCustomPrompt].filter(Boolean).join('\n\n');

    const executionSelection = this.getExecutionSelection(execution.provider || this.app.modelProvider, execution.model || this.app.selectedModel);
    const safeProvider = executionSelection.provider;
    const safeModel = executionSelection.model;
    const reasoningLevel = this.app.getReasoningLevelForModel(safeModel);
    const serviceTier = this.resolveServiceTier(safeProvider, safeModel);
    if (this.app.activeChat?.id === targetChat.id && safeModel !== this.app.selectedModel) {
      this.app.selectedModel = safeModel;
      localStorage.setItem('ropilot_selected_model', safeModel);
    }
    let historyProvider = this.app.normalizeModelProvider(execution.historyProvider || targetChat.provider || safeProvider);
    if (this.app.isUseRopilotCreditsEnabled?.() === true && safeProvider === 'codex' && historyProvider === 'ropilot') {
      historyProvider = 'codex';
    }
    const historyModel = this.normalizeHistoryModelForProvider(
      historyProvider,
      execution.historyModel || targetChat.model || safeModel
    );
    const providerMatchesHistory = !execution.providerChanged && historyProvider === safeProvider;
    const sameCodexModel = providerMatchesHistory &&
      safeProvider === 'codex' &&
      historyModel === safeModel;
    const claudeSessionId = safeProvider === 'claude' && providerMatchesHistory
      ? (targetChat.claudeSessionId || undefined)
      : undefined;
    const codexThreadId = safeProvider === 'codex' && sameCodexModel
      ? (targetChat.codexThreadId || undefined)
      : undefined;
    const hasHistory = safeProvider === 'claude'
      ? (!!claudeSessionId && !!targetChat.hasHistory)
      : (!!codexThreadId && !!targetChat.hasHistory && !execution.modelChanged);

    const useRopilotCreditsForRequest = this.app.isUseRopilotCreditsEnabled?.() === true;
    const msg = {
      prompt: content,
      session_id: targetChat.id,
      provider: safeProvider,
      api_key: apiKey,
      project_dir: projectDir || undefined,
      model: safeModel,
      reasoning_level: reasoningLevel,
      service_tier: serviceTier || undefined,
      message_index: messageIndex,
      auto_playtest: this.app.autoPlaytest,
      use_ropilot_credits: useRopilotCreditsForRequest,
      bring_your_own_ai_subscription: this.app.isBringYourOwnSubscriptionEnabled?.() !== false,
      claude_api_proxy_enabled: safeProvider === 'claude'
        ? this.app.isClaudeAPIProxyEnabled?.() !== false
        : undefined,
      ropilot_credit_route_priority: useRopilotCreditsForRequest
        ? (this.app.getRopilotCreditsRoutePriority?.() || 'economy')
        : undefined,
      codex_playtest_subagent_model: safeProvider === 'codex'
        ? resolveCodexPlaytestExecutionModel(this.app.getEffectiveCodexPlaytestSubagentModelPreference?.() || this.app.codexPlaytestSubagentModel)
        : undefined,
      claude_session_id: claudeSessionId,
      codex_thread_id: codexThreadId,
      has_history: hasHistory,
      turn_checkpoints: safeProvider === 'claude' && providerMatchesHistory ? (targetChat.turnCheckpoints || undefined) : undefined,
      sourcecontrol_state: targetChat.sourcecontrolState || undefined,
    };

    if (Array.isArray(images) && images.length > 0) {
      msg.images = images;
    }

    // Include custom prompt if set (studio-level + project-level combined)
    if (combinedCustomPrompt) {
      msg.custom_prompt = combinedCustomPrompt;
    }

    // Include message history for session reconstruction fallback
    // Only needed if we have prior messages (not the first message in chat)
    if (messageIndex > 1 && targetChat.timeline) {
      const reconstructionCandidates = [];
      // Everything before a confirmed compact was summarized away; sending it
      // again is what made /compact appear to do nothing. Scoped to Codex:
      // Claude resumes its own CLI session and its compact summary lives
      // there, so its reconstruction fallback stays unbounded.
      const startIndex = safeProvider === 'codex'
        ? reconstructionStartIndex(targetChat)
        : 0;
      const compacted = startIndex > 0;
      const reconstructionLimit = compacted
        ? MAX_COMPACTED_RECONSTRUCTION_MESSAGES
        : MAX_RECONSTRUCTION_MESSAGES;
      const reconstructionUserLimit = compacted
        ? MAX_COMPACTED_RECONSTRUCTION_USERS
        : MAX_RECONSTRUCTION_MESSAGES;

      for (const item of targetChat.timeline.slice(startIndex)) {
        if (item.type === 'user') {
          const userText = (item.content || '').trim();
          const userImages = Array.isArray(item.images) ? item.images : [];
          const userMessageContent = userText || (userImages.length > 0 ? this.describeImageOnlyPrompt(userImages.length) : '');
          if (!userMessageContent) continue;
          reconstructionCandidates.push({
            toolHint: false,
            message: {
              role: 'user',
              content: userMessageContent
            }
          });
        } else if (item.type === 'assistant' || item.type === 'emit') {
          reconstructionCandidates.push({
            toolHint: false,
            message: {
              role: 'assistant',
              content: item.content
            }
          });
        } else if (item.type === 'status') {
          if (safeProvider === 'codex') {
            continue;
          }
          // Include tool call context as assistant messages
          // Status items have text like "Reading file.lua", "Editing script.lua", etc.
          const text = item.text || '';
          if (text && text !== 'Thinking') {
            reconstructionCandidates.push({
              toolHint: true,
              message: {
                role: 'assistant',
                content: `[Tool: ${text}]`
              }
            });
          }
        }
      }

      // Only include if we have previous messages
      if (reconstructionCandidates.length > 0) {
        msg.messages = selectReconstructionMessages(
          reconstructionCandidates,
          reconstructionLimit,
          reconstructionUserLimit
        );
        console.log(`[SESSION] Including ${msg.messages.length} previous messages for reconstruction fallback${compacted ? ' (post-compaction window)' : ''}`);
      }
    }

    // Include rewind flag if set so Go resets provider-native history before
    // rebuilding from the renderer's truncated timeline.
    if (this.app.pendingRewind) {
      if (safeProvider === 'claude' || safeProvider === 'codex') {
        msg.rewind = true;
        console.log(`[SESSION] Including rewind flag for ${safeProvider} session`);
      }
      this.app.pendingRewind = false; // Clear after including in message
    }

    if (safeProvider === 'codex' && this.app.pendingCodexRewindStrict) {
      msg.codex_rewind_strict = true;
      console.log('[CODEX-REWIND] Enabling strict rewind mode for next Codex send');
    }
    this.app.pendingCodexRewindStrict = false;

    return msg;
  }

  blockUnavailableModel(model) {
    if (isModelAvailableOnPlatform(model)) return false;
    this.app.showAppAlertModal('Astra is coming to Windows', 'GPT-6 Astra is currently available on macOS and Linux. Please choose another model for this message.');
    return true;
  }

  getExecutionSelection(provider, model) {
    const displayProvider = this.app.normalizeModelProvider(provider);
    const useRopilotCredits = this.app.isUseRopilotCreditsEnabled?.() === true;
    if (useRopilotCredits) {
      const managedModel = typeof this.app.coerceRopilotCreditsModel === 'function'
        ? this.app.coerceRopilotCreditsModel(model)
        : this.app.normalizeSelectedModel(model);
      return {
        provider: 'codex',
        model: managedModel,
        displayProvider,
        useRopilotCredits: true
      };
    }

    return {
      provider: displayProvider,
      model: this.app.coerceModelForProvider(displayProvider, model),
      displayProvider,
      useRopilotCredits: false
    };
  }

  normalizeHistoryModelForProvider(provider, model) {
    const normalizedProvider = this.app.normalizeModelProvider(provider);
    if (this.app.isUseRopilotCreditsEnabled?.() === true && (normalizedProvider === 'codex' || normalizedProvider === 'ropilot')) {
      return this.app.normalizeSelectedModel(model);
    }
    return this.app.coerceModelForProvider(normalizedProvider, model);
  }

  describeImageOnlyPrompt(imageCount) {
    return imageCount === 1 ? '[Image attached]' : `[${imageCount} images attached]`;
  }

  getSendButtonIcon(mode) {
    // Synara's send/stop glyphs: a bold arrow-up, and an 8px square with
    // 1px corners for stop.
    if (mode === 'stop') {
      return '<svg viewBox="0 0 8 8" fill="none" aria-hidden="true"><rect width="8" height="8" rx="1" fill="currentColor"/></svg>';
    }

    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M6 11l6 -6l6 6"/></svg>';
  }

  updateButton() {
    const input = document.getElementById('input-message');
    const btn = document.getElementById('btn-send');
    const composerShell = document.querySelector('.composer-shell');
    if (!input || !btn) return;  // Guard against missing elements

    const hasText = input.value.trim().length > 0;
    const hasImages = this.app.getComposerImages().length > 0;

    if (composerShell) {
      composerShell.classList.toggle('has-composer-content', hasText || hasImages);
      composerShell.classList.toggle('has-composer-images', hasImages);
    }

    // Check if the active chat is processing
    // Also validate there's actually an active status element visible if processing
    const activeChatId = this.app.activeChat?.id || null;
    const stopPending = activeChatId ? this.stopPendingChatIds.has(activeChatId) : false;
    const isCurrentlyProcessing = this.app.isProcessing
      || stopPending
      || this.hasFreshProcessingTimestamp(activeChatId);

    // Show stop button when processing (regardless of text).
    // Keyboard shortcuts still allow steering or explicit queueing.
    if (isCurrentlyProcessing) {
      btn.disabled = stopPending;
      btn.classList.add('stop-mode');
      btn.title = stopPending ? 'Stopping generation...' : 'Stop generation (Esc)';
      btn.innerHTML = this.getSendButtonIcon('stop');
    } else {
      btn.disabled = !(hasText || hasImages);
      btn.classList.remove('stop-mode');
      btn.title = 'Send message';
      btn.innerHTML = this.getSendButtonIcon('send');
    }
  }

  // Stop the current inference for the active chat
  stopInference() {
    // Stop inference for the ACTIVE chat only
    const chatIdToStop = this.app.activeChat?.id;
    console.log('[STOP] stopInference called, activeChat:', chatIdToStop, 'isProcessing:', this.app.isChatProcessing(chatIdToStop));

    if (!chatIdToStop || !this.isActiveTurnInProgress(chatIdToStop, 'stop_attempt')) {
      console.log('[STOP] Early return - active chat not processing');
      return;
    }
    if (this.stopPendingChatIds.has(chatIdToStop)) {
      console.log('[STOP] Stop already pending for chat:', chatIdToStop);
      return;
    }

    console.log('[STOP] Stopping inference for chat:', chatIdToStop);
    console.log('[STOP] WebSocket state:', this.app.ws ? this.app.ws.readyState : 'null', '(OPEN=1)');
    if (!this.managedRuntimeSetupChatIds.has(chatIdToStop)) {
      this.app.aiProviderAnalytics?.trackLongThinkingStop?.(chatIdToStop);
    }
    this.stopPendingChatIds.add(chatIdToStop);

    // Keep the chat marked as processing until the backend acknowledges the stop.
    // That lets follow-up sends queue behind the stop instead of racing a second request.
    this.app.showStatus('Stopping');
    this.updateButton();
    this.app.renderProjectList();

    // Send stop request to backend
    if (this.app.ws && this.app.ws.readyState === WebSocket.OPEN) {
      const msg = {
        type: 'stop',
        session_id: chatIdToStop
      };
      console.log('[STOP] Sending:', JSON.stringify(msg));
      this.app.ws.send(JSON.stringify(msg));
      console.log('[STOP] Message sent');
    } else {
      console.log('[STOP] WebSocket not open, cannot send');
      this.stopPendingChatIds.delete(chatIdToStop);
      this.app.stopProcessingChat(chatIdToStop);
      this.app.hideStatus();
      this.app.updateButton();
      this.app.renderProjectList();
    }
  }

  // Reports whether the turn that just ended for this chat was a Codex
  // /compact, clearing the record. One-shot: the caller acts on it once.
  consumePendingCodexCompact(chatId) {
    if (!chatId) return false;
    return this.pendingCodexCompactChatIds.delete(chatId);
  }

  // Drops every in-flight compact record. Used when turns are abandoned
  // without a terminal event (socket reconnect).
  clearPendingCodexCompacts() {
    this.pendingCodexCompactChatIds.clear();
  }

  clearStopPending(chatId) {
    if (!chatId) return;
    if (!this.stopPendingChatIds.delete(chatId)) return;
    if (this.app.activeChat?.id === chatId) {
      this.updateButton();
    }
  }

  processNextQueued(preferredChatId = null) {
    // Check if any chat has queued messages
    if (this.app.messageQueues.size === 0) return;

    // Find a chat with queued messages (prioritize the chat that just finished if it has more)
    let targetChatId = null;
    let targetQueue = null;

    // First, check the explicitly released chat, then the remaining queues.
    const candidateChatIds = [];
    if (preferredChatId && this.app.messageQueues.has(preferredChatId)) {
      candidateChatIds.push(preferredChatId);
    }
    for (const chatId of this.app.messageQueues.keys()) {
      if (chatId !== preferredChatId) candidateChatIds.push(chatId);
    }
    for (const chatId of candidateChatIds) {
      this.pruneStaleQueuedMessages(chatId);
      this.clearStaleProcessingIfNeeded(chatId, 'process_next_queued');
      if (this.isActiveTurnInProgress(chatId, 'process_next_queued')) {
        continue;
      }
      const nextQueue = this.app.messageQueues.get(chatId) || [];
      if (nextQueue.length > 0) {
        targetChatId = chatId;
        targetQueue = nextQueue;
        break; // Process first chat with messages
      }
    }

    if (!targetChatId || !targetQueue || targetQueue.length === 0) {
      // Clean up empty queues
      for (const [chatId, queue] of this.app.messageQueues) {
        if (queue.length === 0) {
          this.app.messageQueues.delete(chatId);
        }
      }
      return;
    }

    // Get next message from this chat's queue
    const queuedItem = targetQueue.shift();
    const content = typeof queuedItem === 'string' ? queuedItem : (queuedItem?.content || '');
    const displayContent = typeof queuedItem === 'string' ? '' : (queuedItem?.displayContent || '');
    const images = typeof queuedItem === 'string'
      ? []
      : (Array.isArray(queuedItem?.images) ? queuedItem.images : []);
    const executionProvider = typeof queuedItem === 'string' ? undefined : queuedItem?.executionProvider;
    const executionModel = typeof queuedItem === 'string' ? undefined : queuedItem?.executionModel;
    const userBubbleVariant = typeof queuedItem === 'string' ? '' : (queuedItem?.userBubbleVariant || '');
    const skipAddMessage = typeof queuedItem === 'string' ? false : queuedItem?.skipAddMessage === true;

    // Clean up empty queue
    if (targetQueue.length === 0) {
      this.app.messageQueues.delete(targetChatId);
    }

    this.app.updateQueueIndicator();

    // Find the target chat
    const targetChat = this.app.chatManager.findById(targetChatId);
    if (!targetChat) {
      console.warn('[QUEUE] Chat no longer exists for queued message:', targetChatId);
      // Try next message in queue
      this.processNextQueued();
      return;
    }

    // Send to the correct chat (this will set isProcessing = true again)
    this.sendContentToChat(content, targetChat, skipAddMessage, images, {
      displayContent,
      executionProvider,
      executionModel,
      userBubbleVariant,
    });
  }
}
