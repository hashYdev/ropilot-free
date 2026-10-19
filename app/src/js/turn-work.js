// Turn Work - once a turn finishes, its work (status rows, Search/Blender
// boxes, reasoning, progress notes written between tool calls) folds behind
// one "Worked for 2m 57s" header, leaving the model's closing message as the
// turn's visible reply (Codex app parity). A live turn stays expanded so its
// progress shows as it happens; MessageRenderer re-renders when the turn
// ends, which folds it. Purely presentational: derived from the timeline at
// render time, never persisted.

const CHEVRON_RIGHT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>`;

// Turns the user opened, so re-renders keep them open (this session only).
const expandedTurnKeys = new Set();

// 45s, 2m 57s, 1h 5m
export function formatWorkedDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  const totalSeconds = Math.max(1, Math.round(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function finiteTimestamp(item) {
  const value = Number(item?.timestamp);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Decide which timeline items fold into their turn's work block.
//
// A turn is the run of items after a user message (steers included) up to
// the next one. In a finished turn, these fold:
//   - work items (isWork: status rows, reasoning, compaction, script diffs,
//     playtests), and
//   - text messages (isText) that more work follows in the same turn — the
//     progress notes. Text after the turn's last work is the answer and stays
//     visible, as do errors, previews and questions.
// A turn with no text after its last work (stopped mid-work) doesn't fold.
// Turns from liveFromIndex on are still running and never fold.
//
// Returns Map<item, turn> for the items that fold; items of one turn share
// the turn object ({ key, durationMs, reasoningOnly }).
export function planTurnWork(timeline, options = {}) {
  const folded = new Map();
  if (!Array.isArray(timeline)) return folded;
  const {
    startIndex = 0,
    liveFromIndex = timeline.length,
    isWork = () => false,
    isText = () => false,
  } = options;

  let segStart = 0;
  for (let i = 0; i <= timeline.length; i++) {
    const item = timeline[i];
    if (i < timeline.length && item?.type !== 'user') continue;
    // [segStart, i) is one turn; timeline[segStart - 1] is its user message.
    const segEnd = i;
    if (segEnd > startIndex && segStart < liveFromIndex && segEnd <= liveFromIndex) {
      foldSegment(timeline, segStart, segEnd, Math.max(segStart, startIndex), { isWork, isText }, folded);
    }
    segStart = i + 1;
  }
  return folded;
}

function foldSegment(timeline, segStart, segEnd, visibleStart, predicates, folded) {
  const { isWork, isText } = predicates;
  let lastWork = -1;
  for (let i = segEnd - 1; i >= segStart; i--) {
    if (isWork(timeline[i])) {
      lastWork = i;
      break;
    }
  }

  // No reply after the last work (the user stopped it, or it died mid-tool):
  // folding would leave the turn blank, so its work stays out.
  if (!turnEndsWithAnswer(timeline, segStart, predicates)) return;

  const members = [];
  let hasNonReasoningWork = false;
  for (let i = visibleStart; i < segEnd; i++) {
    const item = timeline[i];
    if (!item || typeof item !== 'object') continue;
    if (isWork(item)) {
      members.push(item);
      if (item.type !== 'thinking') hasNonReasoningWork = true;
    } else if (isText(item) && i < lastWork) {
      members.push(item);
    }
  }
  if (!members.some((item) => isWork(item))) return;

  const userItem = segStart > 0 ? timeline[segStart - 1] : null;
  let startedAt = finiteTimestamp(userItem);
  let endedAt = null;
  let recordedMs = null;
  for (let i = segStart; i < segEnd; i++) {
    const item = timeline[i];
    const ts = finiteTimestamp(item);
    if (ts !== null) {
      if (startedAt === null) startedAt = ts;
      if (endedAt === null || ts > endedAt) endedAt = ts;
    }
    // The turn clock captured at completion (only kept on charged turns).
    const recorded = Number(item?.actionDurationMs);
    if (Number.isFinite(recorded) && recorded > 0) recordedMs = Math.max(recordedMs || 0, recorded);
  }

  const turn = {
    key: String(userItem?.id || members[0].id || `turn-${segStart}`),
    durationMs: recordedMs ?? (startedAt !== null && endedAt !== null ? endedAt - startedAt : null),
    reasoningOnly: !hasNonReasoningWork,
  };
  for (const item of members) folded.set(item, turn);
}

// Whether the turn holding timeline[from] ends in text rather than work.
// Steers don't end a turn, so a segment before a steer looks past it.
function turnEndsWithAnswer(timeline, from, predicates) {
  const { isWork, isText } = predicates;
  let answered = false;
  for (let i = from; i < timeline.length; i++) {
    const item = timeline[i];
    if (item?.type === 'user') {
      if (item.bubbleVariant !== 'steer') break;
      continue;
    }
    if (isWork(item)) answered = false;
    else if (isText(item)) answered = true;
  }
  return answered;
}

export function turnWorkLabel(turn) {
  const verb = turn?.reasoningOnly ? 'Thought' : 'Worked';
  const duration = formatWorkedDuration(turn?.durationMs);
  return duration ? `${verb} for ${duration}` : verb;
}

// The fold: a quiet header line that toggles the work log, ruled off from the
// answer below. Work elements go in .turn-work-body; the drawer/clip wrappers
// let CSS animate the open/close height (turn-work.css).
export function createTurnWorkElement(turn) {
  const expanded = expandedTurnKeys.has(turn.key);
  const el = document.createElement('div');
  el.className = `message assistant turn-work${expanded ? ' expanded' : ''}`;
  el.dataset.turnKey = turn.key;
  el.innerHTML = `
    <button class="turn-work-header" type="button" aria-expanded="${expanded ? 'true' : 'false'}">
      <span class="turn-work-label"></span>
      <span class="turn-work-chevron">${CHEVRON_RIGHT_SVG}</span>
    </button>
    <div class="turn-work-drawer">
      <div class="turn-work-clip">
        <div class="turn-work-body"></div>
      </div>
    </div>
  `;
  el.querySelector('.turn-work-label').textContent = turnWorkLabel(turn);
  return el;
}

// A turn that just finished was on screen expanded: start its fold open and
// let it close on the next frames, so the work visibly folds away. Folds the
// user opened themselves stay open.
export function animateTurnWorkClosing(block) {
  if (!block || expandedTurnKeys.has(block.dataset.turnKey)) return;
  block.classList.add('expanded');
  // Two frames: the open state must be styled once before the transition.
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (expandedTurnKeys.has(block.dataset.turnKey)) return;
    block.classList.remove('expanded');
  }));
}

// One-time delegated click handler: the header opens/closes the work log.
export function installTurnWorkToggle() {
  if (window.__ropilotTurnWorkToggle) return;
  window.__ropilotTurnWorkToggle = true;
  document.addEventListener('click', (e) => {
    const header = e.target.closest?.('.turn-work-header');
    if (!header) return;
    const block = header.closest('.turn-work');
    if (!block) return;
    const expanded = block.classList.toggle('expanded');
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const key = block.dataset.turnKey;
    if (key) {
      if (expanded) expandedTurnKeys.add(key);
      else expandedTurnKeys.delete(key);
    }
  });
}
