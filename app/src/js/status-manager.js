// Status Manager - handles status indicators in the chat
import { toPastTense, formatDuration, isTempPath, escapeHtml, getScriptIcon, highlightLua, inferScriptTypeFromPath, scrollChatMessagesToEnd, getChatMessagesScroller, isChatScrollPinnedToBottom } from './utils.js';
import { store } from './state-store.js';
import { matchSearchLabel, matchStepGroupKind, placeStatusElement, installSearchGroupToggle, refineSearchStepText } from './search-group.js';
import { isHideThinkingEnabled } from './thinking-block.js';
import { clearLiveBlenderPreview, createBlenderPreviewElement, installBlenderPreviews, showLiveBlenderPreview } from './blender-preview.js';

// Timestamp alone can collide now that search-like hints create one row per
// step (several can land in the same millisecond).
let statusIdSeq = 0;
const nextStatusId = () => `status-${Date.now()}-${++statusIdSeq}`;

// Expanded command chips render through utils.highlightLua — the same
// Studio-accurate Lua highlighter the diff cards use — so the Script Diff
// Theme setting (body[data-diff-theme]) restyles them via CSS exactly like
// diffs. Collapsed chips stay plain text so the single-line ellipsis works.
function renderStatusCommandContent(chip) {
  const raw = chip.dataset.rawCommand ?? chip.textContent;
  chip.dataset.rawCommand = raw;
  if (chip.classList.contains('expanded')) {
    try {
      // Blender rows run Python; everything else is Studio Lua.
      if (chip.closest('.message-status')?.dataset.stepGroup === 'blender') {
        if (typeof hljs !== 'undefined' && hljs.getLanguage('python')) {
          chip.innerHTML = hljs.highlight(raw, { language: 'python' }).value;
          return;
        }
        chip.textContent = raw;
        return;
      }
      chip.innerHTML = highlightLua(raw);
      return;
    } catch {
      // fall through to plain text
    }
  }
  chip.textContent = raw;
}

// working_hint commands are capped at 4000 chars server-side (tool_status.go
// appends this marker); the proxy's command_output carries the full source.
const COMMAND_HINT_TRUNCATION_MARKER = '\n-- … truncated';

// Timeline entries are re-serialized on EVERY chat save, so command source
// and output are capped before persisting. The live DOM view may show more,
// but still bounded to avoid pathological text nodes.
const PERSIST_COMMAND_CAP = 4096;
const PERSIST_OUTPUT_EDGE = 4096;
const DOM_COMMAND_CAP = 200 * 1024;
const DOM_OUTPUT_EDGE = 100 * 1024;

// Keep the head (invocation) and tail (result/error) of long output.
function capOutputText(text, edge = PERSIST_OUTPUT_EDGE) {
  if (typeof text !== 'string' || text.length <= edge * 2) return text;
  const truncated = text.length - edge * 2;
  return `${text.slice(0, edge)}\n... [${truncated} chars truncated] ...\n${text.slice(-edge)}`;
}

// Truncated commands end with the same marker the server-side hint cap uses
// so statusCommandsMatch keeps prefix-matching them against future
// command_output events (including after a persisted chat reloads).
function capCommandText(command, cap = PERSIST_COMMAND_CAP) {
  if (typeof command !== 'string' || command.length <= cap) return command;
  return command.slice(0, cap) + COMMAND_HINT_TRUNCATION_MARKER;
}

// Detail-less generic activity hints ("Reading scripts", "Editing script",
// "Checked diff", ...) arrive when the server could not name a target (see
// codexHumanCommandHint's empty-detail fallbacks). Live they are a useful
// spinner, but finalized they read as noise: "Read scripts" answers nothing,
// and "Edited script" next to a diff card is redundant with the card itself.
// Such rows render live-only and leave no timeline residue. Rows that carry
// a detail (a real target) or a command chip are never vague.
const VAGUE_ACTIVITY_TEXT_PATTERN = /^(reading|read|editing|edited|checking|checked|listing|listed|searching|searched)\s+(scripts?( changes)?|files?|diff|changes)$/i;

export function isVagueActivityStatusText(text) {
  return VAGUE_ACTIVITY_TEXT_PATTERN.test(String(text || '').trim());
}

function statusCommandsMatch(chipCommand, fullCommand) {
  const chip = String(chipCommand || '').trim();
  const full = String(fullCommand || '').trim();
  if (!chip || !full) return false;
  if (chip === full) return true;
  if (!chip.endsWith(COMMAND_HINT_TRUNCATION_MARKER)) return false;
  // UTF-8 cleanup at the cut point can drop a few chars — compare with slack.
  const prefix = chip.slice(0, -COMMAND_HINT_TRUNCATION_MARKER.length).trimEnd();
  return full.startsWith(prefix.slice(0, Math.max(0, prefix.length - 8)));
}

export class StatusManager {
  constructor(app) {
    this.app = app;
    this.turnActionCostByChat = new Map();
    this.turnActionCostMetaByChat = new Map();
    // Bold one-line Codex summaries stream token-by-token. Keep the first useful
    // headline immediate, then coalesce rapid cumulative updates so the flip
    // animation reads as a calm status change instead of a per-token strobe.
    this.thinkingHeadlineUpdates = new Map();
    this.thinkingHeadlineDwellMs = 240;

    // Click-to-expand for Studio command chips on status lines (works for both
    // live statuses and re-rendered stored ones).
    if (!window.__ropilotStatusCommandToggle) {
      window.__ropilotStatusCommandToggle = true;
      document.addEventListener('click', (e) => {
        const chip = e.target.closest?.('.status-command');
        if (!chip) return;
        chip.classList.toggle('expanded');
        renderStatusCommandContent(chip);
      });
    }
    installSearchGroupToggle();
    installBlenderPreviews(app);
    this.pendingBlenderPreviews = new Map();
  }

  // Attach/update the inline command chip on a status element.
  syncCommandNode(statusEl, command) {
    if (!statusEl || typeof command !== 'string' || !command.trim()) return;
    const content = statusEl.querySelector('.status-content');
    if (!content) return;
    let node = content.querySelector('.status-command');
    if (!node) {
      node = document.createElement('code');
      node.className = 'status-command';
      node.title = 'Click to expand';
      content.appendChild(node);
    }
    node.dataset.rawCommand = command.trim();
    renderStatusCommandContent(node);
  }

  // Attach a Studio run-command's result (relayed by the MCP proxy) to the
  // newest matching command-chip row: persisted on the timeline entry and,
  // when the chat is visible, rendered as an output drawer under the chip.
  attachCommandOutput(chatId, command, output) {
    const fullCommand = String(command || '').trim();
    if (!fullCommand || typeof output !== 'string' || !output.trim()) return;

    const chat = store.getChatById(chatId);
    const timeline = chat?.timeline;
    if (Array.isArray(timeline)) {
      let entry = null;
      for (let i = timeline.length - 1; i >= 0; i--) {
        const item = timeline[i];
        if (item?.type === 'status' && statusCommandsMatch(item.command, fullCommand)) {
          entry = item;
          break;
        }
      }
      if (entry) {
        // Upgrade the (possibly hint-truncated) stored command to the full
        // source so the expanded chip shows the whole script — capped, since
        // this entry is re-serialized on every save.
        entry.command = capCommandText(fullCommand);
        entry.commandOutput = capOutputText(output);
        this.app.projectManager.markChatForFullUpdate(chat.id);
        this.app.saveChats();
      }
    }

    if (store.get('activeChatId') !== chatId) return;
    const chips = document.querySelectorAll('#messages .status-command');
    let chip = null;
    for (let i = chips.length - 1; i >= 0; i--) {
      const candidate = chips[i];
      if (statusCommandsMatch(candidate.dataset.rawCommand ?? candidate.textContent, fullCommand)) {
        chip = candidate;
        break;
      }
    }
    if (!chip) return;
    chip.dataset.rawCommand = capCommandText(fullCommand, DOM_COMMAND_CAP);
    renderStatusCommandContent(chip);
    this.ensureCommandOutputNode(chip, output);
  }

  // A Blender GLB snapshot of the running turn (relayed by the MCP proxy
  // after each Blender tool call). A scene snapshot (run_python) is shown
  // live below the chat and kept so flushBlenderPreview can add the turn's
  // final scene when the turn ends. An import is one finished model: it goes
  // into the chat right away, so a turn that imports several models stacks
  // their previews instead of swapping one.
  attachBlenderPreview(chatId, msg) {
    if (!chatId || typeof msg?.path !== 'string' || !msg.path) return;
    const tool = msg.tool === 'import' || msg.tool === 'rig' ? msg.tool : 'run_python';
    const preview = {
      path: msg.path,
      objects: Number(msg.objects) || 0,
      tool,
    };
    if (typeof msg.name === 'string' && msg.name.trim()) preview.name = msg.name.trim();
    if (tool !== 'run_python') {
      // The model is in Studio now; the scene it came from isn't the point.
      this.pendingBlenderPreviews.delete(chatId);
      clearLiveBlenderPreview(chatId);
      this.addBlenderPreviewToChat(chatId, preview);
      return;
    }
    this.pendingBlenderPreviews.set(chatId, preview);
    const pinned = isChatScrollPinnedToBottom();
    showLiveBlenderPreview(chatId, store.get('activeChatId'), preview);
    if (pinned) scrollChatMessagesToEnd();
  }

  // At turn end, add the turn's final Blender scene to the bottom of the chat.
  flushBlenderPreview(chatId) {
    clearLiveBlenderPreview(chatId);
    const preview = this.pendingBlenderPreviews.get(chatId);
    if (!preview) return;
    this.pendingBlenderPreviews.delete(chatId);
    this.addBlenderPreviewToChat(chatId, preview);
  }

  // Append a blender_preview item to the chat's timeline (and the DOM when
  // the chat is on screen).
  addBlenderPreviewToChat(chatId, preview) {
    const chat = store.getChatById(chatId);
    if (!chat) return;
    if (!Array.isArray(chat.timeline)) chat.timeline = [];
    const item = { type: 'blender_preview', id: `blender-preview-${Date.now()}-${chat.timeline.length}`, timestamp: Date.now(), ...preview };
    chat.timeline.push(item);
    this.app.projectManager.markChatForFullUpdate(chat.id);
    this.app.saveChats();

    if (store.get('activeChatId') !== chatId) return;
    const container = document.getElementById('messages');
    if (!container) return;
    const pinned = isChatScrollPinnedToBottom();
    container.appendChild(createBlenderPreviewElement(item));
    if (pinned) scrollChatMessagesToEnd();
  }

  ensureCommandOutputNode(chip, output) {
    let node = chip.nextElementSibling;
    if (!node || !node.classList?.contains('status-command-output')) {
      node = document.createElement('div');
      node.className = 'status-command-output';
      node.innerHTML = '<div class="status-command-output-label">Output</div><pre class="status-command-output-text"></pre>';
      chip.after(node);
    }
    const textEl = node.querySelector('.status-command-output-text');
    if (textEl) textEl.textContent = capOutputText(output, DOM_OUTPUT_EDGE);
  }

  // Shell-command "Editing script(s)" hints from older Go servers can leak
  // raw script-mirror paths (e.g. "- StarterPlayer/StarterPlayerScripts/
  // Foo.client.lua") when no local→game mapping is registered. Convert them
  // to game paths so the line renders like every other script status.
  normalizeScriptMirrorStatus(label, detail) {
    if (typeof label !== 'string' || !/^(Editing|Edited) scripts?$/.test(label.trim())) {
      return { label, detail };
    }
    if (typeof detail !== 'string' || !detail.trim()) {
      return { label, detail };
    }

    const lines = detail
      .split('\n')
      .map((line) => line.replace(/\r/g, '').trim().replace(/^-\s+/, ''))
      .filter(Boolean)
      // Workspace bookkeeping segments (the numeric mirror index dir, 'src')
      // sometimes leak in as "paths" — they are never scripts, drop them.
      .filter((line) => !/^\d+$/.test(line) && line.toLowerCase() !== 'src');
    if (!lines.length) return { label, detail: '' };

    const converted = lines.map((line) => {
      if (/^game\./i.test(line)) return line;
      const normalized = line.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!/^[\w .()-]+(\/[\w .()-]+)+\.luau?$/i.test(normalized)) return null;
      const stripped = normalized
        .replace(/\.(client|server)\.luau?$/i, '')
        .replace(/\.luau?$/i, '');
      return 'game.' + stripped.replace(/\//g, '.');
    });
    if (converted.some((line) => line === null)) {
      // Unrecognized path shape — keep the junk-filtered lines unconverted
      return { label, detail: lines.join('\n') };
    }

    if (converted.length === 1) {
      // Match the filechange status shape so the script icon renders
      return {
        label: label.trim().startsWith('Edited') ? 'Edited' : 'Editing',
        detail: converted[0],
      };
    }
    return { label, detail: converted.join('\n') };
  }

  collapseMultilineDetail(detail) {
    if (typeof detail !== 'string' || !detail.includes('\n')) return detail;
    const parts = detail
      .split('\n')
      .map(line => line.replace(/\r/g, '').trim())
      .filter(Boolean)
      .map(line => line.replace(/^-\s+/, '').trim());
    return parts.join(' • ');
  }

  // `actionsRemaining` is accepted for caller compatibility but intentionally
  // unused: per-turn costs are event-accumulated, never balance-delta derived.
  beginTurnActionCost(chatId, actionsRemaining, meta = null) {
    if (!chatId) return;
    this.turnActionCostByChat.set(chatId, 0);
    if (meta && typeof meta === 'object') {
      this.turnActionCostMetaByChat.set(chatId, { ...meta });
    } else {
      this.turnActionCostMetaByChat.delete(chatId);
    }
  }

  resetTurnActionCost(chatId) {
    if (!chatId) return;
    this.turnActionCostByChat.set(chatId, 0);
    this.turnActionCostMetaByChat.delete(chatId);
  }

  ensureTurnActionCostMeta(chatId, meta = null) {
    if (!chatId || this.turnActionCostMetaByChat.has(chatId)) return;
    if (meta && typeof meta === 'object') {
      this.turnActionCostMetaByChat.set(chatId, { ...meta });
    }
  }

  addTurnActionCost(chatId, deltaCost) {
    if (!chatId) return 0;
    const delta = Number.isFinite(deltaCost) ? deltaCost : Number(deltaCost);
    if (!Number.isFinite(delta) || delta === 0) {
      return this.getTurnActionCost(chatId);
    }

    // Negative deltas are loop-guard refunds; the chip can never go below 0.
    const nextCost = Math.max(0, this.getTurnActionCost(chatId) + delta);
    this.turnActionCostByChat.set(chatId, nextCost);
    return nextCost;
  }

  cancelTurnActionCost(chatId) {
    if (!chatId) return;
    this.turnActionCostByChat.delete(chatId);
    this.turnActionCostMetaByChat.delete(chatId);
  }

  completeTurnActionCost(chatId) {
    if (!chatId) return 0;

    // The per-turn cost comes ONLY from charge events streamed by the server
    // during this chat's turn. Never derive it from balance deltas — the
    // balance is shared across all chats, so "baseline minus refreshed"
    // would attribute other concurrent turns' charges to this one.
    const totalCost = this.getTurnActionCost(chatId);
    if (totalCost <= 0) {
      this.turnActionCostByChat.delete(chatId);
      this.turnActionCostMetaByChat.delete(chatId);
      return 0;
    }
    return totalCost;
  }

  getTurnActionCost(chatId) {
    if (!chatId) return 0;
    return this.turnActionCostByChat.get(chatId) || 0;
  }

  getTurnActionCostMeta(chatId) {
    if (!chatId) return null;
    return this.turnActionCostMetaByChat.get(chatId) || null;
  }

  show(label, detail, command = '') {
    if (detail && isTempPath(detail)) return;

    // Only route to playtest panel if there's actually a visible playtest panel
    if (this.app.isPlaytestActive()) {
      const playtestPanel = document.querySelector('.playtest-panel:not(.hidden)');
      if (playtestPanel) {
        const statusText = detail ? `${label} ${detail}` : label;
        this.app.updatePlaytestStatus(statusText);
        return;
      }
      // Playtest flag is stale, clear it
      console.log('[STATUS] Clearing stale playtestActive in showStatus');
      this.app.clearPlaytestState('stale panel in status');
    }

    const container = document.getElementById('messages');
    if (!container) return;

    ({ label, detail } = this.normalizeScriptMirrorStatus(label, detail));
    let displayDetail = this.mapPathToGamePath(detail);
    label = this.normalizeScriptStatusLabel(label, displayDetail, store.getActiveChat());
    // Ignore compact-specific rows; they are managed by MessageRenderer compaction helpers.
    let statusEl = container.querySelector('.message-status.status-active:not(.message-compaction)');

    // Search-like steps get one row per distinct target (so the Search box
    // lists every place looked at) and Blender steps one row per call,
    // instead of flip-updating a single row.
    const isVagueActivity = !displayDetail && !command && isVagueActivityStatusText(label);
    // Vague rows never join a group: they are removed at finalize, which
    // would leave the group's step count stale.
    const groupKind = isVagueActivity ? null : matchStepGroupKind(displayDetail ? `${label} ${displayDetail}` : label);

    if (statusEl?.dataset.thinkingHeadline === 'true') {
      // A tool/status hint replaces the reasoning headline. Finalize the
      // headline first so a coalesced final cumulative update cannot be lost.
      this.finalizeEntry(statusEl);
      statusEl = null;
    }

    if (statusEl) {
      const currentLabel = statusEl.dataset.label;
      const sameDetail = String(statusEl.dataset.detail || '') === String(displayDetail || '');
      // A hint that only adds code to a code-less row is the same call.
      const sameCommand = !command || !statusEl.dataset.command || statusEl.dataset.command === command;
      if (currentLabel === label && (!groupKind || (sameDetail && sameCommand))) {
        if (statusEl.dataset.synthetic === 'true') {
          this.hydrateSyntheticEntry(statusEl, label, displayDetail);
        }
        const textEl = statusEl.querySelector('.status-text');
        this.updateStatusText(textEl, label, displayDetail);
        if (command) {
          statusEl.dataset.command = command;
          this.syncCommandNode(statusEl, command);
          // Store it now, not only at finalize: command_output can arrive
          // first and matches rows by their stored command.
          const statusId = statusEl.dataset.statusId;
          const entry = statusId && store.getActiveChat()?.timeline
            ?.find((item) => item?.type === 'status' && item.id === statusId);
          if (entry) entry.command = capCommandText(command);
        }
        return;
      } else {
        this.finalizeEntry(statusEl);
      }
    }

    statusEl = document.createElement('div');
    statusEl.className = 'message assistant message-status status-active';
    statusEl.dataset.label = label;
    statusEl.dataset.startTime = Date.now().toString();
    if (isVagueActivity) {
      // Live-only spinner row: no timeline entry, removed at finalize.
      statusEl.dataset.transient = 'true';
    } else {
      statusEl.dataset.statusId = nextStatusId();
    }
    statusEl.innerHTML = `
      <div class="message-content status-content">
        <div class="status-spinner"></div>
        <span class="status-text"></span>
      </div>
    `;
    const textEl = statusEl.querySelector('.status-text');
    this.updateStatusText(textEl, label, displayDetail);
    if (command) {
      statusEl.dataset.command = command;
      this.syncCommandNode(statusEl, command);
    }
    placeStatusElement(container, statusEl, groupKind);
    scrollChatMessagesToEnd();
    // Status rows land outside appendElement, so trim the mounted DOM here
    // too — status-dominated turn stretches must not grow it unbounded.
    this.app.messageRenderer?.enforceLiveMountedItemCap?.();

    if (isVagueActivity) return;

    const statusText = displayDetail ? `${label} ${displayDetail}` : label;
    const entry = { type: 'status', id: statusEl.dataset.statusId, text: statusText, finalized: false };
    if (command) entry.command = capCommandText(command);
    this.app.addToTimeline(entry);
  }

  showThinkingHeadline(chatId, thinkingItemId, headline, options = {}) {
    const text = typeof headline === 'string' ? headline.trim() : '';
    if (!chatId || !thinkingItemId || !text) return false;

    let state = this.thinkingHeadlineUpdates.get(chatId);
    if (!state) {
      state = { itemId: thinkingItemId, applied: '', pending: '', timer: null, lastAppliedAt: 0 };
      this.thinkingHeadlineUpdates.set(chatId, state);
    }
    if (state.itemId !== thinkingItemId) {
      if (state.timer) clearTimeout(state.timer);
      state = { itemId: thinkingItemId, applied: '', pending: '', timer: null, lastAppliedAt: 0 };
      this.thinkingHeadlineUpdates.set(chatId, state);
    }
    if (options.final === true) {
      // The completed update is authoritative even when it duplicates the
      // currently queued cumulative text. Flush it before duplicate checks.
      state.pending = text;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      this.flushThinkingHeadline(chatId);
      return true;
    }
    if (text === state.applied || text === state.pending) return true;

    state.pending = text;
    const elapsed = Date.now() - state.lastAppliedAt;
    if (!state.applied || elapsed >= this.thinkingHeadlineDwellMs) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      this.flushThinkingHeadline(chatId);
      return true;
    }

    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        this.flushThinkingHeadline(chatId);
      }, Math.max(0, this.thinkingHeadlineDwellMs - elapsed));
    }
    return true;
  }

  flushThinkingHeadline(chatId) {
    const state = this.thinkingHeadlineUpdates.get(chatId);
    const headline = state?.pending;
    if (!state || !headline) return false;

    const chat = store.getChatById(chatId);
    if (!chat) {
      this.clearThinkingHeadline(chatId);
      return false;
    }

    if (store.get('activeChatId') === chatId) {
      if (typeof this.app.isPlaytestActive === 'function' && this.app.isPlaytestActive()) {
        return false;
      }
      const container = document.getElementById('messages');
      if (!container) {
        return false;
      }
      let statusEl = container.querySelector('.message-status.status-active:not(.message-compaction)');
      if (!statusEl || statusEl.dataset.label !== 'Thinking') {
        this.show('Thinking');
        statusEl = container.querySelector('.message-status.status-active:not(.message-compaction)');
      }
      if (!statusEl) return false;
      this.applyThinkingHeadlineToElement(statusEl, state.itemId, headline);
      // The chat may have been rendered while this headline was still queued,
      // producing the authoritative Thinking block. The status now owns the
      // eligible summary, so remove that duplicate representation.
      this.app.messageRenderer?.removeThinkingBlockElement?.(state.itemId, chatId);
    } else {
      this.applyThinkingHeadlineToTimeline(chat, state.itemId, headline);
    }

    state.pending = '';
    state.applied = headline;
    state.lastAppliedAt = Date.now();
    return true;
  }

  applyThinkingHeadlineToElement(statusEl, thinkingItemId, headline) {
    if (!statusEl) return false;
    // Hide Thinking hides the reasoning text, not the live activity signal.
    // Keep this row mounted as a generic spinner; the persisted headline below
    // remains authoritative and is restored by a normal re-render on toggle.
    const hideThinking = isHideThinkingEnabled();
    statusEl.hidden = false;
    statusEl.dataset.label = 'Thinking';
    statusEl.dataset.detail = '';
    statusEl.dataset.thinkingHeadline = 'true';
    statusEl.dataset.thinkingItemId = thinkingItemId;
    statusEl.dataset.thinkingHeadlineText = headline;
    statusEl.classList.add('status-thinking-headline');
    const textEl = statusEl.querySelector('.status-text');
    if (!textEl) return false;
    if (hideThinking) {
      textEl.textContent = 'Thinking';
    } else {
      this.updateStatusWithFlip(textEl, '', headline);
      textEl.querySelector('.status-prefix')?.remove();
    }

    const statusId = statusEl.dataset.statusId;
    const chat = store.getActiveChat();
    const entry = statusId && chat?.timeline?.find((item) => item?.type === 'status' && item.id === statusId);
    if (entry) {
      entry.text = headline;
      entry.thinkingHeadline = headline;
      entry.thinkingItemId = thinkingItemId;
    }
    return true;
  }

  applyThinkingHeadlineToTimeline(chat, thinkingItemId, headline) {
    if (!chat) return false;
    if (!Array.isArray(chat.timeline)) chat.timeline = [];

    let entry = null;
    for (let i = chat.timeline.length - 1; i >= 0; i--) {
      const item = chat.timeline[i];
      if (item?.type === 'user' && item.bubbleVariant !== 'steer') break;
      if (item?.type === 'status' && !item.finalized && (
        item.text === 'Thinking'
        || item.thinkingItemId === thinkingItemId
      )) {
        entry = item;
        break;
      }
    }

    if (!entry) {
      for (const item of chat.timeline) {
        if (item?.type === 'status' && !item.finalized) this._finalizeTimelineItem(item);
      }
      entry = {
        type: 'status',
        id: nextStatusId(),
        text: headline,
        thinkingHeadline: headline,
        thinkingItemId,
        finalized: false,
        timestamp: Date.now(),
      };
      chat.timeline.push(entry);
      this.app.projectManager.queueMessage(chat.id, entry);
    } else {
      entry.text = headline;
      entry.thinkingHeadline = headline;
      entry.thinkingItemId = thinkingItemId;
    }
    this.app.projectManager.markChatForFullUpdate(chat.id);
    this.app.saveChats();
    return true;
  }

  clearThinkingHeadline(chatId, options = {}) {
    if (!chatId) return;
    const state = this.thinkingHeadlineUpdates.get(chatId);
    if (options.flush === true && state?.pending) {
      this.flushThinkingHeadline(chatId);
    }
    const current = this.thinkingHeadlineUpdates.get(chatId);
    if (current?.timer) clearTimeout(current.timer);
    this.thinkingHeadlineUpdates.delete(chatId);
  }

  hydrateSyntheticEntry(statusEl, label, displayDetail) {
    if (!statusEl || statusEl.dataset.synthetic !== 'true' || statusEl.dataset.statusId) {
      return;
    }

    const activeChat = store.getActiveChat();
    if (!activeChat) return;

    const statusText = displayDetail ? `${label} ${displayDetail}` : label;
    const statusId = nextStatusId();
    delete statusEl.dataset.synthetic;
    statusEl.dataset.statusId = statusId;
    this.app.addToTimeline({ type: 'status', id: statusId, text: statusText, finalized: false }, activeChat);
  }

  mapPathToGamePath(detail) {
    const activeChat = store.getActiveChat();
    if (!detail || !activeChat?.pathMappings) return detail;

    const normalizedDetail = detail.replace(/\\/g, '/');
    let gamePath = activeChat.pathMappings[detail];

    if (!gamePath) {
      for (const [localPath, gPath] of Object.entries(activeChat.pathMappings)) {
        if (localPath.replace(/\\/g, '/') === normalizedDetail) {
          gamePath = gPath;
          break;
        }
      }
    }

    if (gamePath) {
      console.log('[PATH MAPPING] Converted status detail:', detail, '->', gamePath);
      return gamePath;
    }
    return detail;
  }

  finalizeEntry(statusEl) {
    if (!statusEl) return;

    const activeChatId = store.get('activeChatId');
    if (activeChatId && statusEl.dataset.thinkingHeadline === 'true') {
      this.clearThinkingHeadline(activeChatId, { flush: true });
    }

    const isSynthetic = statusEl.dataset.synthetic === 'true' && !statusEl.dataset.statusId;
    if (isSynthetic) {
      statusEl.remove();
      return;
    }

    const thinkingHeadline = statusEl.dataset.thinkingHeadline === 'true';
    if (thinkingHeadline) {
      statusEl.classList.remove('status-active', 'status-thinking-headline');
      statusEl.classList.add('status-done');
      statusEl.querySelector('.status-spinner')?.remove();
      statusEl.querySelectorAll('.flip-in, .flip-out').forEach((el) => {
        el.classList.remove('flip-in', 'flip-out');
      });
      const statusId = statusEl.dataset.statusId;
      const activeChat = store.getActiveChat();
      const entry = statusId && activeChat?.timeline?.find((item) => item?.type === 'status' && item.id === statusId);
      if (entry) {
        entry.text = statusEl.dataset.thinkingHeadlineText || entry.thinkingHeadline || entry.text;
        entry.thinkingHeadline = entry.text;
        entry.thinkingItemId = statusEl.dataset.thinkingItemId || entry.thinkingItemId;
        entry.finalized = true;
        this.app.projectManager.markChatForFullUpdate(activeChat.id);
        this.app.saveChats();
      }
      if (activeChat?.id) this.clearThinkingHeadline(activeChat.id);
      return;
    }

    // Vague live-only rows ("Reading scripts" with no target) leave no
    // residue: their finalized text answers nothing.
    if (statusEl.dataset.transient === 'true' && !statusEl.dataset.statusId) {
      statusEl.remove();
      return;
    }

    statusEl.classList.remove('status-active');
    statusEl.classList.add('status-done');

    const spinner = statusEl.querySelector('.status-spinner');
    if (spinner) spinner.remove();

    const textEl = statusEl.querySelector('.status-text');
    if (!textEl) return;

    const label = statusEl.dataset.label;
    const startTime = parseInt(statusEl.dataset.startTime || '0');

    // Get the full current text (handles both plain text and structured HTML)
    const currentTextRaw = textEl.textContent.trim();
    const currentText = currentTextRaw.replace(/\s+/g, ' ');
    const rawDetail = statusEl.dataset.detail || '';
    const collapsedDetail = this.collapseMultilineDetail(rawDetail);

    let finalText;
    if ((label === 'Thinking' || label === 'Working') && startTime) {
      const duration = Date.now() - startTime;
      const durationStr = formatDuration(duration);
      const pastLabel = label === 'Thinking' ? 'Thought' : 'Worked';
      finalText = `${pastLabel} for ${durationStr}`;
    } else if (collapsedDetail) {
      finalText = `${toPastTense(label)} ${collapsedDetail}`.trim();
    } else {
      const pastTense = toPastTense(label);
      if (currentText.startsWith(label)) {
        finalText = currentText.replace(label, pastTense);
      } else {
        finalText = pastTense;
      }
    }

    // Reset to plain text unless this status has a structured script-search layout.
    const finalLabel = toPastTense(label);
    if (!(collapsedDetail && (
      this.renderSearchInScriptStatus(textEl, finalLabel, collapsedDetail)
      || this.renderScriptPathStatus(textEl, finalLabel, collapsedDetail)
    ))) {
      textEl.textContent = finalText;
    }
    textEl.classList.remove('status-multiline');
    refineSearchStepText(statusEl);

    const statusId = statusEl.dataset.statusId;
    const activeChat = store.getActiveChat();
    if (statusId && activeChat?.timeline) {
      const entry = activeChat.timeline.find(item => item.type === 'status' && item.id === statusId);
      if (entry) {
        entry.text = finalText;
        entry.finalized = true;
        if (statusEl.dataset.command) entry.command = capCommandText(statusEl.dataset.command);
        // Mark chat for full update since we modified existing timeline item
        this.app.projectManager.markChatForFullUpdate(activeChat.id);
        this.app.saveChats();
      }
    }
  }

  updateStatusText(textEl, label, displayDetail) {
    const statusEl = textEl.closest('.message-status');
    if (statusEl) {
      statusEl.dataset.detail = displayDetail || '';
    }
    const collapsedDetail = this.collapseMultilineDetail(displayDetail);

    // For script status or searching with special formatting, use simple text (no animation)
    if (label.includes('Search') && collapsedDetail && this.renderSearchInScriptStatus(textEl, label, collapsedDetail)) {
      return;
    }

    if (this.renderScriptPathStatus(textEl, label, collapsedDetail)) {
      return;
    }

    if (label.includes('Searching') && collapsedDetail) {
      textEl.classList.remove('status-multiline');
      textEl.innerHTML = `<span class="status-prefix">${escapeHtml(label)}</span> <code>${escapeHtml(collapsedDetail)}</code>`;
    } else if (collapsedDetail) {
      textEl.classList.remove('status-multiline');
      // Use flip animation for dynamic detail changes
      this.updateStatusWithFlip(textEl, label, collapsedDetail);
    } else {
      textEl.classList.remove('status-multiline');
      // Bare label (Working, Thinking) — shimmer + animated ellipsis while
      // active. The ellipsis lives inside the prefix so the dots hug the
      // label (flex column-gap would otherwise push them apart).
      textEl.innerHTML = `<span class="status-prefix">${escapeHtml(label)}<span class="status-ellipsis"></span></span>`;
    }
  }

  parseSearchInScriptDetail(detail) {
    if (typeof detail !== 'string') return null;
    const match = /^"((?:\\.|[^"\\])*)"\s+in\s+(game\..+)$/i.exec(detail.trim());
    if (!match) return null;
    return {
      query: match[1]
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\'),
      path: match[2].trim(),
    };
  }

  renderSearchInScriptStatus(textEl, label, detail) {
    const parsed = this.parseSearchInScriptDetail(detail);
    if (!parsed) return false;

    textEl.classList.remove('status-multiline');
    const activeChat = store.getActiveChat();
    const scriptType = activeChat?.scriptTypes?.[parsed.path] || inferScriptTypeFromPath(parsed.path);
    const icon = getScriptIcon(scriptType);
    textEl.innerHTML = `<span class="status-prefix">${escapeHtml(label)}</span> <code>${escapeHtml(parsed.query)}</code> <span class="status-plain">in</span> ${icon} <span class="status-plain">${escapeHtml(parsed.path)}</span>`;
    return true;
  }

  isLineRangeReadStatus(label) {
    return /^(?:Reading|Read|Verifying|Verified)\s+L\d/i.test(String(label || '').trim());
  }

  parseTimelineDiff(item) {
    if (!item || item.type !== 'diff' || !item.content) return null;
    if (typeof item.content === 'object') return item.content;
    if (typeof item.content !== 'string') return null;
    try {
      return JSON.parse(item.content);
    } catch {
      return null;
    }
  }

  hasDiffForScriptSinceLastUserMessage(chat, scriptPath) {
    const timeline = Array.isArray(chat?.timeline) ? chat.timeline : [];
    const normalizedPath = String(scriptPath || '').replace(/\\/g, '/').trim();
    if (!normalizedPath) return false;

    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item?.type === 'user') break;
      const diff = this.parseTimelineDiff(item);
      const diffPath = String(diff?.path || diff?.fileName || '').replace(/\\/g, '/').trim();
      if (diffPath && diffPath === normalizedPath) {
        return true;
      }
    }
    return false;
  }

  normalizeScriptStatusLabel(label, detail, chat) {
    const trimmedLabel = String(label || '').trim();
    if (!/^Reading\s+L\d/i.test(trimmedLabel)) {
      return label;
    }
    if (!this.hasDiffForScriptSinceLastUserMessage(chat, detail)) {
      return label;
    }
    return trimmedLabel.replace(/^Reading/i, 'Verifying');
  }

  renderScriptPathStatus(textEl, label, detail) {
    const isScriptStatus = label === 'Editing' || label === 'Editing scripts' || label === 'Edited scripts'
      || label === 'Disabled script' || this.isLineRangeReadStatus(label);
    if (!isScriptStatus || !detail) {
      return false;
    }

    // Multi-script edit hints arrive collapsed as "game.A \u2022 game.B" —
    // render each path with its own icon.
    const paths = detail.split(' \u2022 ').map((path) => path.trim()).filter(Boolean);
    const looksLikeScriptPath = (path) => (
      path.includes('game.') ||
      path.endsWith('.lua') ||
      path.includes('ServerScriptService') ||
      path.includes('ReplicatedStorage') ||
      path.includes('StarterPlayer') ||
      path.includes('StarterGui')
    );
    if (paths.length === 0 || !paths.every(looksLikeScriptPath)) {
      return false;
    }

    textEl.classList.remove('status-multiline');
    const activeChat = store.getActiveChat();
    // Path text lives in .status-plain spans so the active state can force
    // the same background-clip:text rasterization as the shimmering label —
    // mixed rasterization (grayscale vs subpixel AA) makes plain text read
    // bolder/brighter than the label on the same line.
    const rendered = paths.map((path) => {
      const scriptType = activeChat?.scriptTypes?.[path] || inferScriptTypeFromPath(path);
      return `${getScriptIcon(scriptType)} <span class="status-plain">${escapeHtml(path)}</span>`;
    }).join(' <span class="status-plain">\u2022</span> ');
    textEl.innerHTML = `<span class="status-prefix">${escapeHtml(label)}</span> ${rendered}`;
    return true;
  }

  updateStatusWithFlip(textEl, label, displayDetail) {
    // Check if we already have the structured HTML
    let detailWrapper = textEl.querySelector('.status-detail-wrapper');

    if (!detailWrapper) {
      // First time - set up the structure with flip-in animation
      const prefixMarkup = label
        ? `<span class="status-prefix">${escapeHtml(label)}</span>`
        : '';
      textEl.innerHTML = `
        ${prefixMarkup}
        <span class="status-detail-wrapper">
          <span class="status-detail flip-in">${escapeHtml(displayDetail)}</span>
        </span>
      `;
      return;
    }

    // Get current detail element (not the one animating out)
    const currentDetail = detailWrapper.querySelector('.status-detail:not(.flip-out)');
    const currentText = currentDetail?.textContent?.trim();

    // If same text, no need to animate
    if (currentText === displayDetail) {
      return;
    }

    // Create new detail element that will flip in
    const newDetail = document.createElement('span');
    newDetail.className = 'status-detail flip-in';
    newDetail.textContent = displayDetail;

    // Animate out the old one. Reduced-motion removes CSS animations, so the
    // stale node must be removed synchronously instead of waiting forever for
    // an animationend event that cannot fire.
    if (currentDetail) {
      const reducedMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion) {
        currentDetail.remove();
        newDetail.classList.remove('flip-in');
      } else {
        currentDetail.classList.add('flip-out');
        currentDetail.classList.remove('flip-in');
        const removeCurrent = () => currentDetail.remove();
        currentDetail.addEventListener('animationend', removeCurrent, { once: true });
        // Defensive cleanup for interrupted/disabled animations.
        setTimeout(removeCurrent, 300);
      }
    }

    // Add the new one (it will determine wrapper size since old is position:absolute)
    detailWrapper.appendChild(newDetail);
  }

  hide() {
    const activeChatId = store.get('activeChatId');
    if (activeChatId) this.clearThinkingHeadline(activeChatId, { flush: true });
    const container = document.getElementById('messages');
    if (!container) return;

    // Only finalize regular working-hint statuses here. Compaction rows are finalized
    // through finalizeCompactionInChat so their spinner state stays correct.
    const activeStatuses = container.querySelectorAll('.message-status.status-active:not(.message-compaction)');
    activeStatuses.forEach(el => {
      this.finalizeEntry(el);
    });

    // The turn often continues after a status is finalized (text streamed, a
    // diff card landed) without a follow-up working_hint — leaving the chat
    // visibly processing (sidebar spinner) but with no spinner at the bottom.
    // Re-add the synthetic Working row if the chat is still processing shortly.
    this.scheduleProcessingFallback();
  }

  // Called for every stream message routed to a chat: the fallback spinner
  // should only appear after genuine dead air, not in the short gap between
  // the final response text and the turn's 'done' event.
  noteStreamActivity(chatId) {
    if (!chatId) return;
    if (!this._streamActivityAt) this._streamActivityAt = new Map();
    this._streamActivityAt.set(chatId, Date.now());
  }

  scheduleProcessingFallback(delayMs = 3500) {
    if (this._processingFallbackTimer) {
      clearTimeout(this._processingFallbackTimer);
    }
    const chatId = store.get('activeChatId');
    if (!chatId) return;
    this._processingFallbackTimer = setTimeout(() => {
      this._processingFallbackTimer = null;
      this.ensureProcessingFallback(chatId);
    }, delayMs);
  }

  ensureProcessingFallback(chatId) {
    if (!chatId || store.get('activeChatId') !== chatId) return;
    if (!store.isChatProcessing(chatId)) return;
    if (this.app.isPlaytestActive()) return;

    // Still receiving stream traffic recently (e.g. text just finished and
    // 'done' is on its way, or text is actively streaming) — wait for real
    // silence before showing the spinner.
    const lastActivity = this._streamActivityAt?.get(chatId) || 0;
    const silentFor = Date.now() - lastActivity;
    const requiredSilenceMs = 5000;
    if (silentFor < requiredSilenceMs) {
      this.scheduleProcessingFallback(requiredSilenceMs - silentFor);
      return;
    }

    const container = document.getElementById('messages');
    if (!container) return;
    // Any active status (including compaction) means a spinner is already visible.
    if (container.querySelector('.message-status.status-active')) return;

    const el = this.app.messageRenderer?.createFallbackProcessingStatusElement?.(chatId);
    if (!el) return;

    // Only auto-scroll when the user is already at (or near) the bottom —
    // this insert happens on a timer, not on a user action.
    const scroller = getChatMessagesScroller();
    const nearBottom = !scroller
      || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    container.appendChild(el);
    if (nearBottom) scrollChatMessagesToEnd();
  }

  // Save status to a specific chat's timeline without touching DOM
  // Used when user is viewing a different chat and working_hint statuses arrive
  saveToChat(chatId, label, detail, command = '') {
    if (detail && isTempPath(detail)) return;
    ({ label, detail } = this.normalizeScriptMirrorStatus(label, detail));

    const chat = store.getChatById(chatId);
    if (!chat) return;
    if (!chat.timeline) chat.timeline = [];

    // Map path to game path using target chat's mappings (not active chat)
    let displayDetail = detail;
    if (detail && chat.pathMappings) {
      const normalized = detail.replace(/\\/g, '/');
      const mapped = chat.pathMappings[detail] ||
        Object.entries(chat.pathMappings).find(([k]) => k.replace(/\\/g, '/') === normalized)?.[1];
      if (mapped) displayDetail = mapped;
    }
    label = this.normalizeScriptStatusLabel(label, displayDetail, chat);

    // Background chats have no live spinner to benefit from a vague hint —
    // persisting it would only materialize as "Read scripts"-style noise
    // when the user switches back.
    if (!displayDetail && !command && isVagueActivityStatusText(label)) return;

    // Mirror show(): a newer concrete tool hint owns the next timeline slot.
    // Flush and retire a queued reasoning headline before computing/updating the
    // tool row so a later dwell timer or terminal event cannot append it after
    // the newer Reading/Edited/etc. activity.
    this.finalizePendingThinkingHeadlineInChat(chatId);

    const statusText = displayDetail ? `${label} ${displayDetail}` : label;

    // Find existing active (unfinalized) status with same label
    let existing = null;
    for (let i = chat.timeline.length - 1; i >= 0; i--) {
      const item = chat.timeline[i];
      if (item?.type === 'status' && !item.finalized && item.text?.startsWith(label)) {
        existing = item;
        break;
      }
    }

    // Search-like steps keep one timeline entry per distinct target, and
    // Blender steps one per call, so their boxes re-render every step
    // (mirrors show()).
    if (existing && matchSearchLabel(label) && existing.text !== statusText) {
      this._finalizeTimelineItem(existing);
    } else if (existing && command && existing.command
      && existing.command !== capCommandText(command)
      && matchStepGroupKind(statusText) === 'blender') {
      this._finalizeTimelineItem(existing);
    }

    if (existing && !existing.finalized) {
      // Same label — update detail text
      existing.text = statusText;
      if (command) existing.command = capCommandText(command);
    } else {
      // Different label — finalize any previous active statuses
      for (const item of chat.timeline) {
        if (item.type === 'status' && !item.finalized) {
          this._finalizeTimelineItem(item);
        }
      }

      // Create new entry
      const statusId = nextStatusId();
      const entry = { type: 'status', id: statusId, text: statusText, finalized: false, timestamp: Date.now() };
      if (command) entry.command = capCommandText(command);
      chat.timeline.push(entry);
      this.app.projectManager.queueMessage(chatId, entry);
    }

    this.app.saveChats();
  }

  finalizePendingThinkingHeadlineInChat(chatId) {
    const state = this.thinkingHeadlineUpdates.get(chatId);
    if (!state) return false;

    if (state.pending) this.flushThinkingHeadline(chatId);
    const chat = store.getChatById(chatId);
    const itemId = state.itemId;
    if (chat?.timeline) {
      for (let i = chat.timeline.length - 1; i >= 0; i--) {
        const item = chat.timeline[i];
        if (item?.type === 'user' && item.bubbleVariant !== 'steer') break;
        if (item?.type === 'status' && !item.finalized && item.thinkingItemId === itemId) {
          this._finalizeTimelineItem(item);
          break;
        }
      }
    }
    this.clearThinkingHeadline(chatId);
    return true;
  }

  // Finalize a single timeline status item (shared logic for all finalization paths)
  _finalizeTimelineItem(item) {
    if (item.type !== 'status' || item.finalized) return;
    if (item.thinkingHeadline) {
      item.text = item.thinkingHeadline;
      item.finalized = true;
      return;
    }
    const label = item.text?.split(' ')[0] || 'Working';
    if ((label === 'Thinking' || (label === 'Working' && !item.text?.startsWith('Working on'))) && item.timestamp) {
      const duration = Date.now() - item.timestamp;
      const durationStr = formatDuration(duration);
      const pastLabel = label === 'Thinking' ? 'Thought' : 'Worked';
      item.text = `${pastLabel} for ${durationStr}`;
    } else {
      const pastTense = toPastTense(label);
      if (item.text?.startsWith(label)) {
        item.text = item.text.replace(label, pastTense);
      } else {
        item.text = pastTense;
      }
    }
    item.finalized = true;
  }

  // Finalize status entries in a specific chat's timeline (without touching DOM)
  // Used when user is viewing a different chat when 'done' arrives
  finalizeInChat(chatId) {
    this.clearThinkingHeadline(chatId, { flush: true });
    const chat = store.getChatById(chatId);
    if (!chat?.timeline) return;

    let hasChanges = false;
    for (const item of chat.timeline) {
      if (item.type === 'status' && !item.finalized) {
        this._finalizeTimelineItem(item);
        item.finalized = true;
        hasChanges = true;
      }
    }

    if (hasChanges) {
      this.app.projectManager.markChatForFullUpdate(chatId);
      this.app.saveChats();
    }
  }
}
