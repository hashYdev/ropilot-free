// Thinking block - Codex public reasoning summaries ("thinking" WS messages)
// rendered as one compact, collapsible block per reasoning item. State is
// keyed by chat (session_id) + item_id + summary_index: every update carries
// the authoritative cumulative text for one summary part, so parts update in
// place and never add a timeline row per delta. Used by both the live stream
// path (MessageHandler → MessageRenderer.upsertThinkingInChat) and the
// timeline re-render path (MessageRenderer.render).

import { store } from './state-store.js';
import { formatMessage } from './message-formatter.js';

const CHEVRON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

// "Hide Thinking" (Settings): thinking blocks are not rendered at all while
// enabled. The lightweight "Thought for Ns" status rows stay visible — they
// are the remaining trace of how long the model reasoned. Hiding is
// render-time only — summaries still land on the timeline and persist, so
// turning the setting off brings them back. The storage key is the legacy
// collapse-by-default key so users who had collapse-on inherit hide-on.
export const HIDE_THINKING_SETTING_KEY = 'ropilot_collapse_thinking';

export function isHideThinkingEnabled() {
  try {
    return localStorage.getItem(HIDE_THINKING_SETTING_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setHideThinkingEnabled(enabled) {
  try {
    localStorage.setItem(HIDE_THINKING_SETTING_KEY, enabled === true ? 'true' : 'false');
  } catch {
    // Storage unavailable — the toggle just won't persist.
  }
}

// Timeline entries are re-serialized on EVERY chat save (see the persistence
// caps in status-manager.js), so summary text is bounded before it lands
// there. Real summaries are a few hundred chars; the cap only guards against
// pathological payloads.
export const THINKING_TEXT_CAP = 20000;
// Bounds one reasoning item's part list against malformed payloads that spray
// summary indexes.
export const THINKING_MAX_PARTS = 64;

// A Codex summary may replace the active spinner label only when the entire
// payload is one non-empty, single-line bold span with plain text inside. Keep
// this intentionally strict: anything with surrounding prose, nested/extra
// emphasis, another markdown construct, HTML-like markup, or a newline belongs
// in the full Thinking block where the existing markdown renderer can preserve
// it without ambiguity.
export function extractThinkingStatusHeadline(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return null;
  const match = /^\*\*([^*]+)\*\*$/.exec(trimmed);
  if (!match) return null;

  const headline = match[1];
  if (!headline.trim() || headline !== headline.trim()) return null;
  // Exact plain text only. Reject Markdown/HTML/control syntax anywhere inside
  // the outer bold span; normal Unicode prose and punctuation remain eligible.
  if (/[*_`~<>\\]/.test(headline)) return null;
  if (/!?\[[^\]]*\](?:\([^)]*\)|\s*\[[^\]]*\])/.test(headline)) return null;
  if (/^\s{0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s)/.test(headline)) return null;
  // No C0/C1 controls (including tabs), DEL, or invisible bidi direction
  // formatting/override/isolate characters. These can alter presentation or
  // make a headline look like different plain text than its stored value.
  for (const char of headline) {
    const codePoint = char.codePointAt(0);
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    const isBidiControl = codePoint === 0x061c || codePoint === 0x200e || codePoint === 0x200f
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069);
    if (isControl || isBidiControl) return null;
  }
  return headline;
}

export function getThinkingStatusHeadline(item) {
  const parts = Array.isArray(item?.parts)
    ? item.parts.filter((part) => part && typeof part.text === 'string')
    : [];
  if (parts.length !== 1) return null;
  return extractThinkingStatusHeadline(parts[0].text);
}

// Validates and normalizes one inbound thinking payload. Returns null for
// anything that is not a well-formed update (older servers, malformed or
// unknown shapes) so the caller can drop it harmlessly.
export function normalizeThinkingContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;

  const itemId = typeof content.item_id === 'string' ? content.item_id.trim() : '';
  if (!itemId) return null;

  const rawIndex = content.summary_index;
  let summaryIndex = 0;
  if (rawIndex !== undefined && rawIndex !== null) {
    const parsed = Number(rawIndex);
    if (!Number.isFinite(parsed)) return null;
    summaryIndex = Math.max(0, Math.trunc(parsed));
  }

  if (typeof content.text !== 'string') return null;
  // Codex summaries separate sections with empty HTML comments ("<!-- -->");
  // they are markup plumbing, not prose — drop them before display/persist.
  const text = content.text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .trim()
    .slice(0, THINKING_TEXT_CAP);
  if (!text) return null;

  return { itemId, summaryIndex, text, completed: content.completed === true };
}

// Codex reasoning summaries are markdown ("**Planning the fix**"), but they
// are untrusted model output: angle brackets are escaped BEFORE the markdown
// pass so raw HTML can never reach the DOM as markup, and marked-generated
// links/images are neutralized after (marked passes hrefs through verbatim).
// Without a markdown renderer this falls back to formatMessage's own
// escaped-plain-text path.
function renderThinkingMarkdown(node, text) {
  if (typeof globalThis.marked === 'undefined') {
    node.innerHTML = formatMessage(text);
    return;
  }
  const escaped = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  node.innerHTML = formatMessage(escaped);
  node.querySelectorAll('img').forEach((img) => {
    img.replaceWith(document.createTextNode(img.getAttribute('alt') || ''));
  });
  node.querySelectorAll('a').forEach((a) => a.removeAttribute('href'));
}

// Finds this reasoning item's timeline entry within the current turn, or
// creates one at the tail. The scan stops at the turn boundary (a non-steer
// user message) so an id can never attach to an earlier assistant turn.
// Returns { item, createdItem, createdPart, changed } or null.
export function upsertThinkingTimelineItem(chat, update) {
  if (!chat || !Array.isArray(chat.timeline) || !update) return null;

  let item = null;
  for (let i = chat.timeline.length - 1; i >= 0; i--) {
    const candidate = chat.timeline[i];
    if (candidate?.type === 'thinking' && candidate.itemId === update.itemId) {
      item = candidate;
      break;
    }
    if (candidate?.type === 'user' && candidate.bubbleVariant !== 'steer') break;
  }

  const createdItem = !item;
  if (createdItem) {
    item = { type: 'thinking', itemId: update.itemId, parts: [] };
    // Hidden blocks are still recorded collapsed so that turning the setting
    // off later reveals them folded, not sprawled open.
    if (isHideThinkingEnabled()) item.collapsed = true;
  }
  if (!Array.isArray(item.parts)) item.parts = [];

  let part = item.parts.find((p) => p && p.index === update.summaryIndex);
  let createdPart = false;
  if (!part) {
    if (item.parts.length >= THINKING_MAX_PARTS) {
      return { item, createdItem, createdPart: false, changed: createdItem };
    }
    part = { index: update.summaryIndex, text: '', completed: false };
    item.parts.push(part);
    item.parts.sort((a, b) => a.index - b.index);
    createdPart = true;
  }

  // A completed part is frozen against stragglers: only another completed
  // update (the server's final authoritative text) may rewrite it.
  if (part.completed && !update.completed) {
    return { item, createdItem, createdPart, changed: createdItem || createdPart };
  }

  const changed = part.text !== update.text || (update.completed && !part.completed);
  part.text = update.text;
  if (update.completed) part.completed = true;

  return { item, createdItem, createdPart, changed: changed || createdItem || createdPart };
}

export function isThinkingItemStreaming(item) {
  return Array.isArray(item?.parts) && item.parts.some((p) => p && p.completed !== true);
}

// True while the current turn has a thinking block that is still receiving
// summary text — used to suppress the generic bare "Thinking" working hint
// that would otherwise duplicate the detailed block.
export function hasStreamingThinkingItem(chat) {
  const timeline = chat?.timeline;
  if (!Array.isArray(timeline)) return false;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const candidate = timeline[i];
    if (candidate?.type === 'thinking') return isThinkingItemStreaming(candidate);
    if (candidate?.type === 'user' && candidate.bubbleVariant !== 'steer') break;
  }
  return false;
}

// One-time delegated click handler: the block header toggles collapse and
// remembers the choice on the timeline item so re-renders keep it.
export function installThinkingToggle() {
  if (window.__ropilotThinkingToggle) return;
  window.__ropilotThinkingToggle = true;
  document.addEventListener('click', (e) => {
    const header = e.target.closest?.('.thinking-header');
    if (!header) return;
    const block = header.closest('.message-thinking');
    if (!block) return;
    const collapsed = block.classList.toggle('collapsed');
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const id = block.dataset.thinkingId || '';
    const chat = store.getActiveChat();
    const item = id && Array.isArray(chat?.timeline)
      ? chat.timeline.find((t) => t?.type === 'thinking' && t.id === id)
      : null;
    if (item) {
      item.collapsed = collapsed;
      // An explicit choice wins over the turn-end auto-collapse.
      item.userToggled = true;
    }
  });
}

// Coalesced pin of a block body's scroll to its end while streaming — same
// rationale as the search-group body pin: scrollHeight reads force layout,
// so per-delta read+write would be O(n^2) across a burst.
const pendingBodyPins = new Set();
let bodyPinScheduled = false;
function pinThinkingBodyToEnd(body) {
  pendingBodyPins.add(body);
  if (bodyPinScheduled) return;
  bodyPinScheduled = true;
  window.requestAnimationFrame(() => {
    bodyPinScheduled = false;
    const bodies = [...pendingBodyPins];
    pendingBodyPins.clear();
    for (const el of bodies) {
      el.scrollTop = el.scrollHeight;
    }
  });
}

export function createThinkingElement(item, options = {}) {
  installThinkingToggle();
  const el = document.createElement('div');
  el.className = 'message assistant message-thinking';
  if (item?.collapsed === true) el.classList.add('collapsed');
  if (item?.id) {
    el.dataset.thinkingId = item.id;
    el.dataset.timelineItemId = item.id;
  }
  el.innerHTML = `
    <button class="thinking-header" type="button" aria-expanded="${item?.collapsed === true ? 'false' : 'true'}">
      <span class="thinking-title">Thinking</span>
      <span class="thinking-chevron">${CHEVRON_SVG}</span>
    </button>
    <div class="thinking-body"></div>
  `;
  syncThinkingElement(el, item, options);
  return el;
}

// Reconciles the block's DOM against the timeline item in place: part text
// renders as sanitized markdown (see renderThinkingMarkdown — raw HTML can
// never land as markup), nodes keep their identity across updates so
// streaming text never re-mounts, and parts render in ascending
// summary_index order.
export function syncThinkingElement(el, item, options = {}) {
  if (!el) return;
  const body = el.querySelector('.thinking-body');
  if (!body) return;

  el.classList.toggle('thinking-streaming', options.streaming === true);
  el.classList.toggle('collapsed', item?.collapsed === true);
  el.querySelector('.thinking-header')?.setAttribute('aria-expanded', item?.collapsed === true ? 'false' : 'true');

  // Sample the reader's position before the text grows: only re-pin when they
  // were already at (or near) the end of the capped body.
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;

  const parts = Array.isArray(item?.parts) ? item.parts.filter((p) => p && typeof p.text === 'string') : [];
  let mutated = false;
  parts.forEach((part, position) => {
    let node = body.querySelector(`.thinking-part[data-summary-index="${part.index}"]`);
    if (!node) {
      node = document.createElement('div');
      node.className = 'thinking-part';
      node.dataset.summaryIndex = String(part.index);
      mutated = true;
    }
    const expectedAt = body.children[position];
    if (expectedAt !== node) {
      body.insertBefore(node, expectedAt || null);
      mutated = true;
    }
    if (node.dataset.rawText !== part.text) {
      node.dataset.rawText = part.text;
      renderThinkingMarkdown(node, part.text);
      mutated = true;
    }
  });
  while (body.children.length > parts.length) {
    body.lastElementChild.remove();
    mutated = true;
  }

  if (mutated && options.streaming === true && nearBottom) {
    pinThinkingBodyToEnd(body);
  }
}
