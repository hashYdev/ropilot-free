// Route Retry Autopilot — automatic retry for Ropilot Standard route failures.
//
// When the gateway reports "Standard is having trouble with this request",
// the chat shows a [Note from Ropilot] with a "Retry with Standard" button.
// This module automatically triggers that retry after a short visible
// countdown, so users don't have to click through a stack of failure notes
// during an outage.
//
// Behavior contract:
// - Only a LIVE failure note (from the current session) arms a countdown.
//   Notes restored from persistence or re-rendered from the timeline are
//   inert (manual click still works).
// - One countdown per app, keyed to the chat it was armed for. Switching
//   chats cancels it; it never fires into a different chat.
// - Auto-fire uses the exact same handler as a manual click
//   (app.retryRopilotCreditsRouteFailure('economy')), so billing/turn
//   semantics are identical.
// - The countdown pauses while the websocket is not open (no retries into a
//   dead socket) and resumes when the connection returns.
// - Retry after 5s, up to three retries per stuck turn. Persistent failures
//   pause automatic retries; the user can still retry manually.
// - A send on the chat that we did not dispatch (new user message, edit,
//   manual composer retry) cancels the countdown and resets the counter.
// - When a retry we dispatched SUCCEEDS (the replacement turn completes with
//   real assistant output and no new route-failure note), the stale failure
//   debris from the failed attempt(s) — the error wall(s), the [Note from
//   Ropilot] + retry button, and the orphaned "Thought for Ns"/thinking rows
//   that led into each wall — is removed from both the DOM and the persisted
//   timeline, so the transcript reads as if the turn just worked.
import { store } from './state-store.js';

const BASE_DELAY_MS = 5000;
const MAX_AUTOMATIC_RETRIES = 3;
const TICK_MS = 1000;
const BUTTON_LABEL = 'Retry now';
// Resting copy for the quiet one-line note (inert/restored notes, and any
// live note whose countdown was cancelled).
const RESTING_STATUS_TEXT = 'Standard hit a snag with this request.';
const PAUSED_STATUS_TEXT = "Standard still isn't responding. Automatic retries paused; try again later.";
// After a retried turn stops processing, wait briefly before judging the
// outcome — a late-arriving failure note (WS error after turn end) must be
// able to veto the cleanup.
const OUTCOME_SETTLE_MS = 600;

function isRouteFailureItem(item) {
  return item?.type === 'error' && item.cta === 'retry_ropilot_credits_route';
}

export class RouteRetryAutopilot {
  constructor(app, options = {}) {
    this.app = app;
    this.tickMs = Number.isFinite(options.tickMs) ? options.tickMs : TICK_MS;
    this.baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : BASE_DELAY_MS;

    this.chatId = null; // chat the armed countdown belongs to
    this.timer = null;
    this.remainingMs = 0;
    this.attemptsByChat = new Map(); // chatId -> retries dispatched for the stuck turn
    this.expectingRetryChatId = null; // set while WE dispatch, so our own send doesn't read as user intervention
    this.lastProcessingIds = new Set(); // snapshot — the store notifies with the same mutated Set
    this.button = null;
    this.counterEl = null;
    this.statusEl = null; // the quiet one-line text span of the adopted note
    // chatId -> { firedAt } recorded when a retry dispatches; used to judge
    // the replacement turn's outcome once it stops processing.
    this.pendingOutcomeByChat = new Map();
    this.outcomeTimersByChat = new Map(); // chatId -> settle setTimeout handle
    this.outcomeSettleMs = Number.isFinite(options.outcomeSettleMs) ? options.outcomeSettleMs : OUTCOME_SETTLE_MS;

    store.subscribe('processingChatIds', (ids) => this.handleProcessingChange(ids));
    store.subscribe('activeChatId', (activeChatId) => {
      if (this.timer && activeChatId !== this.chatId) {
        this.cancel('chat_switched');
      }
    });
  }

  // Called by the renderer whenever a retry-route failure note element is
  // built. `live` is true only for notes created by the live error path in
  // the current session — never for timeline re-renders or restored chats.
  registerNote(container, { live = false } = {}) {
    if (!container?.querySelector) return;
    const button = container.querySelector('.retry-route-economy-btn');
    if (!button) return;
    if (live) {
      // A fresh failure note means the previous retry (if any) failed —
      // its pending outcome is settled, keep the debris until success.
      const activeId = store.get('activeChatId');
      if (activeId) this.dropPendingOutcome(activeId);
    }

    const activeChatId = store.get('activeChatId');
    if (live && activeChatId) {
      this.arm(activeChatId, container);
      return;
    }

    // Re-render while a countdown is running: adopt the (newest) button as
    // the display target so the ticking label survives DOM rebuilds.
    if (this.timer && this.chatId === activeChatId) {
      this.adopt(container);
      this.renderCountdown();
    }
  }

  arm(chatId, container) {
    this.clearTimer();
    this.chatId = chatId;
    this.adopt(container);
    if (this.getAttempts(chatId) >= MAX_AUTOMATIC_RETRIES) {
      this.resetNoteDisplay();
      return;
    }
    this.remainingMs = this.baseDelayMs;
    this.renderCountdown();
    this.timer = setInterval(() => this.handleTick(), this.tickMs);
  }

  handleTick() {
    if (!this.timer) return;
    if (store.get('activeChatId') !== this.chatId) {
      this.cancel('chat_switched');
      return;
    }
    if (this.app.isChatProcessing?.(this.chatId)) {
      this.cancel('chat_processing');
      return;
    }
    if (!this.isSocketOpen()) {
      // Hold the countdown while disconnected instead of burning retries
      // into a dead socket; it resumes as soon as the connection is back.
      this.renderCountdown(true);
      return;
    }
    this.remainingMs -= this.tickMs;
    if (this.remainingMs <= 0) {
      this.fire('auto');
      return;
    }
    this.renderCountdown();
  }

  // Single dispatch path shared by the auto countdown and manual clicks —
  // literally the same handler the button always invoked.
  fire(source = 'manual') {
    const chatId = store.get('activeChatId');
    this.clearTimer();
    if (!chatId) return false;
    if (source === 'auto' && (this.chatId !== chatId || this.getAttempts(chatId) >= MAX_AUTOMATIC_RETRIES)) {
      this.resetNoteDisplay();
      return false;
    }

    const attempts = this.getAttempts(chatId) + 1;
    this.attemptsByChat.set(chatId, attempts);
    this.expectingRetryChatId = chatId;
    let sent = false;
    try {
      sent = this.app.retryRopilotCreditsRouteFailure?.('economy') === true;
    } finally {
      this.expectingRetryChatId = null;
    }

    if (sent) {
      // Track the replacement turn so its outcome can be judged when it
      // stops processing: success clears the failure debris, another
      // failure keeps it.
      this.dropPendingOutcome(chatId);
      this.pendingOutcomeByChat.set(chatId, { firedAt: Date.now() });
      if (this.button) {
        this.button.disabled = true;
      }
      if (this.statusEl) {
        this.statusEl.textContent = 'Retrying…';
      }
    } else {
      // Nothing dispatched (chat busy / no prompt) — undo the attempt.
      this.attemptsByChat.set(chatId, attempts - 1);
      this.resetNoteDisplay();
    }
    return sent;
  }

  handleProcessingChange(ids) {
    if (!(ids instanceof Set)) return;
    // Any send we did not dispatch ourselves means the user (or another
    // flow) took over that chat's turn — its retry streak is over.
    // (Compare against the previous snapshot: the store mutates and passes
    // the same Set instance, so only newly-started chats count.)
    for (const id of ids) {
      if (!this.lastProcessingIds.has(id) && id !== this.expectingRetryChatId) {
        this.attemptsByChat.delete(id);
        // The user (or another flow) started a turn we didn't dispatch —
        // stop judging any in-flight retry outcome for that chat.
        this.dropPendingOutcome(id);
      }
    }
    // A chat that just STOPPED processing while a retry outcome is pending:
    // give late failure notes a moment to land, then judge the turn.
    for (const id of this.lastProcessingIds) {
      if (!ids.has(id) && this.pendingOutcomeByChat.has(id)) {
        this.scheduleOutcomeEvaluation(id);
      }
    }
    this.lastProcessingIds = new Set(ids);
    if (this.timer && this.chatId && ids.has(this.chatId)) {
      this.cancel('chat_processing');
    }
  }

  scheduleOutcomeEvaluation(chatId) {
    const existing = this.outcomeTimersByChat.get(chatId);
    if (existing) clearTimeout(existing);
    this.outcomeTimersByChat.set(chatId, setTimeout(() => {
      this.outcomeTimersByChat.delete(chatId);
      this.evaluateRetryOutcome(chatId);
    }, this.outcomeSettleMs));
  }

  // Judge the replacement turn after it settled. Success = the newest
  // route-failure wall in the stuck turn is followed by real assistant
  // progress AND no new live failure note arrived (a fresh note drops the
  // pending outcome in registerNote before we ever get here).
  evaluateRetryOutcome(chatId) {
    if (!this.pendingOutcomeByChat.has(chatId)) return;
    if (store.isChatProcessing(chatId)) return; // a new turn is running — judge when it ends
    this.pendingOutcomeByChat.delete(chatId);

    const chat = store.getChatById?.(chatId);
    const timeline = Array.isArray(chat?.timeline) ? chat.timeline : null;
    if (!timeline) return;

    let lastUserIndex = -1;
    let lastFailureIndex = -1;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (lastFailureIndex === -1 && isRouteFailureItem(item)) lastFailureIndex = i;
      if (item?.type === 'user' && item.bubbleVariant !== 'steer') {
        lastUserIndex = i;
        break;
      }
    }
    // No failure wall inside the retried turn — nothing to clear.
    if (lastFailureIndex === -1 || lastFailureIndex <= lastUserIndex) return;

    const hasProgressAfterFailure = timeline
      .slice(lastFailureIndex + 1)
      .some((item) => (
        ((item?.type === 'assistant' || item?.type === 'emit')
          && typeof item.content === 'string' && item.content.trim() !== '')
        || item?.type === 'diff' || item?.type === 'raw_html' || item?.type === 'playtest'
      ));
    if (!hasProgressAfterFailure) return; // turn ended without output — keep the wall

    this.clearFailureDebris(chat, lastUserIndex);
    this.attemptsByChat.delete(chatId);
  }

  // Remove every route-failure wall inside the stuck turn (all stacked
  // attempts), plus the orphaned status/thinking rows that led into each
  // one ("Thought for Ns" from the failed attempt). The successful
  // attempt's own rows come AFTER the last wall and are untouched.
  clearFailureDebris(chat, lastUserIndex) {
    const timeline = chat.timeline;
    const removeIndices = new Set();
    for (let i = timeline.length - 1; i > lastUserIndex; i--) {
      if (!isRouteFailureItem(timeline[i])) continue;
      removeIndices.add(i);
      // Contiguous status/thinking run directly before this wall belongs to
      // the failed attempt that produced it.
      for (let j = i - 1; j > lastUserIndex; j--) {
        if (removeIndices.has(j)) break;
        const prev = timeline[j];
        if (prev?.type === 'status' || prev?.type === 'thinking') {
          removeIndices.add(j);
        } else {
          break;
        }
      }
    }
    if (removeIndices.size === 0) return;

    for (const index of [...removeIndices].sort((a, b) => b - a)) {
      timeline.splice(index, 1);
    }

    // Persist: full-chat replace so the sync round-trip reflects the splice
    // (incremental message queues can't express removals).
    this.app.projectManager?.markChatForFullUpdate?.(chat.id);
    this.app.saveChats?.();
    this.app.chatSync?.scheduleChatCommit?.({ chatId: chat.id, reason: 'route_retry_success_cleanup' });

    // Live DOM: a full re-render drops the stale walls and orphaned rows in
    // one pass (only when the chat is on screen). Our display targets are
    // about to be unmounted — drop the references first.
    if (store.get('activeChatId') === chat.id) {
      this.button = null;
      this.counterEl = null;
      this.statusEl = null;
      this.app.messageRenderer?.render?.();
    }
  }

  dropPendingOutcome(chatId) {
    if (!chatId) return;
    this.pendingOutcomeByChat.delete(chatId);
    const timer = this.outcomeTimersByChat.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.outcomeTimersByChat.delete(chatId);
    }
  }

  cancel() {
    this.clearTimer();
    this.resetNoteDisplay();
    this.chatId = null;
    this.button = null;
    this.counterEl = null;
    this.statusEl = null;
  }

  adopt(container) {
    const button = container.querySelector('.retry-route-economy-btn');
    if (!button) return;
    if (this.button && this.button !== button) {
      // An older note was our display target — leave it inert with its
      // resting copy.
      this.resetNoteDisplay();
    }
    this.button = button;
    this.counterEl = container.querySelector('.route-retry-attempts');
    this.statusEl = container.querySelector('.route-failure-text');
    this.renderAttemptCounter();
  }

  renderAttemptCounter() {
    if (!this.counterEl) return;
    const attempts = this.getAttempts(this.chatId);
    if (attempts > 0) {
      this.counterEl.textContent = `attempt ${attempts + 1}`;
      this.counterEl.hidden = false;
    } else {
      this.counterEl.textContent = '';
      this.counterEl.hidden = true;
    }
  }

  renderCountdown(paused = false) {
    if (!this.statusEl) return;
    if (paused) {
      this.statusEl.textContent = 'Standard hit a snag — waiting for connection…';
      return;
    }
    const seconds = Math.max(1, Math.ceil(this.remainingMs / 1000));
    this.statusEl.textContent = `Standard hit a snag — retrying in ${seconds}s…`;
  }

  resetNoteDisplay() {
    if (this.button) {
      this.button.disabled = false;
      this.button.textContent = BUTTON_LABEL;
    }
    if (this.statusEl) {
      this.statusEl.textContent = this.getAttempts(this.chatId) >= MAX_AUTOMATIC_RETRIES
        ? PAUSED_STATUS_TEXT
        : RESTING_STATUS_TEXT;
    }
  }

  getAttempts(chatId) {
    if (!chatId) return 0;
    return this.attemptsByChat.get(chatId) || 0;
  }

  isSocketOpen() {
    const state = this.app.wsManager?.state;
    return state === undefined || state === 'open';
  }

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
