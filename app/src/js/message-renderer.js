// Message Renderer - handles message display and timeline
import { escapeHtml, getChatMessagesScroller, getScriptIcon, inferScriptTypeFromPath, isChatScrollPinnedToBottom, scrollChatMessagesToEnd, scrollChatMessagesToEndNow, statusCommandHTML } from './utils.js';
import { formatMessage } from './message-formatter.js';
import { store } from './state-store.js';
import { matchStepGroupKind, placeStatusElement } from './search-group.js';
import { animateTurnWorkClosing, createTurnWorkElement, installTurnWorkToggle, planTurnWork } from './turn-work.js';
import { createThinkingElement, getThinkingStatusHeadline, hasStreamingThinkingItem, isHideThinkingEnabled, isThinkingItemStreaming, syncThinkingElement, upsertThinkingTimelineItem } from './thinking-block.js';
import { isVagueActivityStatusText } from './status-manager.js';
import { createBlenderPreviewElement, pruneBlenderPreviews, syncLiveBlenderPreview } from './blender-preview.js';
import { electronAPI } from './core/platform.js';
import { INLINE_INVITE_PROMO_MARKUP } from './credits/credits-wall.js';

const PLAN_MODE_STATUS_TEXTS = new Set([
  'Entered plan mode.',
  'Exited plan mode. Plan ready for review.',
]);
const COMPACTION_ACTIVE_TEXT = 'Compacting conversation history';
const COMPACTION_DONE_TEXT = 'Compacted conversation history';
const FALLBACK_PROCESSING_TEXT = 'Working';
const TIMELINE_INITIAL_CHUNK_SIZE = 20;
const TIMELINE_LOAD_CHUNK_SIZE = 80;
const TIMELINE_LOAD_TRIGGER_PX = 96;
// Live appends bypass the chunk window; trim the oldest mounted nodes past
// this count so the DOM doesn't grow unbounded across a long turn.
const TIMELINE_LIVE_MOUNTED_CAP = 200;
// A pending upgrade card can only live near the tail: any progress item ends
// the scan, so items buried deeper than this can no longer be pending.
const PENDING_UPGRADE_SCAN_WINDOW = 50;
// History renders keep only this many of the newest diff cards expanded;
// older ones start collapsed with lazily hydrated bodies (a window with
// dozens of large cards would otherwise Lua-highlight all of them at once).
const EXPANDED_RECENT_DIFF_CARDS = 3;
// Only these hrefs may render as a real anchor in a [Note from Ropilot]
// (noteLink option) — everything else in a note stays escaped plain text.
// Maps href -> vendor name for the quiet route-failure line's outage hint.
const NOTE_LINK_ALLOWED_HREFS = new Map([
  ['https://status.openai.com/', 'OpenAI'],
  ['https://status.claude.com/', 'Anthropic'],
]);
function normalizeDetectionText(text) {
  return typeof text === 'string' && text.length > 0
    ? text
      .toLowerCase()
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
      .replace(/\u2019/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
    : '';
}

function isCodexPlusUpgradeLimitText(text) {
  const normalized = normalizeDetectionText(text);
  if (!normalized) return false;

  const mentionsCodexOrChatGpt = normalized.includes('codex')
    || normalized.includes('chatgpt')
    || normalized.includes('openai')
    || normalized.includes('chat.openai.com')
    || normalized.includes('gpt-');
  const mentionsUsageLimit = normalized.includes('usage limit')
    || normalized.includes('hit your limit')
    || normalized.includes('reached your chatgpt limit')
    || normalized.includes('hit your chatgpt limit')
    || normalized.includes('reached your usage cap')
    || normalized.includes('usage cap');

  return mentionsCodexOrChatGpt && mentionsUsageLimit;
}

function parseSearchInScriptStatusText(text) {
  const match = /^(Search(?:ing|ed))\s+"((?:\\.|[^"\\])*)"\s+in\s+(game\..+)$/i.exec(String(text || '').trim());
  if (!match) return null;
  return {
    label: match[1],
    query: match[2]
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\'),
    path: match[3].trim(),
  };
}

function parseLineRangeScriptStatusText(text) {
  const match = /^((?:Read(?:ing)?)\s+L[0-9][0-9,-]*)\s+(game\..+)$/i.exec(String(text || '').trim());
  if (!match) return null;
  return {
    label: match[1],
    path: match[2].trim(),
  };
}

function renderStatusTextHTML(text) {
  const parsed = parseSearchInScriptStatusText(text);
  if (parsed) {
    const activeChat = store.getActiveChat();
    const scriptType = activeChat?.scriptTypes?.[parsed.path] || inferScriptTypeFromPath(parsed.path);
    return `<span class="status-prefix">${escapeHtml(parsed.label)}</span> <code>${escapeHtml(parsed.query)}</code> in ${getScriptIcon(scriptType)} ${escapeHtml(parsed.path)}`;
  }

  const lineRange = parseLineRangeScriptStatusText(text);
  if (lineRange) {
    const activeChat = store.getActiveChat();
    const scriptType = activeChat?.scriptTypes?.[lineRange.path] || inferScriptTypeFromPath(lineRange.path);
    return `<span class="status-prefix">${escapeHtml(lineRange.label)}</span> ${getScriptIcon(scriptType)} ${escapeHtml(lineRange.path)}`;
  }

  // Plain text (e.g. the synthetic 'Working' fallback row) — shimmer/ellipsis
  // only take effect while the row is .status-active, so finalized rows
  // render this markup as ordinary text.
  return `<span class="status-prefix">${escapeHtml(text || '')}<span class="status-ellipsis"></span></span>`;
}

function extractCodexUsageLimitRetryAt(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const cleaned = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const precise = cleaned.match(/\btry again at\s+([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (precise) {
    return precise[1].replace(/\s+/g, ' ').trim();
  }

  const fallback = cleaned.match(/\btry again (?:at|after|on)\s+([^.)\]\n\r]+)(?=[.)\]\n\r]|$)/i);
  return fallback ? fallback[1].replace(/\s+/g, ' ').trim() : '';
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.min(100, number));
}

function formatCompactTokens(value) {
  const number = toFiniteNumber(value);
  if (number === null || number < 0) return '';
  if (number >= 1000000) {
    const rounded = number / 1000000;
    return `${rounded >= 10 ? rounded.toFixed(0) : rounded.toFixed(1)}M`;
  }
  if (number >= 1000) {
    const rounded = number / 1000;
    return `${rounded >= 10 ? rounded.toFixed(0) : rounded.toFixed(1)}K`;
  }
  return `${Math.round(number)}`;
}

export class MessageRenderer {
  constructor(app) {
    this.app = app;
    this.timelineStartByChat = new Map();
    this.lastRenderedChatId = null;
    this.loadingOlderForChatId = null;
    this.messagesScrollEl = null;
    this.onMessagesScroll = this.handleMessagesScroll.bind(this);
    installTurnWorkToggle();
  }

  renderStorageSaveStatus() {
    const status = document.getElementById('storage-save-status');
    if (!status) return;
    const manager = this.app.projectManager?.syncManager;
    // Give automatic retries a chance before interrupting the user.
    status.classList.toggle('hidden', !(manager?.localSaveFailureCount >= 2));
    const retry = status.querySelector('button');
    if (retry) {
      retry.disabled = !!manager?.saveToStorageInProgress;
      retry.onclick = () => manager?.retryLocalSave().catch((err) => {
        console.warn('[STORAGE] Manual save retry failed:', err);
      });
    }
  }

  render(options = {}) {
    this.renderStorageSaveStatus();
    const container = document.getElementById('messages');
    if (!container) return;

    this.attachMessagesScrollHandler();
    const activeChat = store.getActiveChat();
    // The live credits wall (out of Ropilot Credits / ChatGPT usage limit)
    // is appended straight into #messages, not the timeline, so a full
    // re-render — e.g. the fold at turn end — would wipe it the moment it
    // appears. Carry it across re-renders of the same chat.
    const liveWallCard = activeChat && this.lastRenderedChatId === activeChat.id
      ? container.querySelector('#credits-inline-card:not([data-timeline-item-id])')
      : null;
    container.innerHTML = '';

    if (!activeChat) {
      pruneBlenderPreviews();
      return;
    }

    // Ensure timeline exists
    this.ensureTimelineForChat(activeChat);

    // Show/hide chat welcome based on whether there are any content messages
    const hasContent = activeChat.timeline.some(item =>
      item.type === 'user' ||
      item.type === 'assistant' ||
      item.type === 'emit' ||
      item.type === 'diff' ||
      item.type === 'compaction' ||
      item.type === 'plan_enter' ||
      item.type === 'ask_question' ||
      (item.type === 'plan_review' && item.status !== 'thread_started') ||
      item.type === 'raw_html' ||
      item.type === 'image'
    );
    this.updateChatWelcome(!hasContent);

    // Debug: log timeline summary
    const playtestItems = activeChat.timeline.filter(i => i.type === 'playtest');
    if (playtestItems.length > 0) {
      console.log('[RENDER] Timeline has', playtestItems.length, 'playtest items:',
        playtestItems.map(p => ({ id: p.id, scriptsCount: p.scripts?.length })));
    }

    const timeline = activeChat.timeline;
    // Rendering a different chat than last time resets its window to the
    // default last-20 view; explicit "load older" expansion only persists
    // within the same chat visit.
    const chatChanged = this.lastRenderedChatId !== activeChat.id;
    this.lastRenderedChatId = activeChat.id;
    const startIndex = this.getTimelineStartIndex(activeChat.id, timeline.length, options.resetChunk === true || chatChanged);
    const visibleItems = timeline.slice(startIndex);
    const hasOlderMessages = startIndex > 0;
    const isLoadingOlder = this.loadingOlderForChatId === activeChat.id;
    const actionInfoItems = this.getActionInfoItems(timeline);
    const pendingRopilotCreditsUpgradeItem = this.findPendingRopilotCreditsUpgradeItem(timeline);
    if (!pendingRopilotCreditsUpgradeItem && !liveWallCard) {
      this.app?.clearNoActionsUpgradeRecoveryState?.();
    }

    if (hasOlderMessages || isLoadingOlder) {
      container.appendChild(this.createChunkLoaderElement(isLoadingOlder));
    }

    let messageIndex = this.countUserMessagesBeforeIndex(timeline, startIndex);
    let remainingDiffCards = 0;
    for (const item of visibleItems) {
      if (item.type === 'diff') remainingDiffCards += 1;
    }

    // Find the last renderable unfinalized status ID (only that one should show
    // its persisted spinner). A hidden thinking headline is deliberately not
    // elected: Hide Thinking replaces it with the generic processing spinner.
    const hideThinking = isHideThinkingEnabled();
    const lastUnfinalizedStatusId = this.findLastUnfinalizedStatusId(timeline, { hideThinking });
    const latestPendingQuestionId = this.app.planModeManager.getLatestPendingQuestionId(activeChat);
    const hasActiveCompaction = timeline.some(item => item.type === 'compaction' && item.finalized !== true);

    // Finished turns fold their work behind a "Worked for …" header
    // (turn-work.js) created where the turn's first work item would render;
    // the running turn stays expanded.
    const foldedWork = this.planTurnWorkForRender(activeChat, startIndex, hideThinking);
    let turnFolded = false;
    const workTargetFor = (item) => {
      const turn = foldedWork.get(item);
      if (!turn) return container;
      if (!turn.body) {
        const block = createTurnWorkElement(turn);
        container.appendChild(block);
        turn.body = block.querySelector('.turn-work-body');
        turnFolded = true;
      }
      return turn.body;
    };

    // Chats from before end-of-turn previews stored the Blender snapshot on
    // status rows (item.blenderPreview); show a turn's last one at its end.
    let legacyBlenderPreview = null;
    let turnHasBlenderPreview = false;
    const flushLegacyBlenderPreview = () => {
      if (legacyBlenderPreview && !turnHasBlenderPreview) {
        container.appendChild(createBlenderPreviewElement(legacyBlenderPreview));
      }
      legacyBlenderPreview = null;
      turnHasBlenderPreview = false;
    };

    for (const [visibleIndex, item] of visibleItems.entries()) {
      if (item.type === 'user') {
        flushLegacyBlenderPreview();
        turnFolded = false;
      }
      if (item.type === 'blender_preview') turnHasBlenderPreview = true;
      if (item.type === 'status' && typeof item.blenderPreview?.path === 'string') {
        legacyBlenderPreview = item.blenderPreview;
      }
      if (item.type === 'user' || item.type === 'assistant' || item.type === 'emit') {
        const role = item.type === 'user' ? 'user' : 'assistant';
        const msgType = item.type === 'emit' ? 'emit' : 'normal';
        if (role === 'assistant' && this.shouldRenderRopilotCreditsUpgradeCard(item.content)) {
          if (item === pendingRopilotCreditsUpgradeItem) {
            container.appendChild(this.createRopilotCreditsUpgradeCardElement(item));
          }
          continue;
        }
        // A folded turn's header already rules the work off from the answer.
        if (role === 'assistant'
          && !turnFolded
          && !(typeof item.content === 'string' && PLAN_MODE_STATUS_TEXTS.has(item.content.trim()))
          && this.shouldInsertTurnSeparatorBefore(timeline, startIndex + visibleIndex)) {
          container.appendChild(this.createTurnSeparatorElement());
        }
        this.appendElement(role, item.content, msgType, messageIndex, false, item.images, {
          container: workTargetFor(item),
          bubbleVariant: item.bubbleVariant,
          actionCost: actionInfoItems.has(item) ? (item.actionCost ?? item.actionCount ?? 0) : undefined,
          actionCostLabel: item.actionCostLabel,
          actionCostBalanceType: item.actionCostBalanceType,
          actionDurationMs: item.actionDurationMs,
          useRopilotCredits: item.useRopilotCredits ?? item.use_ropilot_credits,
          timelineItemId: item.id,
          skipScroll: true,
        });
        if (item.type === 'user') messageIndex++;
      } else if (item.type === 'diff') {
        remainingDiffCards -= 1;
        this.appendDiffElement(item.content, messageIndex, {
          startExpanded: remainingDiffCards < EXPANDED_RECENT_DIFF_CARDS,
          container: workTargetFor(item),
        });
      } else if (item.type === 'playtest') {
        const panel = this.app.playtestPanel.createElement(item);
        workTargetFor(item).appendChild(panel);
      } else if (item.type === 'blender_preview') {
        container.appendChild(createBlenderPreviewElement(item));
      } else if (item.type === 'image') {
        // Screenshots stay visible in place; they are the point, not work.
        container.appendChild(this.createChatImageElement(item));
      } else if (item.type === 'status') {
        // Hide Thinking applies to the lightweight replacement headline too,
        // both while live and after it has been finalized. Ordinary status
        // rows remain visible.
        if (item.thinkingHeadline && hideThinking) continue;
        // Chats persisted before vague rows became live-only can still carry
        // "Read scripts"/"Edited script" residue — skip it (presentational
        // only; the timeline itself is left untouched).
        if (!item.command && isVagueActivityStatusText(item.text)) continue;
        const isLastActive = item.id === lastUnfinalizedStatusId;
        const statusEl = this.createStatusElement(item, isLastActive);
        placeStatusElement(workTargetFor(item), statusEl, matchStepGroupKind(item.text));
      } else if (item.type === 'compaction') {
        const compactionEl = this.createCompactionElement(item);
        workTargetFor(item).appendChild(compactionEl);
      } else if (item.type === 'thinking') {
        // "Hide Thinking": drop the block from the render entirely. The
        // timeline item stays intact, so disabling the setting restores it.
        if (hideThinking) continue;
        // Eligible one-line bold summaries use the active status row while the
        // turn is live. Once finalized they remain represented by that status
        // entry; all other summaries keep the existing Thinking block.
        if (this.thinkingHasHeadlineStatus(timeline, item)) continue;
        workTargetFor(item).appendChild(createThinkingElement(item, {
          streaming: store.isChatProcessing(activeChat.id) && isThinkingItemStreaming(item),
        }));
      } else if (item.type === 'plan_enter') {
        // Pending plan-enter prompt is handled around the composer area.
        if (item.status !== 'pending') {
          container.appendChild(this.app.planModeManager.renderPlanEnter(item));
        }
      } else if (item.type === 'ask_question') {
        // Pending questions live in the composer wizard — skip them in chat
        if (item.status === 'pending') {
          // Don't render pending questions in the chat area
        } else if (item.status === 'answered') {
          // Compact read-only summary of answered questions
          container.appendChild(this.createAnsweredSummary(item));
        } else if (item.status === 'superseded' || item.status === 'cancelled') {
          const notice = document.createElement('div');
          notice.className = 'qw-cancelled-notice';
          notice.textContent = item.status === 'superseded' ? 'Questions superseded' : 'Questions cancelled';
          container.appendChild(notice);
        } else {
          // Fallback: render via planModeManager for any other status
          const isLatestPending = item.id === latestPendingQuestionId;
          container.appendChild(this.app.planModeManager.renderAskQuestion(item, isLatestPending));
        }
      } else if (item.type === 'plan_review') {
        if (item.status !== 'thread_started') {
          container.appendChild(this.app.planModeManager.renderPlanReview(item));
        }
      } else if (item.type === 'raw_html') {
        container.appendChild(this.createRawHtmlElement(item));
      } else if (item.type === 'error') {
        if (this.shouldRenderRopilotCreditsUpgradeCard(item.content)) {
          if (item === pendingRopilotCreditsUpgradeItem) {
            container.appendChild(this.createRopilotCreditsUpgradeCardElement(item));
          }
        } else {
          const errorEl = this.createErrorElement(item.content, {
            cta: item.cta,
            ctaProvider: item.ctaProvider,
            noteTitle: item.noteTitle,
            noteMessage: item.noteMessage,
            noteLink: item.noteLink,
          });
          container.appendChild(errorEl);
        }
      }
    }
    if (!store.isChatProcessing(activeChat.id)) flushLegacyBlenderPreview();
    if (options.animateFoldClosing === true) {
      // The just-finished turn's fold: the last one, with no prompt after it.
      const lastFold = [...container.children].reverse().find((el) => (
        el.classList.contains('turn-work') || el.classList.contains('user')
      ));
      if (lastFold?.classList.contains('turn-work')) animateTurnWorkClosing(lastFold);
    }
    syncLiveBlenderPreview(activeChat.id);
    pruneBlenderPreviews();

    if (store.isChatProcessing(activeChat.id) && !lastUnfinalizedStatusId && !hasActiveCompaction) {
      container.appendChild(this.createFallbackProcessingStatusElement(activeChat.id));
    }

    if (liveWallCard && !document.getElementById('credits-inline-card')) {
      container.appendChild(liveWallCard);
    }

    this.applyScrollBehavior(options);
    this.app.planModeManager.syncComposerDock();
  }

  findPendingRopilotCreditsUpgradeItem(timeline = []) {
    if (!Array.isArray(timeline) || timeline.length === 0) return null;
    const stopIndex = Math.max(0, timeline.length - PENDING_UPGRADE_SCAN_WINDOW);

    for (let index = timeline.length - 1; index >= stopIndex; index -= 1) {
      const item = timeline[index];
      if (!item || typeof item !== 'object') continue;
      const isAssistantish = item.type === 'assistant' || item.type === 'emit';
      const isUpgradeItem = (isAssistantish || item.type === 'error')
        && this.shouldRenderRopilotCreditsUpgradeCard(item.content);

      if (isUpgradeItem) {
        return item;
      }

      // Any progress after the card means it can no longer be pending, and
      // an even older card would return null too — stop scanning here.
      if (this.isTimelineProgressAfterRopilotCreditsUpgrade(item)) {
        return null;
      }
    }

    return null;
  }

  isTimelineProgressAfterRopilotCreditsUpgrade(item = {}) {
    if (!item || typeof item !== 'object') return false;
    if (item.type === 'user') return true;
    if (item.type === 'diff' || item.type === 'raw_html' || item.type === 'playtest' || item.type === 'image') return true;
    if (item.type !== 'assistant' && item.type !== 'emit') return false;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    return content.length > 0 && !this.shouldRenderRopilotCreditsUpgradeCard(content);
  }

  shouldRenderRopilotCreditsUpgradeCard(text) {
    if (this.app?.messageHandler?.isCodexPlusUpgradeLimitMessage?.(text)) {
      return true;
    }
    return isCodexPlusUpgradeLimitText(text);
  }

  createRopilotCreditsUpgradeCardElement(item = {}) {
    const retryAt = this.app?.messageHandler?.extractCodexUsageLimitRetryAt?.(item?.content)
      || extractCodexUsageLimitRetryAt(item?.content);

    if (this.app) {
      this.app.noActionsUpgradeToRopilotCreditsPending = true;
      this.app.noActionsChatGptUsageLimitRetryAt = retryAt;
    }

    const card = typeof this.app?.createNoActionsCard === 'function'
      ? this.app.createNoActionsCard()
      : this.createFallbackRopilotCreditsCard(item);

    if (card.id === 'credits-inline-card' && document.getElementById('credits-inline-card')) {
      card.id = item?.id ? `credits-inline-card-${item.id}` : '';
    }

    if (item?.id) {
      card.dataset.timelineItemId = item.id;
    }

    setTimeout(() => {
      this.app?.updateNoActionsCard?.();
      this.app?.startNoActionsCreditRecoveryWatcher?.();
    }, 0);

    return card;
  }

  createFallbackRopilotCreditsCard(item = {}) {
    const card = document.createElement('div');
    card.className = 'credits-inline-card';
    card.id = 'credits-inline-card';
    const retryAt = extractCodexUsageLimitRetryAt(item?.content);
    const kicker = retryAt
      ? `You have hit your ChatGPT usage limit. Try again at ${retryAt}. Here's how to keep going:`
      : "You have hit your ChatGPT usage limit. Here's how to keep going:";
    card.innerHTML = `
      <p class="cic-kicker">${escapeHtml(kicker)}</p>
      <div class="cic-card">
        <h2 class="cic-title">Your plan's limit, not a paywall</h2>
        <p class="cic-sub">This build has no credits to sell. It runs on your own login.</p>
      </div>
    `;
    return card;
  }

  attachMessagesScrollHandler() {
    const scroller = getChatMessagesScroller();
    if (!scroller) return;
    if (this.messagesScrollEl === scroller) return;
    if (this.messagesScrollEl) {
      this.messagesScrollEl.removeEventListener('scroll', this.onMessagesScroll);
    }
    scroller.addEventListener('scroll', this.onMessagesScroll, { passive: true });
    this.messagesScrollEl = scroller;
  }

  handleMessagesScroll() {
    const scroller = getChatMessagesScroller();
    const activeChat = store.getActiveChat();
    if (!scroller || !activeChat) return;
    if (this.loadingOlderForChatId) return;
    if (scroller.scrollTop > TIMELINE_LOAD_TRIGGER_PX) return;

    const timeline = activeChat.timeline || [];
    const startIndex = this.getTimelineStartIndex(activeChat.id, timeline.length);
    if (startIndex <= 0) return;

    this.loadOlderChunk(activeChat.id);
  }

  loadOlderChunk(chatId) {
    if (!chatId || this.loadingOlderForChatId) return;

    const chat = store.getChatById(chatId);
    if (!chat?.timeline) return;

    const timelineLength = chat.timeline.length;
    const currentStart = this.getTimelineStartIndex(chatId, timelineLength);
    if (currentStart <= 0) return;

    const scroller = getChatMessagesScroller();
    if (!scroller) return;

    // Expand the window and rebuild once, restoring the scroll anchor.
    // (Previously rendered everything twice: once for a loading spinner,
    // once for the new content.)
    this.timelineStartByChat.set(chatId, Math.max(0, currentStart - TIMELINE_LOAD_CHUNK_SIZE));
    this.render({
      scrollToBottom: false,
      preserveScrollOffset: {
        previousHeight: scroller.scrollHeight,
        previousTop: scroller.scrollTop,
      },
    });
  }

  getTimelineStartIndex(chatId, timelineLength, forceReset = false) {
    const defaultStart = Math.max(0, timelineLength - TIMELINE_INITIAL_CHUNK_SIZE);

    if (forceReset || !this.timelineStartByChat.has(chatId)) {
      this.timelineStartByChat.set(chatId, defaultStart);
      return defaultStart;
    }

    const stored = this.timelineStartByChat.get(chatId);
    let startIndex = Number.isInteger(stored) ? stored : defaultStart;
    if (startIndex < 0 || startIndex > timelineLength) {
      startIndex = defaultStart;
    }

    this.timelineStartByChat.set(chatId, startIndex);
    return startIndex;
  }

  countUserMessagesBeforeIndex(timeline, endIndexExclusive) {
    let count = 0;
    for (let i = 0; i < endIndexExclusive; i++) {
      if (timeline[i]?.type === 'user') {
        count++;
      }
    }
    return count;
  }

  createChunkLoaderElement(isLoading) {
    const el = document.createElement('div');
    el.className = 'message assistant message-status';

    if (isLoading) {
      el.innerHTML = `
        <div class="message-content status-content">
          <div class="status-spinner"></div>
          <span class="status-text">Loading earlier messages...</span>
        </div>
      `;
    } else {
      el.innerHTML = `
        <div class="message-content status-content">
          <span class="status-text">Scroll up to load earlier messages</span>
        </div>
      `;
    }

    return el;
  }

  applyScrollBehavior(options = {}) {
    const scroller = getChatMessagesScroller();
    if (!scroller) return;

    const anchor = options.preserveScrollOffset;
    if (anchor && Number.isFinite(anchor.previousHeight) && Number.isFinite(anchor.previousTop)) {
      const deltaHeight = scroller.scrollHeight - anchor.previousHeight;
      scroller.scrollTop = Math.max(0, anchor.previousTop + deltaHeight);
      return;
    }

    if (options.scrollToBottom === false) return;
    scrollChatMessagesToEndNow();
  }

  // Live appends bypass the chunk window and nothing else trims the DOM, so a
  // long turn would otherwise keep every message/status/diff node mounted.
  // Only trims while the user is pinned to the bottom (removing top nodes
  // shifts content up for a reader scrolled into the middle).
  enforceLiveMountedItemCap() {
    const container = document.getElementById('messages');
    if (!container || container.children.length <= TIMELINE_LIVE_MOUNTED_CAP) return;
    if (!isChatScrollPinnedToBottom()) return;
    const activeChat = store.getActiveChat();
    if (!activeChat?.timeline) return;

    let excess = container.children.length - TIMELINE_LIVE_MOUNTED_CAP;
    while (excess > 0 && container.firstElementChild) {
      container.firstElementChild.remove();
      excess -= 1;
    }

    // Advance the chunk window to the oldest still-mounted identifiable item
    // so scroll-up "load older" resumes from the trimmed edge on next render.
    const timeline = activeChat.timeline;
    let newStart = Math.max(0, timeline.length - TIMELINE_LIVE_MOUNTED_CAP);
    for (const child of container.children) {
      const itemId = child instanceof HTMLElement ? (child.dataset.timelineItemId || '') : '';
      if (!itemId) continue;
      for (let i = timeline.length - 1; i >= 0; i -= 1) {
        if (timeline[i]?.id === itemId) {
          newStart = i;
          break;
        }
      }
      break;
    }
    const currentStart = this.getTimelineStartIndex(activeChat.id, timeline.length);
    if (newStart > currentStart) {
      this.timelineStartByChat.set(activeChat.id, newStart);
    }
  }

  normalizeMessageLinkHref(rawHref) {
    if (typeof rawHref !== 'string') return '';
    const trimmed = rawHref.trim();
    if (!trimmed) return '';
    if (/^(data:|file:|https?:)/i.test(trimmed)) {
      return trimmed;
    }
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
      const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
      return encodeURI(`file:///${normalized}`);
    }
    if (/^(\/|\\\\)/.test(trimmed)) {
      const normalized = trimmed.replace(/\\/g, '/');
      return encodeURI(`file://${normalized}`);
    }
    return trimmed;
  }

  isPreviewableImageLink(href) {
    if (typeof href !== 'string' || href.trim() === '') return false;
    const withoutQuery = href.split('#')[0].split('?')[0];
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(withoutQuery);
  }

  enhanceMessageLinks(root) {
    if (!(root instanceof HTMLElement)) return;

    root.querySelectorAll('a[href]').forEach((linkEl) => {
      const rawHref = linkEl.getAttribute('href') || '';
      const normalizedHref = this.normalizeMessageLinkHref(rawHref);
      if (!normalizedHref) return;

      linkEl.setAttribute('href', normalizedHref);
      linkEl.setAttribute('target', '_blank');
      linkEl.setAttribute('rel', 'noopener noreferrer');

      linkEl.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (this.isPreviewableImageLink(normalizedHref)) {
          this.app.openImagePreview(normalizedHref, linkEl.textContent?.trim() || 'Image preview');
          return;
        }

        electronAPI()?.openExternal(normalizedHref);
      });
    });
  }

  // Show/hide the chat welcome overlay
  updateChatWelcome(show) {
    const welcome = document.getElementById('chat-welcome');
    if (!welcome) return;

    if (show) {
      welcome.classList.remove('hidden', 'fade-out');
    } else {
      welcome.classList.add('hidden');
    }
  }

  // Fade out the welcome when first message is sent
  fadeOutChatWelcome() {
    const welcome = document.getElementById('chat-welcome');
    if (!welcome || welcome.classList.contains('hidden')) return;

    welcome.classList.add('fade-out');
    // Remove from DOM after animation completes
    setTimeout(() => {
      welcome.classList.add('hidden');
      welcome.classList.remove('fade-out');
    }, 400);
  }

  ensureTimeline() {
    const activeChat = store.getActiveChat();
    if (!activeChat) return;
    if (!activeChat.timeline) {
      activeChat.timeline = [];
    }
  }

  ensureTimelineForChat(chat) {
    if (!chat.timeline) {
      chat.timeline = [];
    }
  }

  // Find the timeline index of the Nth user message
  findTimelineIndexOfUserMessage(userMessageIndex) {
    const activeChat = store.getActiveChat();
    if (!activeChat?.timeline) return -1;

    let userCount = 0;
    for (let i = 0; i < activeChat.timeline.length; i++) {
      if (activeChat.timeline[i].type === 'user') {
        if (userCount === userMessageIndex) {
          return i;
        }
        userCount++;
      }
    }
    return -1;
  }

  // Find the last unfinalized status ID in timeline (only this one should show spinner)
  findLastUnfinalizedStatusId(timeline, options = {}) {
    if (!timeline) return null;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item.type === 'status' && !item.finalized) {
        // Vague legacy rows are skipped by render() — electing one here would
        // leave the turn with no visible spinner. Hide Thinking likewise skips
        // persisted reasoning headlines so the generic fallback remains live.
        if (!item.command && isVagueActivityStatusText(item.text)) continue;
        if (options.hideThinking === true && item.thinkingHeadline) continue;
        return item.id;
      }
    }
    return null;
  }

  // A finalized reasoning summary with a bold headline is shown by its status
  // row; render() skips the Thinking block itself.
  thinkingHasHeadlineStatus(timeline, item) {
    const persistedHeadline = getThinkingStatusHeadline(item);
    return !!persistedHeadline && timeline.some((entry) => (
      entry?.type === 'status'
      && entry.thinkingItemId === item.id
      && entry.thinkingHeadline === persistedHeadline
    ));
  }

  // Which rendered items fold into their turn's "Worked for …" block. Work is
  // what render() actually draws as activity (so hidden rows can't produce an
  // empty fold); the running turn, from its prompt on, never folds.
  planTurnWorkForRender(chat, startIndex, hideThinking) {
    const timeline = chat.timeline;
    let liveFromIndex = timeline.length;
    if (store.isChatProcessing(chat.id)) {
      liveFromIndex = 0;
      for (let i = timeline.length - 1; i >= 0; i--) {
        if (timeline[i]?.type !== 'user') continue;
        liveFromIndex = i;
        // Steers join the turn they interrupted.
        if (timeline[i].bubbleVariant !== 'steer') break;
      }
    }
    const isWork = (item) => {
      if (item?.type === 'status') {
        if (item.thinkingHeadline && hideThinking) return false;
        return !!item.command || !isVagueActivityStatusText(item.text);
      }
      if (item?.type === 'thinking') return !hideThinking && !this.thinkingHasHeadlineStatus(timeline, item);
      // Script edits and playtests are work too: the closing message is the
      // turn's visible reply, not a wall of diff cards.
      return item?.type === 'compaction' || item?.type === 'diff' || item?.type === 'playtest';
    };
    const isText = (item) => (
      (item?.type === 'assistant' || item?.type === 'emit')
      && typeof item.content === 'string'
      && !PLAN_MODE_STATUS_TEXTS.has(item.content.trim())
      && !this.shouldRenderRopilotCreditsUpgradeCard(item.content)
    );
    return planTurnWork(timeline, {
      startIndex,
      liveFromIndex,
      isWork,
      isText,
    });
  }

  // A turn just ended: re-render so its work folds behind "Worked for …".
  collapseFinishedTurn(chatId) {
    if (!chatId || store.get('activeChatId') !== chatId) return;
    this.render({ scrollToBottom: isChatScrollPinnedToBottom(), animateFoldClosing: true });
  }

  // Turn separator — mirrors the Codex TUI's dim full-width rule drawn
  // between a turn's work (commands, edits, tool activity) and its answer
  // (codex-rs/tui history_cell::FinalMessageSeparator): emitted only when
  // concrete work happened since the last user message, so conversational
  // turns stay unbroken. Purely presentational — derived at render/append
  // time, never persisted to the timeline.
  createTurnSeparatorElement() {
    const el = document.createElement('div');
    el.className = 'message assistant turn-separator';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="turn-separator-line"></div>';
    return el;
  }

  // Concrete work = visible tool activity rows. Thinking blocks deliberately
  // do NOT count (reasoning-only turns are conversational in the Codex TUI
  // too), and hidden legacy vague rows can't justify a visible break.
  isTurnSeparatorWorkItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.type === 'status') {
      return !!item.command || !isVagueActivityStatusText(item.text);
    }
    return item.type === 'diff' || item.type === 'playtest' || item.type === 'compaction';
  }

  // True when the timeline item at `index` is an answer that follows work
  // with no other answer or user message in between.
  shouldInsertTurnSeparatorBefore(timeline, index) {
    if (!Array.isArray(timeline)) return false;
    for (let i = index - 1; i >= 0; i--) {
      const item = timeline[i];
      if (!item || typeof item !== 'object') continue;
      if (this.isTurnSeparatorWorkItem(item)) return true;
      // User messages (including steers) and earlier answers reset the run —
      // consecutive answer messages share one separator.
      if (item.type === 'user') return false;
      if (item.type === 'assistant' || item.type === 'emit') {
        const content = typeof item.content === 'string' ? item.content.trim() : '';
        if (!PLAN_MODE_STATUS_TEXTS.has(content)) return false;
      }
    }
    return false;
  }

  createStatusElement(data, isLastActive = false) {
    const el = document.createElement('div');
    // Only show spinner if: not finalized, chat is processing, AND this is the last unfinalized status
    const activeChat = store.getActiveChat();
    const isStillActive = !data.finalized && activeChat && store.isChatProcessing(activeChat.id) && isLastActive;
    el.className = `message assistant message-status ${isStillActive ? 'status-active' : 'status-done'}`;

    if (isStillActive) {
      el.dataset.label = data.text?.split(' ')[0] || 'Thinking';
      el.dataset.startTime = (data.timestamp || Date.now()).toString();
      if (data.id) {
        el.dataset.statusId = data.id;
      }
      if (data.synthetic) {
        el.dataset.synthetic = 'true';
      }
      if (data.thinkingHeadline) {
        el.dataset.label = 'Thinking';
        el.dataset.thinkingHeadline = 'true';
        if (data.thinkingItemId) el.dataset.thinkingItemId = data.thinkingItemId;
        el.dataset.thinkingHeadlineText = data.thinkingHeadline;
        el.classList.add('status-thinking-headline');
      }
      const statusTextMarkup = data.thinkingHeadline
        ? `<span class="status-detail-wrapper"><span class="status-detail">${escapeHtml(data.thinkingHeadline)}</span></span>`
        : renderStatusTextHTML(data.text);
      el.innerHTML = `
          <div class="message-content status-content">
            <div class="status-spinner"></div>
            <span class="status-text">${statusTextMarkup}</span>${statusCommandHTML(data.command, data.commandOutput)}
          </div>
        `;
      } else {
        el.innerHTML = `
          <div class="message-content status-content">
          <span class="status-text">${data.thinkingHeadline ? escapeHtml(data.thinkingHeadline) : renderStatusTextHTML(data.text)}</span>${statusCommandHTML(data.command, data.commandOutput)}
          </div>
        `;
      }
    return el;
  }

  createFallbackProcessingStatusElement(chatId) {
    const startedAt = Number(this.app.processingStartedAt?.get(chatId) || 0) || Date.now();
    return this.createStatusElement({
      text: FALLBACK_PROCESSING_TEXT,
      finalized: false,
      synthetic: true,
      timestamp: startedAt,
    }, true);
  }

  createCompactionElement(data) {
    const el = document.createElement('div');
    const isActive = data?.finalized !== true;
    el.className = `message assistant message-status message-compaction ${isActive ? 'status-active' : 'status-done'}`;
    if (data?.id) {
      el.dataset.compactionId = data.id;
    }

    const percent = isActive ? clampPercent(data?.progressPercent) : 100;
    const hasPercent = percent !== null;
    const percentLabel = isActive
      ? (data?.progressLabel || (hasPercent ? `${Math.round(percent)}% context` : 'Working'))
      : 'Done';
    const detail = isActive
      ? (data?.detail || 'Summarizing the active thread before continuing.')
      : (data?.detail || 'Conversation history is ready for the next turn.');
    const barClass = hasPercent ? 'compaction-progress-bar' : 'compaction-progress-bar is-indeterminate';
    const fillStyle = hasPercent ? ` style="width: ${percent}%;"` : '';
    const spinnerMarkup = isActive ? '<div class="status-spinner"></div>' : '';

    el.innerHTML = `
      <div class="message-content compaction-content">
        <div class="compaction-row">
          ${spinnerMarkup}
          <span class="status-text compaction-title">${escapeHtml(data?.text || (isActive ? COMPACTION_ACTIVE_TEXT : COMPACTION_DONE_TEXT))}</span>
          <span class="compaction-percent">${escapeHtml(percentLabel)}</span>
        </div>
        <div class="${barClass}" role="progressbar" aria-label="Conversation compaction progress" aria-valuemin="0" aria-valuemax="100"${hasPercent ? ` aria-valuenow="${Math.round(percent)}"` : ''}>
          <div class="compaction-progress-fill"${fillStyle}></div>
        </div>
        <div class="compaction-detail">${escapeHtml(detail)}</div>
      </div>
    `;

    return el;
  }

  buildCompactionProgressFromUsage(usage) {
    if (!usage) return null;
    const percent = clampPercent(usage.usedPercentage);
    const usedLabel = formatCompactTokens(usage.usedTokens);
    const maxLabel = formatCompactTokens(usage.maxTokens);
    const processedLabel = formatCompactTokens(usage.totalProcessedTokens);

    const progress = {
      progressPercent: percent,
      progressLabel: percent !== null ? `${Math.round(percent)}% context` : '',
      detail: '',
    };

    if (usedLabel && maxLabel) {
      progress.detail = `Context before compaction: ${usedLabel}/${maxLabel} tokens.`;
    } else if (usedLabel) {
      progress.detail = `Context before compaction: ${usedLabel} tokens.`;
    }

    if (processedLabel && usedLabel && processedLabel !== usedLabel) {
      progress.detail = progress.detail
        ? `${progress.detail} Total processed: ${processedLabel}.`
        : `Total processed: ${processedLabel} tokens.`;
    }

    return progress;
  }

  beginCompactionInChat(chatId) {
    if (!chatId) return;
    const chat = store.getChatById(chatId);
    if (!chat) return;

    this.ensureTimelineForChat(chat);
    const hasActiveCompaction = chat.timeline.some(item => item.type === 'compaction' && item.finalized !== true);
    if (hasActiveCompaction) return;

    const item = {
      type: 'compaction',
      text: COMPACTION_ACTIVE_TEXT,
      detail: 'Summarizing the active thread before continuing.',
      progressPercent: null,
      progressLabel: '',
      finalized: false,
    };
    this.addToTimeline(item, chat);

    if (store.get('activeChatId') === chatId) {
      const container = document.getElementById('messages');
      if (!container) return;
      container.appendChild(this.createCompactionElement(item));
      scrollChatMessagesToEnd();
      this.enforceLiveMountedItemCap();
    }
  }

  updateCompactionProgressInChat(chatId, usage) {
    if (!chatId) return false;
    const chat = store.getChatById(chatId);
    if (!chat?.timeline) return false;

    const progress = this.buildCompactionProgressFromUsage(usage);
    if (!progress) return false;

    for (let i = chat.timeline.length - 1; i >= 0; i--) {
      const item = chat.timeline[i];
      if (item.type === 'compaction' && item.finalized !== true) {
        item.progressPercent = progress.progressPercent;
        item.progressLabel = progress.progressLabel;
        item.detail = progress.detail || item.detail;
        this.app.projectManager.markChatForFullUpdate(chatId);
        this.app.saveChats();

        if (store.get('activeChatId') === chatId) {
          const container = document.getElementById('messages');
          const domNode = container?.querySelector(`.message-compaction[data-compaction-id="${item.id}"]`);
          if (domNode) {
            domNode.replaceWith(this.createCompactionElement(item));
          }
        }
        return true;
      }
    }

    return false;
  }

  finalizeCompactionInChat(chatId) {
    if (!chatId) return false;
    const chat = store.getChatById(chatId);
    if (!chat?.timeline) return false;

    for (let i = chat.timeline.length - 1; i >= 0; i--) {
      const item = chat.timeline[i];
      if (item.type === 'compaction' && item.finalized !== true) {
        item.finalized = true;
        item.text = COMPACTION_DONE_TEXT;
        item.progressPercent = 100;
        item.progressLabel = 'Done';
        item.detail = 'Conversation history is ready for the next turn.';
        this.app.projectManager.markChatForFullUpdate(chatId);
        this.app.saveChats();

        if (store.get('activeChatId') === chatId) {
          const container = document.getElementById('messages');
          const domNode = container?.querySelector(`.message-compaction[data-compaction-id="${item.id}"]`);
          if (domNode) {
            domNode.replaceWith(this.createCompactionElement(item));
          }
        }
        return true;
      }
    }

    return false;
  }

  // Codex "thinking" stream update: cumulative public reasoning summary text
  // for one (item_id, summary_index) part. The block's timeline item and DOM
  // node update in place — a delta never appends a timeline row.
  upsertThinkingInChat(chatId, update) {
    if (!chatId || !update) return false;
    const chat = store.getChatById(chatId);
    if (!chat) return false;
    this.ensureTimelineForChat(chat);

    const result = upsertThinkingTimelineItem(chat, update);
    if (!result) return false;
    const { item, createdItem, changed } = result;

    if (createdItem) {
      this.addToTimeline(item, chat);
    } else if (changed && update.completed) {
      // In-place part mutations are invisible to the incremental sync queue;
      // a completed part is the durable milestone worth a full-chat save
      // (per-delta saves would re-serialize the whole chat on every token).
      this.app.projectManager.markChatForFullUpdate(chat.id);
      this.app.saveChats();
    }

    // "Hide Thinking": the timeline keeps recording summaries (above), but
    // nothing mounts in the DOM and the bare "Thinking" working pill remains
    // the only sign of activity.
    if (isHideThinkingEnabled()) return true;

    const headline = getThinkingStatusHeadline(item);
    if (headline) {
      item.statusHeadline = headline;
      this.removeThinkingBlockElement(item.id, chatId);
      this.app.statusManager?.showThinkingHeadline?.(chatId, item.id, headline, { final: update.completed === true });
      return true;
    }

    // An item can begin as an eligible bold headline, then grow into ordinary
    // or multiline markdown. Retire the replacement status without finalizing
    // it, mount the full block with the authoritative cumulative text, and keep
    // subsequent updates on the existing block path.
    if (item.statusHeadline) {
      delete item.statusHeadline;
      this.dismissThinkingHeadlineStatus(chat, item.id);
    } else if (createdItem) {
      this.dismissThinkingStatusHint(chat);
    }

    if (store.get('activeChatId') === chatId && item.id) {
      const container = document.getElementById('messages');
      if (container) {
        const streaming = store.isChatProcessing(chatId) && isThinkingItemStreaming(item);
        let el = container.querySelector(`.message-thinking[data-thinking-id="${item.id}"]`);
        if (el) {
          syncThinkingElement(el, item, { streaming });
        } else {
          el = createThinkingElement(item, { streaming });
          container.appendChild(el);
          this.enforceLiveMountedItemCap();
        }
        // Unforced: no-op while the user is reading older messages.
        scrollChatMessagesToEnd();
      }
    }
    return true;
  }

  removeThinkingBlockElement(itemId, chatId) {
    if (!itemId || store.get('activeChatId') !== chatId) return;
    document.querySelector(`#messages .message-thinking[data-thinking-id="${itemId}"]`)?.remove();
  }

  dismissThinkingHeadlineStatus(chat, itemId) {
    if (!chat || !itemId) return;
    this.app.statusManager?.clearThinkingHeadline?.(chat.id);
    const timeline = Array.isArray(chat.timeline) ? chat.timeline : [];
    let removed = false;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const entry = timeline[i];
      if (entry?.type === 'user' && entry.bubbleVariant !== 'steer') break;
      if (entry?.type === 'status' && entry.thinkingItemId === itemId) {
        timeline.splice(i, 1);
        removed = true;
      }
    }
    if (removed) {
      this.app.projectManager.markChatForFullUpdate(chat.id);
      this.app.saveChats();
    }

    if (store.get('activeChatId') !== chat.id) return;
    document.querySelectorAll('#messages .message-status.status-thinking-headline')
      .forEach((el) => {
        if (el.dataset.thinkingItemId === itemId) el.remove();
      });
  }

  hasStreamingThinking(chatId) {
    if (!chatId) return false;
    // With "Hide Thinking" on, the detailed block never mounts, so the bare
    // "Thinking" working pill must not be suppressed as a duplicate.
    if (isHideThinkingEnabled()) return false;
    return hasStreamingThinkingItem(store.getChatById(chatId));
  }

  // Retire the generic bare "Thinking" working-hint pill once the detailed
  // block has real summary text — showing both reads as a duplicate. Only the
  // bare label goes; detailed hints (tool labels) are untouched.
  dismissThinkingStatusHint(chat) {
    if (!chat) return;
    const timeline = Array.isArray(chat.timeline) ? chat.timeline : [];
    for (let i = timeline.length - 1; i >= 0; i--) {
      const entry = timeline[i];
      if (entry?.type === 'user' && entry.bubbleVariant !== 'steer') break;
      if (entry?.type === 'status' && !entry.finalized && typeof entry.text === 'string'
        && entry.text.trim() === 'Thinking' && !entry.thinkingHeadline) {
        timeline.splice(i, 1);
        this.app.projectManager.markChatForFullUpdate(chat.id);
        this.app.saveChats();
        if (store.get('activeChatId') === chat.id && entry.id) {
          document.querySelector(`#messages .message-status[data-status-id="${entry.id}"]`)?.remove();
        }
        break;
      }
    }

    if (store.get('activeChatId') !== chat.id) return;
    const container = document.getElementById('messages');
    if (!container) return;
    container.querySelectorAll('.message-status.status-active:not(.message-compaction)').forEach((el) => {
      if (el.dataset.label === 'Thinking' && !(el.dataset.detail || '')) {
        el.remove();
      }
    });
  }

  // Turn-terminal cleanup: mark every part completed so hydration/re-renders
  // never resurrect a streaming affordance, strip the live shimmer, and fold
  // the block away — the response has arrived, so the reasoning summary
  // collapses to its header. A block the user explicitly toggled keeps their
  // choice.
  finalizeThinkingInChat(chatId) {
    if (!chatId) return false;
    const chat = store.getChatById(chatId);
    if (!chat?.timeline) return false;

    let changed = false;
    const collapsedIds = [];
    for (const item of chat.timeline) {
      if (item?.type !== 'thinking') continue;
      if (Array.isArray(item.parts)) {
        for (const part of item.parts) {
          if (part && part.completed !== true) {
            part.completed = true;
            changed = true;
          }
        }
      }
      if (item.userToggled !== true && item.collapsed !== true) {
        item.collapsed = true;
        if (item.id) collapsedIds.push(item.id);
        changed = true;
      }
    }

    if (changed) {
      this.app.projectManager.markChatForFullUpdate(chatId);
      this.app.saveChats();
    }

    this.app.statusManager?.clearThinkingHeadline?.(chatId);

    if (store.get('activeChatId') === chatId) {
      document.querySelectorAll('#messages .message-thinking.thinking-streaming')
        .forEach((el) => el.classList.remove('thinking-streaming'));
      for (const id of collapsedIds) {
        const el = document.querySelector(`#messages .message-thinking[data-thinking-id="${id}"]`);
        if (!el) continue;
        el.classList.add('collapsed');
        el.querySelector('.thinking-header')?.setAttribute('aria-expanded', 'false');
      }
    }
    return changed;
  }

  // Render a compact answered-question summary for the chat timeline
  createAnsweredSummary(item) {
    const el = document.createElement('div');
    el.className = 'qw-answered-summary';

    const questions = item.questions || [];
    const answers = item.answers || {};

    for (const q of questions) {
      const pair = document.createElement('div');
      pair.className = 'qw-answered-pair';

      const qLabel = document.createElement('span');
      qLabel.className = 'qw-answered-q';
      qLabel.textContent = (q.header || 'Q') + ':';

      const aText = document.createElement('span');
      aText.className = 'qw-answered-a';

      // answers is keyed by question text, value is a plain string
      const answerStr = answers[q.question] || '(no answer)';
      aText.textContent = `${q.question} \u2192 ${answerStr}`;

      pair.appendChild(qLabel);
      pair.appendChild(aText);
      el.appendChild(pair);
    }

    return el;
  }

  appendDiffElement(diffContent, messageIndex, options = {}) {
    // render() passes a finished turn's work block body.
    const container = options.container || document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML = this.app.diffPreview.renderMessage(diffContent, options.startExpanded !== false);

    // Add toggle functionality
    const toggleBtn = div.querySelector('.inline-diff-toggle');
    const inlineDiff = div.querySelector('.inline-diff');
    if (toggleBtn && inlineDiff) {
      toggleBtn.onclick = () => {
        inlineDiff.classList.toggle('collapsed');
      };
    }

    const diffData = typeof diffContent === 'string' ? JSON.parse(diffContent) : diffContent;
    const scriptPath = diffData?.path || diffData?.fileName;
    this.app.diffPreview.bindOpenInStudioTriggers(div, diffData, scriptPath);

    container.appendChild(div);
  }

  // Add item to timeline
  addToTimeline(item, chat = null) {
    // If no explicit chat provided, use activeChat from store
    const targetChat = chat || store.getActiveChat();
    if (!targetChat) return null;

    this.ensureTimelineForChat(targetChat);

    // Generate unique ID for all items (if not already set)
    if (!item.id) {
      item.id = `${item.type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    // Prevent duplicate user messages (same content within 5 seconds)
    if (item.type === 'user') {
      this.app.resetTurnActionCost(targetChat.id);
      const incomingImages = Array.isArray(item.images) ? item.images : [];
      const recentUserItems = targetChat.timeline.filter(i =>
        i.type === 'user' &&
        i.content === item.content &&
        this.userImagesMatch(i.images, incomingImages) &&
        i.timestamp && (Date.now() - i.timestamp) < 5000
      );
      if (recentUserItems.length > 0) {
        console.warn('[TIMELINE] Blocked duplicate user message:', String(item.content || '').substring(0, 50));
        return null; // Don't add duplicate
      }
    }

    // Prevent duplicate plan-mode status assistant lines (same content within 4 seconds).
    if (item.type === 'assistant' && typeof item.content === 'string') {
      const normalized = item.content.trim();
      if (PLAN_MODE_STATUS_TEXTS.has(normalized)) {
        const recentAssistantItems = targetChat.timeline.filter(i =>
          i.type === 'assistant' &&
          typeof i.content === 'string' &&
          i.content.trim() === normalized &&
          i.timestamp && (Date.now() - i.timestamp) < 4000
        );
        if (recentAssistantItems.length > 0) {
          console.warn('[TIMELINE] Blocked duplicate plan-mode status:', normalized);
          return null;
        }
      }
    }

    item.timestamp = Date.now();
    targetChat.timeline.push(item);

    if (item.type === 'playtest') {
      console.log('[TIMELINE] Added playtest to chat:', targetChat.id, 'timeline length:', targetChat.timeline.length);
    }

    // Queue this message for incremental sync
    this.app.projectManager.queueMessage(targetChat.id, item);

    this.app.saveChats();
    return item;
  }

  addUserMessage(content) {
    const activeChat = store.getActiveChat();
    if (!activeChat) return;
    this.app.resetTurnActionCost(activeChat.id);

    // Check if this is the first content message (triggers welcome fade out)
    const hadContent = activeChat.timeline.some(item =>
      item.type === 'user' || item.type === 'assistant' || item.type === 'emit' || item.type === 'diff'
    );

    const item = this.addToTimeline({ type: 'user', content });
    if (!item) return;

    // Fade out welcome on first message
    if (!hadContent) {
      this.fadeOutChatWelcome();
    }

    // Update chat title if first user message
    const userMessages = activeChat.timeline.filter(i => i.type === 'user');
    if (userMessages.length === 1) {
      const newTitle = content.substring(0, 40) + (content.length > 40 ? '...' : '');
      activeChat.title = newTitle;
      this.app.projectManager.queueTitleUpdate(activeChat.id, newTitle);
      this.app.projectManager.renderList();
    }

    // The user's own message always pins the view, even if they had scrolled up.
    this.appendElement('user', content, 'normal', null, false, [], { timelineItemId: item?.id, forceScroll: true });
  }

  addAssistantMessage(content) {
    if (!store.getActiveChat()) return;
    const activeChat = store.getActiveChat();
    const actionCost = this.app.getTurnActionCost(activeChat.id);
    const actionCostMeta = this.getCurrentActionCostMeta(activeChat.id);
    const item = this.addToTimeline({ type: 'assistant', content, actionCost, ...actionCostMeta });
    if (!item) return;
    this.appendElement('assistant', content, 'normal', null, true, [], { actionCost, ...actionCostMeta, timelineItemId: item?.id });
  }

  addEmitMessage(content) {
    if (!store.getActiveChat()) return;
    const activeChat = store.getActiveChat();

    let text = '';
    try {
      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      text = parsed.message || parsed.text || String(content);
    } catch {
      text = String(content);
    }

    const actionCost = this.app.getTurnActionCost(activeChat.id);
    const actionCostMeta = this.getCurrentActionCostMeta(activeChat.id);
    const item = this.addToTimeline({ type: 'emit', content: text, actionCost, ...actionCostMeta });
    if (!item) return;
    this.appendElement('assistant', text, 'emit', null, false, [], { actionCost, ...actionCostMeta, timelineItemId: item?.id });
  }

  addEmitMessageToChat(content, targetChat) {
    if (!targetChat) return;

    let text = '';
    try {
      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      text = parsed.message || parsed.text || String(content);
    } catch {
      text = String(content);
    }

    const actionCost = this.app.getTurnActionCost(targetChat.id);
    const actionCostMeta = this.getCurrentActionCostMeta(targetChat.id);
    const item = this.addToTimeline({ type: 'emit', content: text, actionCost, ...actionCostMeta }, targetChat);
    if (!item) return;

    if (store.get('activeChatId') === targetChat.id) {
      this.appendElement('assistant', text, 'emit', null, false, [], { actionCost, ...actionCostMeta, timelineItemId: item?.id });
    }
  }

  addAgentTextMessage(content, targetChat) {
    if (!targetChat) return;
    const actionCost = this.app.getTurnActionCost(targetChat.id);
    const actionCostMeta = this.getCurrentActionCostMeta(targetChat.id);

    // Agent text messages show thinking/intermediate steps
    // Add as regular assistant messages to the timeline
    const item = this.addToTimeline({ type: 'assistant', content, actionCost, ...actionCostMeta }, targetChat);
    if (!item) return;

    if (store.get('activeChatId') === targetChat.id) {
      this.appendElement('assistant', content, 'normal', null, false, [], { actionCost, ...actionCostMeta, timelineItemId: item?.id });
    }
  }

  addErrorMessage(error) {
    this.addErrorMessageToChat(error, store.getActiveChat(), true);
  }

  addErrorMessageToChat(error, targetChat, shouldUpdateUI, options = {}) {
    if (!targetChat) return;
    const cta = typeof options.cta === 'string'
      ? options.cta
      : (options.showReturnToLogin === true ? 'return_to_login_screen' : undefined);
    const ctaProvider = options.showReturnToLogin === true ? options.returnToLoginProvider : options.ctaProvider;
    this.addToTimeline({
      type: 'error',
      content: error,
      noteTitle: typeof options.noteTitle === 'string' ? options.noteTitle : undefined,
      noteMessage: typeof options.noteMessage === 'string' ? options.noteMessage : undefined,
      noteLink: this.normalizeNoteLink(options.noteLink),
      cta,
      ctaProvider
    }, targetChat);
    if (shouldUpdateUI) {
      const container = document.getElementById('messages');
      const errorEl = this.createErrorElement(error, {
        ...options,
        cta,
        ctaProvider,
        // This path only runs for errors arriving in the live session
        // (timeline re-renders go through render() instead), so the
        // route-retry autopilot may arm its countdown here.
        liveRouteFailure: cta === 'retry_ropilot_credits_route'
      });
      container.appendChild(errorEl);
      scrollChatMessagesToEnd();
      this.enforceLiveMountedItemCap();
    }
  }

  // Notes are escaped wholesale, so a link can only come in through the
  // noteLink option — and only for the allowlisted status-page hrefs.
  normalizeNoteLink(noteLink) {
    const href = typeof noteLink?.href === 'string' ? noteLink.href.trim() : '';
    if (!NOTE_LINK_ALLOWED_HREFS.has(href)) return undefined;
    const label = typeof noteLink.label === 'string' && noteLink.label.trim() !== ''
      ? noteLink.label.trim()
      : href;
    return { href, label };
  }

  buildNoteLinkMarkup(noteLink) {
    const link = this.normalizeNoteLink(noteLink);
    if (!link) return '';
    return ` <a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`;
  }

  createErrorElement(errorText, options = {}) {
    const div = document.createElement('div');
    div.className = 'message assistant';
    const cta = typeof options.cta === 'string'
      ? options.cta
      : (options.showReturnToLogin === true ? 'return_to_login_screen' : '');
    if (cta === 'retry_ropilot_credits_route') {
      // Route failures render as one quiet, status-weight line (the
      // auto-retry usually recovers in seconds — no loud wall, no bold
      // note, no duplicated error text). Success later removes the line
      // entirely; see RouteRetryAutopilot.clearFailureDebris.
      return this.createRouteFailureElement(options);
    }
    if (cta === 'retry_degeneration_recovery') {
      // Degeneration-guard stop: same quiet presentation as a route
      // failure. The Go server already quarantined the poisoned thread and
      // the handler auto-retries once, so most users see this line resolve
      // itself; the button covers the manual case (second failure, offline,
      // low balance).
      return this.createDegenerationRecoveryElement(errorText);
    }
    const returnToLoginProvider = cta === 'return_to_login_screen'
      ? this.inferReturnToLoginProvider(options.returnToLoginProvider || options.ctaProvider)
      : (options.returnToLoginProvider || options.ctaProvider);
    const isCodexLoginCta = cta === 'return_to_login_screen' && returnToLoginProvider === 'codex';
    const isClaudeLoginCta = cta === 'return_to_login_screen' && returnToLoginProvider === 'claude';
    const isProviderSetupCta = cta === 'return_to_provider_setup';
    const noteTitle = typeof options.noteTitle === 'string' ? options.noteTitle.trim() : '';
    const noteMessage = typeof options.noteMessage === 'string' ? options.noteMessage.trim() : '';
    const noteMarkup = noteMessage
      ? `<div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); white-space: pre-wrap;"><strong>${escapeHtml(noteTitle || '[Note from Ropilot]')}</strong> ${escapeHtml(noteMessage)}${this.buildNoteLinkMarkup(options.noteLink)}</div>`
      : '';
    const authExpiredMarkup = cta === 'return_to_login_screen'
      ? `<div class="auth-expired-cta-message" style="margin-top: 8px; color: var(--error); font-weight: 600;">${this.getReturnToLoginExpiryMessageHtml(returnToLoginProvider)}</div>`
      : '';
    const actionMarkup = cta === 'return_to_login_screen'
      ? `<button class="btn btn-secondary return-login-btn" style="margin-top: 8px;">${isCodexLoginCta ? 'Log in with ChatGPT' : isClaudeLoginCta ? 'Log in again' : 'Return to AI Providers Screen'}</button>${isCodexLoginCta ? '<div class="auth-login-cta-status" style="margin-top: 6px; color: var(--text-secondary); font-size: 12px;"></div>' : ''}`
      : cta === 'switch_to_gpt56terra_codex_and_retry'
        ? '<button class="btn btn-secondary switch-codex-retry-btn" style="margin-top: 8px;">Use GPT 5.6 Terra and retry</button>'
        : cta === 'reinstall_claude_cli'
          ? '<button class="btn btn-secondary reinstall-claude-btn" style="margin-top: 8px;">Reinstall Claude Code</button><div class="reinstall-claude-status" style="margin-top: 6px; color: var(--text-secondary); font-size: 12px;"></div>'
          : isProviderSetupCta
            ? '<button class="btn btn-secondary provider-setup-btn" style="margin-top: 8px;">Open AI Providers Screen</button>'
            : '';

    div.innerHTML = `
      <div class="message-content" style="border-left: 3px solid var(--error);">
        <div>${escapeHtml(errorText)}</div>
        ${noteMarkup}
        ${authExpiredMarkup}
        ${actionMarkup}
      </div>
    `;
    // Bind the (allowlisted) note link to openExternal like other message links.
    this.enhanceMessageLinks(div);
    if (cta === 'return_to_login_screen') {
      div.querySelector('.return-login-btn')?.addEventListener('click', () => {
        if (returnToLoginProvider === 'codex' && typeof this.app.startCodexBrowserLoginFromChat === 'function') {
          this.startCodexLoginFromChatCta(div);
          return;
        }
        if (returnToLoginProvider === 'claude') {
          this.app.returnToLoginScreen(returnToLoginProvider, {
            forceProviderAuth: true,
            openLogin: true,
          });
          return;
        }
        this.app.returnToLoginScreen(returnToLoginProvider);
      });
    }
    if (isProviderSetupCta) {
      div.querySelector('.provider-setup-btn')?.addEventListener('click', () => {
        this.app.returnToLoginScreen(returnToLoginProvider || 'codex');
      });
    }
    if (cta === 'switch_to_gpt56terra_codex_and_retry') {
      div.querySelector('.switch-codex-retry-btn')?.addEventListener('click', () => {
        this.app.retryCodexPlanRestrictedFailureWithGpt56Terra();
      });
    }
    if (cta === 'reinstall_claude_cli') {
      div.querySelector('.reinstall-claude-btn')?.addEventListener('click', () => {
        this.reinstallClaudeCliFromChatCta(div);
      });
    }
    return div;
  }

  // Quiet one-line presentation for a degeneration-guard stop, reusing the
  // route-failure styling. The retry button dispatches through the same
  // handler the automatic recovery uses.
  createDegenerationRecoveryElement(errorText) {
    const div = document.createElement('div');
    div.className = 'message assistant route-failure-note';
    const text = typeof errorText === 'string' && errorText.trim()
      ? errorText.trim()
      : 'OpenAI services are having issues — please try again in a moment.';
    div.innerHTML = `
      <div class="route-failure-line">
        <span class="route-failure-text"></span>
        <button class="route-failure-retry retry-degeneration-btn" type="button">Retry now</button>
      </div>
    `;
    div.querySelector('.route-failure-text').textContent = text;
    div.querySelector('.retry-degeneration-btn')?.addEventListener('click', () => {
      this.app.retryDegenerationRecovery?.();
    });
    return div;
  }

  // Quiet one-line presentation for Standard route failures. Deliberately
  // status-weight (same register as "Thought for 16s"): secondary color,
  // small type, inline text-style retry — a distracted user can scan
  // straight past it while the autopilot recovers the turn.
  createRouteFailureElement(options = {}) {
    const div = document.createElement('div');
    div.className = 'message assistant route-failure-note';
    // Vendor-outage hint renders on its own line, OUTSIDE
    // .route-failure-text — the autopilot rewrites that span's textContent
    // (countdown/resting/paused copy) and must never clobber the link.
    const noteLink = this.normalizeNoteLink(options.noteLink);
    const vendorName = noteLink ? NOTE_LINK_ALLOWED_HREFS.get(noteLink.href) : '';
    const vendorHintMarkup = noteLink
      ? `<div class="route-failure-line route-failure-vendor-hint">If this keeps happening, ${escapeHtml(vendorName)} may be having an outage: check <a href="${escapeHtml(noteLink.href)}">${escapeHtml(noteLink.label)}</a></div>`
      : '';
    div.innerHTML = `
      <div class="route-failure-line">
        <span class="route-failure-text">Standard hit a snag with this request.</span>
        <button class="route-failure-retry retry-route-economy-btn" type="button">Retry now</button>
        <span class="route-retry-attempts" hidden></span>
      </div>
      ${vendorHintMarkup}
    `;
    this.enhanceMessageLinks(div);
    div.querySelector('.retry-route-economy-btn')?.addEventListener('click', () => {
      // Manual click cancels any pending countdown and retries now,
      // through the same dispatch path as the auto-retry.
      if (this.app.routeRetryAutopilot) {
        this.app.routeRetryAutopilot.fire('manual');
      } else {
        this.app.retryRopilotCreditsRouteFailure?.('economy');
      }
    });
    // Live notes (fresh failures this session) arm the auto-retry
    // countdown; re-rendered/restored notes stay manual-only.
    this.app.routeRetryAutopilot?.registerNote(div, { live: options.liveRouteFailure === true });
    return div;
  }

  async reinstallClaudeCliFromChatCta(container) {
    const button = container.querySelector('.reinstall-claude-btn');
    const status = container.querySelector('.reinstall-claude-status');
    if (!button || button.disabled) return;

    button.disabled = true;
    button.textContent = 'Reinstalling Claude Code...';
    if (status) {
      status.style.color = 'var(--text-secondary)';
      status.textContent = 'Downloading the latest official build and verifying it — this can take a minute.';
    }

    try {
      const result = await this.app.setupFlow.reinstallClaudeCliViaGo({
        onProgress: (update) => {
          if (status) {
            status.textContent = this.app.setupFlow.formatClaudeReinstallProgress(update);
          }
        },
      });
      if (!result?.success) {
        throw new Error(result?.error || 'Claude Code reinstall failed.');
      }
      button.textContent = 'Claude Code reinstalled';
      if (status) {
        status.style.color = 'var(--success)';
        status.textContent = `Reinstalled and verified${result.version ? ` (${result.version})` : ''} — retry your message.`;
      }
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Try reinstalling again';
      if (status) {
        status.style.color = 'var(--error)';
        status.textContent = err?.message || 'Claude Code reinstall failed.';
      }
    }
  }

  async startCodexLoginFromChatCta(container) {
    const button = container.querySelector('.return-login-btn');
    const status = container.querySelector('.auth-login-cta-status');
    if (!button) return;

    const defaultText = 'Log in with ChatGPT';
    button.disabled = true;
    button.textContent = 'Opening ChatGPT sign-in...';
    if (status) {
      status.textContent = '';
    }

    try {
      const result = await this.app.startCodexBrowserLoginFromChat();
      if (!result?.success) {
        throw new Error(result?.error || 'Could not open ChatGPT sign-in.');
      }

      button.textContent = result.already_running ? 'ChatGPT sign-in already open' : 'ChatGPT sign-in opened';
      if (status) {
        status.textContent = 'Complete the OpenAI login in your browser, then return here and retry your message.';
      }
      setTimeout(() => {
        button.disabled = false;
        button.textContent = defaultText;
      }, 4000);
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Try ChatGPT login again';
      if (status) {
        status.textContent = err?.message || 'Could not open ChatGPT sign-in.';
      }
    }
  }

  inferReturnToLoginProvider(explicitProvider) {
    const normalize = (provider) => {
      const value = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
      if (value === 'codex' || value === 'openai') return 'codex';
      if (value === 'claude' || value === 'anthropic') return 'claude';
      return '';
    };

    let provider = normalize(explicitProvider);
    if (provider) return provider;

    if (typeof this.app?.getProviderForModel === 'function') {
      provider = normalize(this.app.getProviderForModel(this.app.selectedModel));
      if (provider) return provider;
    }

    const selectedModel = typeof this.app?.selectedModel === 'string'
      ? this.app.selectedModel.trim().toLowerCase()
      : '';
    if (selectedModel.startsWith('gpt-') || selectedModel.includes('codex')) {
      return 'codex';
    }
    if (
      selectedModel.includes('claude') ||
      selectedModel.includes('opus') ||
      selectedModel.includes('sonnet') ||
      selectedModel.includes('haiku') ||
      selectedModel.includes('fable')
    ) {
      return 'claude';
    }

    if (typeof this.app?.getChatProvider === 'function' && this.app.activeChat) {
      provider = normalize(this.app.getChatProvider(this.app.activeChat, this.app.modelProvider));
      if (provider) return provider;
    }

    provider = normalize(this.app?.modelProvider);
    return provider || 'codex';
  }

  getReturnToLoginExpiryMessageHtml(provider) {
    const accountName = provider === 'claude' ? 'Anthropic' : 'OpenAI';
    if (provider === 'codex') {
      return `Looks like your ${escapeHtml(accountName)} login expired. Click <strong>Log in with ChatGPT</strong> to open the OpenAI sign-in tab. If it still uses the wrong account, log out in that browser tab and try again.`;
    }
    return `Looks like your ${escapeHtml(accountName)} login expired. Please sign in again from the AI Providers Screen. If the terminal does not prompt you to sign in, run <code>/logout</code> and then <code>/login</code> in that provider's terminal.`;
  }

  // A screenshot the agent took, shown as a small inline image (timeline type
  // 'image': { path, caption, source }). The source only names it for screen
  // readers; the picture speaks for itself. Click opens the full-size preview.
  createChatImageElement(item = {}) {
    const div = document.createElement('div');
    div.className = 'message assistant chat-image-entry';
    const src = this.app.normalizeLocalPreviewSrc?.(item.path) || '';
    const label = item.source === 'blender' ? 'Blender render' : 'Studio screenshot';
    const caption = typeof item.caption === 'string' ? item.caption.trim() : '';
    const alt = caption ? `${label}: ${caption}` : label;
    div.innerHTML = `
      <figure class="chat-image">
        <button type="button" class="chat-image-button" aria-label="Open ${escapeHtml(alt)}">
          <img class="chat-image-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">
        </button>
        ${caption ? `<figcaption class="chat-image-caption"><span class="chat-image-text">${escapeHtml(caption)}</span></figcaption>` : ''}
      </figure>
    `;
    div.querySelector('.chat-image-button')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.app.openImagePreview?.(src, alt);
    });
    return div;
  }

  // Live path: a chat_image arrived for the chat on screen.
  appendChatImageElement(item) {
    const container = document.getElementById('messages');
    if (!container) return null;
    const pinned = isChatScrollPinnedToBottom();
    const el = this.createChatImageElement(item);
    container.appendChild(el);
    if (pinned) scrollChatMessagesToEnd();
    return el;
  }

  createRawHtmlElement(item = {}) {
    const div = document.createElement('div');
    div.className = 'message assistant raw-html-entry';

    const content = document.createElement('div');
    content.className = 'message-content raw-html-content';

    const subtype = typeof item.subtype === 'string'
      ? item.subtype.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
      : '';
    if (subtype) {
      content.classList.add(`raw-html-${subtype}`);
    }

    const rawHtml = typeof item.html === 'string' ? item.html : '';
    if (rawHtml.trim()) {
      content.innerHTML = rawHtml;
    } else {
      content.textContent = typeof item.text === 'string' ? item.text : '';
    }

    div.appendChild(content);
    return div;
  }

  formatRopilotActionCost(actionCost = 0) {
    const numericCost = Number.isFinite(actionCost) ? actionCost : Number(actionCost);
    if (!Number.isFinite(numericCost)) return '0';
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(numericCost);
  }

  getCurrentActionCostMeta(chatId = null) {
    const storedMeta = this.app?.getStoredTurnActionCostMeta?.(chatId);
    if (storedMeta && typeof storedMeta === 'object') {
      return { ...storedMeta };
    }
    const appMeta = this.app?.getTurnActionCostMeta?.();
    if (appMeta && typeof appMeta === 'object') {
      return { ...appMeta };
    }
    const useRopilotCredits = this.app?.isUseRopilotCreditsEnabled?.() === true
      || this.app?.useRopilotCredits === true;

    return {
      actionCostLabel: useRopilotCredits ? 'Ropilot Credits' : 'Ropilot Actions',
      actionCostBalanceType: useRopilotCredits ? 'managed_ai_credits' : 'ropilot_actions',
      useRopilotCredits,
    };
  }

  getActionCostLabel(options = {}) {
    const explicitLabel = typeof options.actionCostLabel === 'string' ? options.actionCostLabel.trim() : '';
    if (explicitLabel) return explicitLabel;

    const balanceType = typeof options.actionCostBalanceType === 'string'
      ? options.actionCostBalanceType.trim()
      : '';
    if (balanceType === 'managed_ai_credits') return 'Ropilot Credits';

    if (options.useRopilotCredits === true || options.use_ropilot_credits === true) {
      return 'Ropilot Credits';
    }

    return this.getCurrentActionCostMeta().actionCostLabel;
  }

  // Compact turn duration: 42s, 1m24s, 1h05m
  formatTurnDuration(ms) {
    const totalSeconds = Math.round(Number(ms) / 1000);
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
    }
    return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
  }

  createAssistantActionInfo(actionCost = 0, options = {}) {
    const meta = document.createElement('div');
    meta.className = 'message-action-meta';
    const duration = this.formatTurnDuration(options.actionDurationMs);
    meta.textContent = `${this.formatRopilotActionCost(actionCost)} ${this.getActionCostLabel(options)} used${duration ? ` · ${duration}` : ''}`;
    return meta;
  }

  getActionInfoItems(timeline = []) {
    const items = new Set();
    let currentTurnCandidate = null;

    for (const item of timeline) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'user') {
        if (currentTurnCandidate) items.add(currentTurnCandidate);
        currentTurnCandidate = null;
        continue;
      }

      const isAssistantMessage = item.type === 'assistant' || item.type === 'emit';
      const actionCost = item.actionCost ?? item.actionCount ?? 0;
      if (isAssistantMessage && Number(actionCost) > 0) {
        currentTurnCandidate = item;
      }
    }

    if (currentTurnCandidate) items.add(currentTurnCandidate);
    return items;
  }

  syncLatestTurnActionCost(chatId, durationMs = null) {
    const chat = store.getChatById(chatId);
    if (!chat?.timeline) return;

    const totalCost = this.app.getTurnActionCost(chatId);
    if (!Number.isFinite(totalCost) || totalCost <= 0) return;

    for (let i = chat.timeline.length - 1; i >= 0; i -= 1) {
      const item = chat.timeline[i];
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'user') break;

      if (item.type === 'assistant' || item.type === 'emit') {
        item.actionCost = totalCost;
        if (Number.isFinite(durationMs) && durationMs > 0) {
          item.actionDurationMs = Math.round(durationMs);
        }
        Object.assign(item, this.getCurrentActionCostMeta(chatId));
        if (store.get('activeChatId') === chatId) {
          if (!this.syncAssistantActionInfoInDom(chatId, item.id, totalCost, item)) {
            this.render();
          }
        } else {
          this.app.projectManager.markChatForFullUpdate(chatId);
          this.app.saveChats();
        }
        return;
      }
    }
  }

  addCompletedTurnActionCost(chatId, messageIndex, deltaCost, meta = {}) {
    const chat = store.getChatById(chatId);
    const targetIndex = Number(messageIndex);
    const delta = Number(deltaCost);
    if (!Array.isArray(chat?.timeline) || !Number.isInteger(targetIndex) || targetIndex <= 0
      || !Number.isFinite(delta) || delta === 0) {
      return false;
    }

    let seenUsers = 0;
    let turnStart = -1;
    let turnEnd = chat.timeline.length;
    for (let i = 0; i < chat.timeline.length; i += 1) {
      if (chat.timeline[i]?.type !== 'user') continue;
      seenUsers += 1;
      if (seenUsers === targetIndex) {
        turnStart = i;
      } else if (seenUsers === targetIndex + 1) {
        turnEnd = i;
        break;
      }
    }
    if (turnStart < 0) return false;

    for (let i = turnEnd - 1; i > turnStart; i -= 1) {
      const item = chat.timeline[i];
      if (item?.type !== 'assistant' && item?.type !== 'emit') continue;

      const existing = Number(item.actionCost ?? item.actionCount ?? 0);
      // A negative delta is a loop-guard refund; the chip never goes below 0.
      item.actionCost = Math.max(0, (Number.isFinite(existing) && existing > 0 ? existing : 0) + delta);
      Object.assign(item, meta);
      if (store.get('activeChatId') === chatId) {
        if (!this.syncAssistantActionInfoInDom(chatId, item.id, item.actionCost, item)) {
          this.render();
        }
      } else {
        this.app.projectManager.markChatForFullUpdate(chatId);
      }
      this.app.saveChats();
      return true;
    }

    return false;
  }

  clearTrailingAssistantActionInfo(container) {
    if (!container) return;

    const children = Array.from(container.children);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const el = children[i];
      if (!(el instanceof HTMLElement)) continue;
      if (el.classList.contains('message-status')) continue;
      if (el.classList.contains('user')) break;

      if (el.classList.contains('message-with-info')) {
        el.classList.remove('message-with-info');
        el.querySelector('.message-action-row')?.remove();
      }
    }
  }

  applyAssistantActionInfoToElement(messageEl, actionCost = 0, options = {}) {
    if (!(messageEl instanceof HTMLElement)) return false;
    if (messageEl.classList.contains('user') || messageEl.classList.contains('message-status')) return false;

    const parsedActionCost = Number(actionCost);
    messageEl.querySelector('.message-action-row')?.remove();
    messageEl.classList.remove('message-with-info');

    if (!Number.isFinite(parsedActionCost) || parsedActionCost <= 0) {
      return true;
    }

    messageEl.classList.add('message-with-info');
    const actionRow = document.createElement('div');
    actionRow.className = 'message-action-row';
    actionRow.appendChild(this.createAssistantActionInfo(parsedActionCost, options));
    messageEl.appendChild(actionRow);
    return true;
  }

  syncAssistantActionInfoInDom(chatId, itemId, actionCost = 0, options = {}) {
    if (!chatId || !itemId || store.get('activeChatId') !== chatId) return false;

    const container = document.getElementById('messages');
    if (!container) return false;

    const targetEl = Array.from(container.children).find((child) =>
      child instanceof HTMLElement && child.dataset.timelineItemId === itemId
    );
    if (!targetEl) return false;

    this.clearTrailingAssistantActionInfo(container);
    return this.applyAssistantActionInfoToElement(targetEl, actionCost, options);
  }

  appendElement(role, content, type = 'normal', messageIndex = null, isStreaming = false, images = [], options = {}) {
    // render() passes a turn's work block body for folded progress notes.
    const container = options?.container || document.getElementById('messages');
    const div = document.createElement('div');
    const isPlanModeStatusText =
      role === 'assistant' &&
      type === 'normal' &&
      typeof content === 'string' &&
      PLAN_MODE_STATUS_TEXTS.has(content.trim());

    // Live answer appends (render() re-inserts history itself with
    // skipScroll) draw the Codex-style work/answer rule when tool activity
    // preceded this message in the current turn.
    if (role === 'assistant' && !isPlanModeStatusText && options?.skipScroll !== true
      && typeof options?.timelineItemId === 'string') {
      const timeline = store.getActiveChat()?.timeline;
      if (Array.isArray(timeline)) {
        let itemIndex = -1;
        for (let i = timeline.length - 1; i >= 0; i--) {
          if (timeline[i]?.id === options.timelineItemId) {
            itemIndex = i;
            break;
          }
        }
        if (itemIndex !== -1
          && this.shouldInsertTurnSeparatorBefore(timeline, itemIndex)
          && !container.lastElementChild?.classList?.contains('turn-separator')) {
          container.appendChild(this.createTurnSeparatorElement());
        }
      }
    }

    let className = `message ${role}`;
    if (type === 'emit') className += ' emit';
    if (isStreaming && role === 'assistant') className += ' streaming';
    if (isPlanModeStatusText) className += ' message-status status-done';
    if (role === 'user' && typeof options?.bubbleVariant === 'string' && options.bubbleVariant.trim()) {
      className += ` user-bubble-${options.bubbleVariant.trim().toLowerCase()}`;
    }
    div.className = className;
    if (typeof options?.timelineItemId === 'string' && options.timelineItemId.trim()) {
      div.dataset.timelineItemId = options.timelineItemId;
    }

    if (role === 'user') {
      const activeChat = store.getActiveChat();
      const userMsgCount = (activeChat?.timeline || []).filter(i => i.type === 'user').length;
      const idx = messageIndex !== null ? messageIndex : Math.max(0, userMsgCount - 1);
      div.dataset.messageIndex = idx;
      const wrapper = document.createElement('div');
      wrapper.className = 'message-wrapper';

      const editBtn = document.createElement('button');
      editBtn.className = 'message-edit-btn';
      editBtn.title = 'Edit message';
      editBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 20h4L18.5 9.5a2.828 2.828 0 1 0-4-4L4 16v4"/>
          <path d="m13.5 6.5 4 4"/>
        </svg>
      `;
      editBtn.onclick = (e) => {
        e.stopPropagation();
        this.app.messageEditor.requestEdit(idx);
      };
      wrapper.appendChild(editBtn);

      const contentEl = document.createElement('div');
      contentEl.className = 'message-content';

      const messageImages = Array.isArray(images) ? images : [];
      if (messageImages.length > 0) {
        const imageGrid = document.createElement('div');
        imageGrid.className = 'message-image-grid';

        messageImages.forEach((image, imageIndex) => {
          if (!image || typeof image.data !== 'string' || typeof image.mime_type !== 'string') return;
          if (!image.mime_type.startsWith('image/')) return;

          const itemEl = document.createElement('div');
          itemEl.className = 'message-image-item';

          const imgEl = document.createElement('img');
          imgEl.src = `data:${image.mime_type};base64,${image.data}`;
          imgEl.alt = `Attached image ${imageIndex + 1}`;
          imgEl.loading = 'lazy';
          imgEl.addEventListener('click', () => this.app.openImagePreview(imgEl.src, imgEl.alt));

          itemEl.appendChild(imgEl);
          imageGrid.appendChild(itemEl);
        });

        if (imageGrid.childElementCount > 0) {
          contentEl.appendChild(imageGrid);
        }
      }

      const contentText = this.normalizeRenderedUserContent(content);
      const trimmedText = contentText.trim();
      const shouldHidePlaceholder = this.isImagePlaceholderText(trimmedText) && messageImages.length > 0;
      if (!shouldHidePlaceholder && trimmedText.length > 0) {
        const textEl = document.createElement('div');
        textEl.className = 'message-text';
        textEl.innerHTML = formatMessage(contentText);
        this.enhanceMessageLinks(textEl);
        contentEl.appendChild(textEl);
      }

      wrapper.appendChild(contentEl);
      div.appendChild(wrapper);
    } else {
      if (isPlanModeStatusText) {
        div.innerHTML = `
          <div class="message-content status-content">
            <span class="status-text">${escapeHtml(content)}</span>
          </div>
        `;
      } else {
        const parsedActionCost = Number(options?.actionCost);
        const shouldShowActionInfo =
          (type === 'normal' || type === 'emit') &&
          options &&
          Object.prototype.hasOwnProperty.call(options, 'actionCost') &&
          Number.isFinite(parsedActionCost) &&
          parsedActionCost > 0;
        const actionCost = shouldShowActionInfo ? parsedActionCost : 0;
        if (shouldShowActionInfo) {
          this.clearTrailingAssistantActionInfo(container);
          div.classList.add('message-with-info');
        }
        div.innerHTML = `<div class="message-content">${formatMessage(content)}</div>`;
        const contentEl = div.querySelector('.message-content');
        if (contentEl) {
          this.enhanceMessageLinks(contentEl);
        }
        if (shouldShowActionInfo) {
          const actionRow = document.createElement('div');
          actionRow.className = 'message-action-row';
          actionRow.appendChild(this.createAssistantActionInfo(actionCost, options));
          div.appendChild(actionRow);
        }
      }
    }

    container.appendChild(div);
    // Full render() scrolls once after its loop; only live appends scroll here.
    if (options?.skipScroll !== true) {
      scrollChatMessagesToEnd(options?.forceScroll === true ? { force: true } : {});
      this.enforceLiveMountedItemCap();
    }

    if (isStreaming) {
      setTimeout(() => {
        div.classList.remove('streaming');
      }, 300);
    }
  }

  normalizeRenderedUserContent(content) {
    const contentText = typeof content === 'string' ? content : String(content ?? '');
    const legacyStudioFixPrompt = this.extractLegacyStudioFixPrompt(contentText);
    return legacyStudioFixPrompt || contentText;
  }

  extractLegacyStudioFixPrompt(content) {
    if (typeof content !== 'string') return '';
    if (!content.includes('Use this Roblox Studio error output from the edge diagnostics stream to fix the issue in my project.')) {
      return '';
    }

    const errorMatch = content.match(/(?:^|\n)Error:\s*(.+)$/im);
    const rawMessage = errorMatch?.[1]?.trim() || '';
    const message = rawMessage.replace(/^Error:\s*/i, '').trim();
    return message ? `Fix with Ropilot: Error: ${message}` : 'Fix with Ropilot';
  }

  isImagePlaceholderText(text) {
    if (!text) return false;
    return /^\[(\d+\s+)?images?\s+attached\]$/i.test(text);
  }

  userImagesMatch(a, b) {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      const leftImg = left[i] || {};
      const rightImg = right[i] || {};
      const leftMime = leftImg.mime_type || '';
      const rightMime = rightImg.mime_type || '';
      const leftLen = typeof leftImg.data === 'string' ? leftImg.data.length : 0;
      const rightLen = typeof rightImg.data === 'string' ? rightImg.data.length : 0;
      const leftPrefix = typeof leftImg.data === 'string' ? leftImg.data.slice(0, 64) : '';
      const rightPrefix = typeof rightImg.data === 'string' ? rightImg.data.slice(0, 64) : '';
      if (leftMime !== rightMime || leftLen !== rightLen || leftPrefix !== rightPrefix) {
        return false;
      }
    }
    return true;
  }
}
