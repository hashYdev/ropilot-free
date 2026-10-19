// Search Group - collects consecutive "search-like" status rows (searching,
// reading, exploring the place) into one collapsible Search box, and
// consecutive Blender rows (Python runs, imports, render checks) into a
// Blender box built the same way. Used by both
// the live working_hint path (StatusManager) and the timeline re-render path
// (MessageRenderer). Grouping is purely presentational: the chat timeline
// keeps flat status items, and the box is rebuilt from consecutive runs.

import { escapeHtml, getChatMessagesScroller, scrollChatMessagesToEnd } from './utils.js';

// Present + past tense pairs, matched as a word-boundary prefix of the status
// text. Kept in sync with the server's working_hint labels (tool_status*.go)
// and toPastTense in utils.js.
const SEARCH_LABELS = [
  'Looking closer at', 'Looked closer at',
  'Searching', 'Searched',
  'Exploring', 'Explored',
  'Inspecting', 'Inspected',
  'Reading', 'Read',
  'Listing', 'Listed',
  'Finding', 'Found',
  'Checking', 'Checked',
  'Getting', 'Got',
];
// Longest first so 'Looking closer at' wins over shorter prefixes.
const SEARCH_LABELS_BY_LENGTH = [...SEARCH_LABELS].sort((a, b) => b.length - a.length);

const MAGNIFIER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
const FILE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;
const FOLDER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
const TERMINAL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"></rect><polyline points="7.5 9.5 10.5 12 7.5 14.5"></polyline><line x1="12.5" y1="15" x2="16.5" y2="15"></line></svg>`;
const CUBE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`;
const IMAGE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
const CHEVRON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
// Blender's logo (Simple Icons, CC0), filled with the row's text color so it
// stays grayscale like the other step icons.
const BLENDER_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.51 13.214c.046-.8.438-1.506 1.03-2.006a3.424 3.424 0 0 1 2.212-.79c.85 0 1.631.3 2.211.79.592.5.983 1.206 1.028 2.005.045.822-.285 1.586-.865 2.153a3.389 3.389 0 0 1-2.374.938 3.393 3.393 0 0 1-2.376-.938c-.58-.567-.91-1.331-.866-2.152M7.35 14.831c.006.314.106.922.256 1.398a7.372 7.372 0 0 0 1.593 2.757 8.227 8.227 0 0 0 2.787 2.001 8.947 8.947 0 0 0 3.66.76 8.964 8.964 0 0 0 3.657-.772 8.285 8.285 0 0 0 2.785-2.01 7.428 7.428 0 0 0 1.592-2.762 7.072 7.072 0 0 0 .25-3.074 7.09 7.09 0 0 0-1.016-2.779 7.696 7.696 0 0 0-1.852-2.043h.002L13.566 2.55l-.02-.015c-.492-.378-1.319-.376-1.86.002-.547.382-.609 1.015-.123 1.415l-.001.001 3.126 2.543-9.53.01h-.013c-.788.001-1.545.518-1.695 1.172-.154.666.381 1.218 1.2 1.221v.001l4.83-.01-8.62 6.617-.034.025c-.813.622-1.075 1.658-.563 2.313.52.667 1.625.668 2.447.004L7.414 14s-.069.52-.063.831zm12.09 1.741c-.96.978-2.304 1.532-3.794 1.535-1.492.003-2.836-.546-3.796-1.523a4.708 4.708 0 0 1-1.049-1.588 4.44 4.44 0 0 1-.338-1.832 4.478 4.478 0 0 1 .49-1.816 4.786 4.786 0 0 1 1.11-1.407c.996-.784 2.253-1.194 3.578-1.196 1.323-.002 2.58.405 3.578 1.186a4.833 4.833 0 0 1 1.11 1.404c.253.492.409 1.024.47 1.577a4.51 4.51 0 0 1-.334 1.835 4.72 4.72 0 0 1-1.025 1.825z"></path></svg>`;

const STEP_ICON_BY_LABEL = {
  'Searching': MAGNIFIER_SVG, 'Searched': MAGNIFIER_SVG,
  'Finding': MAGNIFIER_SVG, 'Found': MAGNIFIER_SVG,
  'Looking closer at': MAGNIFIER_SVG, 'Looked closer at': MAGNIFIER_SVG,
  'Checking': MAGNIFIER_SVG, 'Checked': MAGNIFIER_SVG,
  'Reading': FILE_SVG, 'Read': FILE_SVG,
  'Inspecting': FILE_SVG, 'Inspected': FILE_SVG,
  'Getting': FILE_SVG, 'Got': FILE_SVG,
  'Exploring': FOLDER_SVG, 'Explored': FOLDER_SVG,
  'Listing': FOLDER_SVG, 'Listed': FOLDER_SVG,
};

// Blender rows: Python runs ("Running Python"/"Ran Python" + code chip),
// imports, render checks, and rows persisted before Python runs had their own
// label ("Worked in Blender"). Checked before the search labels so "Checking
// Blender render" joins the Blender box rather than a Search box.
const BLENDER_STEP_PATTERN = /^(?:Running|Ran) Python\b|\bBlender\b|^(?:Importing|Imported) animation\b/;

const GROUP_KINDS = {
  search: { title: 'Search', icon: MAGNIFIER_SVG },
  blender: { title: 'Blender', icon: BLENDER_SVG },
};

function blenderStepIcon(text) {
  if (/^(?:Running|Ran) Python\b/.test(text)) return TERMINAL_SVG;
  if (/^(?:Checking|Checked)\b/.test(text)) return IMAGE_SVG;
  return CUBE_SVG;
}

// Which box a status row folds into: 'blender', 'search', or null.
export function matchStepGroupKind(textOrLabel) {
  const text = String(textOrLabel || '').trim();
  if (BLENDER_STEP_PATTERN.test(text)) return 'blender';
  return matchSearchLabel(text) ? 'search' : null;
}

// Returns the matched search label when the status text/label starts with a
// search-like verb ('Reading', 'Read L120-140', 'Searched "door"'), else null.
export function matchSearchLabel(textOrLabel) {
  const text = String(textOrLabel || '').trim();
  for (const label of SEARCH_LABELS_BY_LENGTH) {
    if (text === label || text.startsWith(label + ' ')) return label;
  }
  return null;
}

// One-time delegated click handler: the group header toggles collapse.
export function installSearchGroupToggle() {
  if (window.__ropilotSearchGroupToggle) return;
  window.__ropilotSearchGroupToggle = true;
  document.addEventListener('click', (e) => {
    const header = e.target.closest?.('.search-group-header');
    if (!header) return;
    const group = header.closest('.message-search-group');
    if (!group) return;
    const collapsed = group.classList.toggle('collapsed');
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
}

// Coalesced pin of a group body's scroll to its end: scrollHeight reads force
// layout, so a synchronous read+write per appended step was O(n^2) across a
// history re-render. Any number of appends per frame produce one write each
// on the next frame (before paint, so visually identical).
const pendingBodyPins = new Set();
let bodyPinScheduled = false;
function pinGroupBodyToEnd(body) {
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

// Roll the header count toward the real step count instead of snapping.
// Parallel tool calls can land several steps in one frame, and the label
// jumping (38 -> 45) reads as a glitch; easing through the intermediate
// integers reads as progress. Only live appends animate — history re-renders
// must land settled, matching the reveal-animation policy in
// appendStepToGroup. A roll in flight is retargeted from wherever its
// displayed value currently is, so bursts stay one continuous count-up.
const COUNT_ROLL_MS = 450;
const countRolls = new WeakMap();

function formatStepCount(count) {
  return `${count} step${count === 1 ? '' : 's'}`;
}

function setGroupStepCount(groupEl, count, animate) {
  const countEl = groupEl.querySelector('.search-group-count');
  if (!countEl) return;
  const roll = countRolls.get(countEl);
  const shown = roll ? roll.shown : Number(countEl.dataset.shown || 0);
  // document.hidden: rAF is throttled or paused, so a roll could freeze at a
  // stale value until the window is next shown — snap instead.
  if (!animate || document.hidden || count <= shown) {
    if (roll) {
      cancelAnimationFrame(roll.raf);
      countRolls.delete(countEl);
    }
    countEl.dataset.shown = String(count);
    countEl.textContent = formatStepCount(count);
    return;
  }
  if (roll) {
    roll.from = roll.shown;
    roll.to = count;
    roll.startedAt = performance.now();
    return;
  }
  const state = { from: shown, to: count, shown, startedAt: performance.now(), raf: 0 };
  const tick = (now) => {
    const t = Math.min(1, (now - state.startedAt) / COUNT_ROLL_MS);
    const eased = 1 - (1 - t) ** 3;
    state.shown = Math.round(state.from + (state.to - state.from) * eased);
    countEl.dataset.shown = String(state.shown);
    countEl.textContent = formatStepCount(state.shown);
    if (t < 1 && countEl.isConnected) {
      state.raf = requestAnimationFrame(tick);
    } else {
      countRolls.delete(countEl);
    }
  };
  countRolls.set(countEl, state);
  state.raf = requestAnimationFrame(tick);
}

function createGroupElement(kind) {
  const { title, icon } = GROUP_KINDS[kind] || GROUP_KINDS.search;
  const el = document.createElement('div');
  // Every kind shares the Search box styling (.message-search-group).
  el.className = `message assistant message-search-group message-${kind}-group`;
  el.dataset.groupKind = kind;
  el.innerHTML = `
    <div class="search-group-box">
      <button class="search-group-header" type="button" aria-expanded="true">
        <span class="search-group-icon">${icon}</span>
        <span class="search-group-title">${title}</span>
        <span class="search-group-count"></span>
        <span class="search-group-chevron">${CHEVRON_SVG}</span>
      </button>
      <div class="search-group-drawer">
        <div class="search-group-clip">
          <div class="search-group-body"></div>
        </div>
      </div>
    </div>
  `;
  return el;
}

// Leading step-kind icon inside the row. Hidden by CSS while the row is
// active (the spinner occupies that slot), shown once the row finalizes.
function ensureStepIcon(statusEl) {
  const content = statusEl.querySelector('.status-content');
  if (!content || content.querySelector('.search-step-icon')) return;
  const labelSource = statusEl.dataset.label
    || statusEl.querySelector('.status-text')?.textContent
    || '';
  const icon = document.createElement('span');
  icon.className = 'search-step-icon';
  icon.innerHTML = statusEl.dataset.stepGroup === 'blender'
    ? blenderStepIcon(labelSource.trim())
    : STEP_ICON_BY_LABEL[matchSearchLabel(labelSource)] || MAGNIFIER_SVG;
  content.insertBefore(icon, content.firstChild);
}

// Split a finalized plain-text step into verb + target spans so the verb can
// render muted and the target bright. Skips structured rows (code chips,
// script icons) and live rows (their text is still changing).
export function refineSearchStepText(statusEl) {
  if (statusEl?.dataset?.searchStep !== '1') return;
  if (!statusEl.classList.contains('status-done')) return;
  const textEl = statusEl.querySelector('.status-text');
  if (!textEl || textEl.querySelector('code, img, .search-step-target')) return;
  const text = textEl.textContent.trim();
  const label = matchSearchLabel(text);
  if (!label || text === label) return;
  const target = text.slice(label.length).trim();
  textEl.innerHTML = `<span class="search-step-verb">${escapeHtml(label)}</span> <span class="search-step-target">${escapeHtml(target)}</span>`;
}

function appendStepToGroup(groupEl, statusEl) {
  const body = groupEl.querySelector('.search-group-body');
  if (!body) return;
  ensureStepIcon(statusEl);
  refineSearchStepText(statusEl);
  // Parallel tool calls can land a burst of steps in the same frame; cascade
  // their entrance (slide-open animation + delay) so the box still reads
  // step-by-step. DOM insertion stays immediate — only the reveal is
  // staggered. Only live rows (status-active) animate: history re-renders
  // must land at full height instantly, or the renderer's scroll-to-bottom
  // measures height-0 rows and settles short of the real bottom.
  if (statusEl.classList.contains('status-active')) {
    statusEl.classList.add('search-step-animate');
    const now = performance.now();
    const lastReveal = Number(groupEl.dataset.lastRevealAt || 0);
    const revealAt = Math.max(now, lastReveal + 140);
    groupEl.dataset.lastRevealAt = String(revealAt);
    const revealDelay = Math.max(0, Math.round(revealAt - now));
    statusEl.style.animationDelay = `${revealDelay}ms`;
    // The row is height-0 until it slides open — once it has, re-pin the
    // card body AND the chat scroller (the page grew after the scroll
    // position was computed at insert time; without this the newest content
    // sits slightly below the fold, seen on macOS).
    setTimeout(() => {
      body.scrollTop = body.scrollHeight;
      const scroller = getChatMessagesScroller();
      const nearBottom = !scroller
        || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      if (nearBottom) scrollChatMessagesToEnd();
    }, revealDelay + 360);
  }
  body.appendChild(statusEl);
  setGroupStepCount(groupEl, body.children.length, statusEl.classList.contains('status-active'));
  // Keep the newest step visible inside the capped-height body.
  pinGroupBodyToEnd(body);
}

// Append a status row to the chat, folding consecutive rows of the same kind
// (matchStepGroupKind: 'search' or 'blender') into one box. A lone row stays a
// plain row; the box appears when a second consecutive one lands (the first
// row is moved inside).
export function placeStatusElement(container, statusEl, groupKind) {
  if (!groupKind) {
    container.appendChild(statusEl);
    return;
  }
  const kind = groupKind === 'blender' ? 'blender' : 'search';
  statusEl.dataset.stepGroup = kind;
  if (kind === 'search') statusEl.dataset.searchStep = '1';
  const last = container.lastElementChild;
  if (last?.dataset?.groupKind === kind) {
    appendStepToGroup(last, statusEl);
    return;
  }
  if (last?.dataset?.stepGroup === kind) {
    const group = createGroupElement(kind);
    container.replaceChild(group, last);
    appendStepToGroup(group, last);
    appendStepToGroup(group, statusEl);
    return;
  }
  container.appendChild(statusEl);
}
