// Diff Preview - handles script diff display and rollback functionality
import { escapeHtml, highlightLua, truncateMiddle, getScriptIcon, inferScriptTypeFromPath, scrollChatMessagesToEnd } from './utils.js';
import { store } from './state-store.js';
import { resolveEdgeUrlForApiKey } from './api-validation.js';
import { electronAPI } from './core/platform.js';
import { localApiFetch } from './local-api-auth.js';

// Cap on syntax-highlighted lines per diff card: highlightLua's regex passes
// stall history rendering on full-file rewrites, so the tail past this cap
// renders as escaped plain text (every line still renders — only coloring stops).
const MAX_HIGHLIGHTED_DIFF_LINES = 300;

// 32-bit FNV-1a over UTF-16 code units
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// Cheap dedup signature over the same tuple the old content comparison used:
// (chatMessageIndex, path, originalContent, editedContent), falling back to
// (chatMessageIndex, path, diff) when contents are absent. The 'diff:' tag
// guarantees a content-branch signature can never equal a diff-branch one.
export function computeDiffSignature(data) {
  if (!data || typeof data !== 'object') return '';
  const path = String(data.path || data.fileName || '').replace(/\\/g, '/').trim();
  const mi = data.chatMessageIndex ?? '';
  const original = typeof data.originalContent === 'string' ? data.originalContent : '';
  const edited = typeof data.editedContent === 'string' ? data.editedContent : '';
  if (path && (original || edited)) {
    return `d2:${mi}:${fnv1a(original)}-${original.length}:${fnv1a(edited)}-${edited.length}:${path}`;
  }
  const diffStr = JSON.stringify(Array.isArray(data.diff) ? data.diff : []);
  return `d2:${mi}:diff:${fnv1a(diffStr)}-${diffStr.length}:${path}`;
}

// Whitelist of persisted timeline-diff fields. Deliberately drops
// originalContent/editedContent — rollback keeps those in chat.diffs, not the
// timeline — and the diff line array is stored verbatim (renderers show every
// line and Open-in-Studio needs real lineNums; the server already context-limits it).
export function buildCompactDiffContent(data) {
  const src = data && typeof data === 'object' ? data : {};
  const compact = {
    messageId: src.messageId,
    path: src.path,
    fileName: src.fileName,
    scriptType: src.scriptType,
    isFileSync: !!src.isFileSync,
    diff: Array.isArray(src.diff) ? src.diff : []
  };
  if (src.chatMessageIndex != null) compact.chatMessageIndex = src.chatMessageIndex;
  if (src.localPath) compact.localPath = src.localPath;
  return compact;
}

// In-place migration of a legacy timeline diff item to the compact v2 format.
// Returns true iff the item was modified. Idempotent; safe no-op on non-diff
// items, null/undefined, and unparseable content (renderers tolerate those).
export function compactDiffTimelineItem(item) {
  if (!item || item.type !== 'diff') return false;
  if (item.v === 2 && typeof item.sig === 'string' && item.sig) return false;
  let parsed = null;
  if (item.content && typeof item.content === 'object') {
    parsed = item.content;
  } else if (typeof item.content === 'string') {
    try {
      parsed = JSON.parse(item.content);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== 'object') return false;
  // Signature MUST be derived before stripping contents so legacy items get
  // the content-branch signature that future incoming payloads will match.
  const sig = computeDiffSignature(parsed);
  // content stays a JSON string: message-editor's rewind logging calls
  // item.content?.substring on every timeline item and an object would throw.
  item.content = JSON.stringify(buildCompactDiffContent(parsed));
  item.v = 2;
  item.sig = sig;
  return true;
}

// Cap chat.diffs rollback entries, evicting oldest entries in whole
// chatMessageIndex groups only — a partially evicted turn would revert files
// to intermediate contents on "Rewind and Revert", which is worse than not
// reverting them at all. The newest/only remaining group is never evicted.
export function enforceDiffRollbackCap(chat, cap = 200) {
  const diffs = chat?.diffs;
  if (!Array.isArray(diffs) || diffs.length <= cap) return false;
  let evicted = 0;
  while (diffs.length > cap) {
    const groupIndex = diffs[0]?.chatMessageIndex;
    if (!diffs.some(d => d?.chatMessageIndex !== groupIndex)) break; // sole group left
    let n = 0;
    while (n < diffs.length && diffs[n]?.chatMessageIndex === groupIndex) n++;
    if (n === 0) break; // corrupt leading entry (e.g. NaN index) — stop rather than loop
    diffs.splice(0, n);
    evicted += n;
  }
  if (evicted === 0) return false;
  console.warn(`[DIFF STORAGE] Evicted ${evicted} oldest rollback diff entries (cap ${cap})`);
  return true;
}

function renderDiffLinesHtml(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return '<div class="diff-line diff-unchanged"><span class="diff-linenum"></span><span class="diff-prefix"></span><span class="diff-code">No line-level diff was provided for this edit.</span></div>';
  }

  return lines.map((line, index) => {
    if (line.type === 'separator') {
      return `<div class="diff-line diff-separator"><span class="diff-linenum"></span><span class="diff-prefix"></span><span class="diff-code">...</span></div>`;
    }
    const highlighted = index < MAX_HIGHLIGHTED_DIFF_LINES
      ? highlightLua(line.content || '')
      : escapeHtml(line.content || '');
    const lineNum = line.lineNum > 0 ? `<span class="diff-linenum">${line.lineNum}</span>` : '<span class="diff-linenum"></span>';
    const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
    const type = line.type === 'added' || line.type === 'removed'
      ? line.type
      : 'unchanged';
    return `<div class="diff-line diff-${type}">${lineNum}<span class="diff-prefix">${prefix}</span><span class="diff-code">${highlighted}</span></div>`;
  }).join('');
}

// Collapsed-start cards defer line rendering (and Lua highlighting) until
// first expand. The lines ride along inside an inert JSON script tag because
// callers insert the card via innerHTML and only wire the collapse toggle.
function buildLazyDiffBodyHtml(lines) {
  // Escape '<' so the payload can never close the script tag.
  const json = JSON.stringify(Array.isArray(lines) ? lines : []).replace(/</g, '\\u003c');
  return `<script type="application/json">${json}</script>`;
}

function hydrateLazyDiffBody(body) {
  let lines = [];
  try {
    lines = JSON.parse(body.querySelector('script[type="application/json"]')?.textContent || '[]');
  } catch {
    lines = [];
  }
  body.removeAttribute('data-lazy-diff');
  body.innerHTML = renderDiffLinesHtml(lines);
}

let lazyDiffExpandListenerInstalled = false;
function ensureLazyDiffExpandListener() {
  if (lazyDiffExpandListenerInstalled || typeof document === 'undefined') return;
  lazyDiffExpandListenerInstalled = true;
  // Capture phase so hydration runs regardless of the toggle's own handler.
  document.addEventListener('click', (e) => {
    const toggle = e.target?.closest?.('.inline-diff-toggle');
    if (!toggle) return;
    const body = toggle.closest('.inline-diff')?.querySelector('.inline-diff-body[data-lazy-diff]');
    if (body) hydrateLazyDiffBody(body);
  }, true);
}

export class DiffPreview {
  constructor(app) {
    this.app = app;
  }

  normalizeDiffLines(data) {
    return Array.isArray(data?.diff) ? data.diff : [];
  }

  renderDiffLines(lines) {
    return renderDiffLinesHtml(lines);
  }

  getDiffStats(lines) {
    let addedCount = 0;
    let removedCount = 0;
    for (const line of Array.isArray(lines) ? lines : []) {
      if (line.type === 'added') addedCount++;
      if (line.type === 'removed') removedCount++;
    }
    return { addedCount, removedCount };
  }

  getDiffSignature(data) {
    return computeDiffSignature(data);
  }

  parseStoredDiffContent(content) {
    if (!content) return null;
    if (typeof content === 'object') return content;
    if (typeof content !== 'string') return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  hasDuplicateDiff(targetChat, data, incomingSig) {
    const sig = incomingSig || computeDiffSignature(data);
    if (!targetChat || !sig) return false;

    const timeline = Array.isArray(targetChat.timeline) ? targetChat.timeline : [];
    for (const item of timeline) {
      if (item?.type !== 'diff') continue;
      let itemSig = item.sig;
      if (!itemSig) {
        // Legacy item not yet migrated — derive from stored content (contents
        // still present, so this matches incoming content-branch sigs) and
        // cache so each legacy item is parsed at most once ever.
        const existing = this.parseStoredDiffContent(item.content);
        if (!existing) continue;
        itemSig = computeDiffSignature(existing);
        item.sig = itemSig;
      }
      if (itemSig === sig) return true;
    }
    return false;
  }

  getOpenStudioButtonMarkup(isClickable) {
    if (!isClickable) return '';

    return `
      <button
        type="button"
        class="inline-diff-open-studio"
        data-open-script-trigger="true"
        title="Open in Studio"
        aria-label="Open in Studio"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 4h6v6"/>
          <path d="M10 14L20 4"/>
          <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/>
        </svg>
        <span>Open in Studio</span>
      </button>
    `;
  }

  // Get display name for diff header based on script type
  getDisplayName(data) {
    const fileName = data.fileName || 'Script.lua';
    const scriptPath = data.path || fileName;

    // Use provided scriptType, or infer from path if not provided (for backward compat with old saved diffs)
    const scriptType = data.scriptType || inferScriptTypeFromPath(scriptPath, fileName);

    // If file sync mode (Rojo/local files), the backend sends localPath
    // Use the path directly for display (it's already the relative file path)
    if (data.localPath) {
      // The path field already contains the relative path from the backend
      // Just normalize and use it
      const displayPath = scriptPath.replace(/\\/g, '/');
      return escapeHtml(displayPath);
    }

    // For sourcecontrol mode, show truncated Studio path (middle truncation to preserve script name)
    return escapeHtml(truncateMiddle(scriptPath, 45));
  }

  show(data) {
    // Delegate to the method that handles chat targeting
    this.showToChat(data, this.app.activeChat, true);
  }

  close() {
    // Legacy modal close - keep for backward compatibility
    document.getElementById('diff-modal')?.classList.add('hidden');
  }

  // Show diff preview to a specific chat (handles case where user switched away during processing)
  showToChat(data, targetChat, shouldUpdateUI) {
    const fileName = data.fileName || 'Script.lua';
    const scriptPath = data.path || fileName;
    const scriptType = data.scriptType || inferScriptTypeFromPath(scriptPath, fileName);

    const sig = computeDiffSignature(data);
    if (this.hasDuplicateDiff(targetChat, data, sig)) {
      console.log('[DIFF STORAGE] Skipping duplicate diff:', {
        messageId: data.messageId,
        chatMessageIndex: data.chatMessageIndex,
        scriptPath: scriptPath,
      });
      return;
    }

    // Store diff for rollback functionality (with full content for restoring)
    if (targetChat && data.originalContent !== undefined && data.editedContent !== undefined) {
      if (!targetChat.diffs) {
        targetChat.diffs = [];
      }
      const diffEntry = {
        messageId: data.messageId,
        chatMessageIndex: data.chatMessageIndex,
        scriptPath: scriptPath,
        fileName: fileName,
        originalContent: data.originalContent,
        editedContent: data.editedContent,
        timestamp: Date.now(),
        // Include localPath, scriptType, and isFileSync for rollback routing
        localPath: data.localPath || null,
        scriptType: scriptType,
        isFileSync: !!data.isFileSync
      };
      targetChat.diffs.push(diffEntry);
      enforceDiffRollbackCap(targetChat);
      console.log('[DIFF STORAGE] Stored diff for rollback:', {
        messageId: data.messageId,
        chatMessageIndex: data.chatMessageIndex,
        scriptPath: scriptPath,
        localPath: data.localPath || null,
        scriptType: scriptType,
        totalDiffs: targetChat.diffs.length
      });

      // Store path mapping (local path -> game path) for status hints
      if (data.localPath && scriptPath) {
        if (!targetChat.pathMappings) {
          targetChat.pathMappings = {};
        }
        targetChat.pathMappings[data.localPath] = scriptPath;
        console.log('[PATH MAPPING] Stored:', data.localPath, '->', scriptPath);
      }

      // Mark chat for full update since we modified metadata (diffs/pathMappings)
      this.app.projectManager.markChatForFullUpdate(targetChat.id);
    }

    // Save diff to timeline in the compact v2 format (no original/edited
    // contents — rollback data lives in chat.diffs above).
    if (targetChat) {
      this.app.addToTimeline({
        type: 'diff',
        v: 2,
        sig: sig,
        content: JSON.stringify(buildCompactDiffContent(data)),
        fileName: fileName,
        path: scriptPath,
        scriptType: scriptType
      }, targetChat);
    }

    // Save chats to persist the diff data
    this.app.saveChats();

    // Only update UI if still on the processing chat
    if (shouldUpdateUI) {
      this.showUI(data, scriptPath, fileName, scriptType);
    }
  }

  // Show diff preview UI elements (separated for reuse)
  showUI(data, scriptPath, fileName, scriptType) {
    const container = document.getElementById('messages');
    if (!container) return;

    const displayName = this.getDisplayName(data);
    const icon = getScriptIcon(scriptType);

    const diffLinesData = this.normalizeDiffLines(data);
    const { addedCount, removedCount } = this.getDiffStats(diffLinesData);
    const diffLines = this.renderDiffLines(diffLinesData);

    // Filename is clickable if we have a script path (works in both sourcecontrol and file sync modes)
    const isClickable = !!scriptPath;
    const clickableClass = isClickable ? ' clickable' : '';
    const dataOpenTrigger = isClickable ? ' data-open-script-trigger="true"' : '';

    // Create inline diff element
    const diffEl = document.createElement('div');
    diffEl.className = 'message assistant';
    diffEl.innerHTML = `
      <div class="inline-diff" data-message-id="${data.messageId || ''}" data-script-type="${scriptType}">
        <div class="inline-diff-header">
          <div class="inline-diff-info">
            ${icon}
            <span class="inline-diff-filename${clickableClass}" title="${escapeHtml(scriptPath)}"${dataOpenTrigger}>${displayName}</span>
          </div>
          <div class="inline-diff-actions">
            ${this.getOpenStudioButtonMarkup(isClickable)}
            <div class="inline-diff-stats">
              ${addedCount > 0 ? `<span class="stat-added">+${addedCount}</span>` : ''}
              ${removedCount > 0 ? `<span class="stat-removed">-${removedCount}</span>` : ''}
            </div>
            <button class="inline-diff-toggle" title="Collapse/Expand">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="inline-diff-body">
          ${diffLines}
        </div>
      </div>
    `;

    // Add toggle functionality
    const toggleBtn = diffEl.querySelector('.inline-diff-toggle');
    const inlineDiff = diffEl.querySelector('.inline-diff');
    toggleBtn.onclick = () => {
      inlineDiff.classList.toggle('collapsed');
    };

    this.bindOpenInStudioTriggers(diffEl, data, scriptPath);

    // Insert before the active status message if present, otherwise at end
    const statusEl = container.querySelector('.message-status.status-active');
    if (statusEl) {
      container.insertBefore(diffEl, statusEl);
    } else {
      container.appendChild(diffEl);
    }

    // Scroll to show the new diff
    scrollChatMessagesToEnd();
    // Live diff cards land outside appendElement, so trim the mounted DOM
    // here too (edit-heavy turns mount one card per script edit).
    this.app.messageRenderer?.enforceLiveMountedItemCap?.();
  }

  // Render a saved diff message (for history). Callers pass
  // startExpanded=false for all but the newest few cards so a card-heavy
  // window doesn't render/highlight every body up front.
  renderMessage(diffData, startExpanded = true) {
    const data = typeof diffData === 'string' ? JSON.parse(diffData) : diffData;
    const fileName = data.fileName || 'Script.lua';
    const scriptPath = data.path || fileName;

    // Use provided scriptType, or infer from path (handles older saved diffs without scriptType)
    const scriptType = data.scriptType || inferScriptTypeFromPath(scriptPath, fileName);

    const displayName = this.getDisplayName(data);
    const icon = getScriptIcon(scriptType);

    const diffLinesData = this.normalizeDiffLines(data);
    const { addedCount, removedCount } = this.getDiffStats(diffLinesData);

    // Collapsed-start cards keep the body empty (lines stashed as inert JSON)
    // and render it on first expand — skips highlighting hidden content.
    let diffLines;
    let lazyBodyAttr = '';
    if (startExpanded) {
      diffLines = this.renderDiffLines(diffLinesData);
    } else {
      ensureLazyDiffExpandListener();
      diffLines = buildLazyDiffBodyHtml(diffLinesData);
      lazyBodyAttr = ' data-lazy-diff="1"';
    }

    const collapsedClass = startExpanded ? '' : ' collapsed';

    // Filename is clickable if we have a script path (works in both sourcecontrol and file sync modes)
    const isClickable = !!scriptPath;
    const clickableClass = isClickable ? ' clickable' : '';
    const dataOpenTrigger = isClickable ? ' data-open-script-trigger="true"' : '';

    return `
      <div class="inline-diff${collapsedClass}" data-script-type="${scriptType}">
        <div class="inline-diff-header">
          <div class="inline-diff-info">
            ${icon}
            <span class="inline-diff-filename${clickableClass}" title="${escapeHtml(scriptPath)}"${dataOpenTrigger}>${displayName}</span>
          </div>
          <div class="inline-diff-actions">
            ${this.getOpenStudioButtonMarkup(isClickable)}
            <div class="inline-diff-stats">
              ${addedCount > 0 ? `<span class="stat-added">+${addedCount}</span>` : ''}
              ${removedCount > 0 ? `<span class="stat-removed">-${removedCount}</span>` : ''}
            </div>
            <button class="inline-diff-toggle" title="Collapse/Expand">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="inline-diff-body"${lazyBodyAttr}>
          ${diffLines}
        </div>
      </div>
    `;
  }

  bindOpenInStudioTriggers(rootEl, diffData, scriptPath) {
    if (!rootEl || !scriptPath) return;

    const range = this.getFirstChangeRange(diffData);
    const openInStudio = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openScriptInStudio(scriptPath, range?.startLine, range?.endLine);
    };

    rootEl.addEventListener('click', (e) => {
      const trigger = e.target?.closest?.('[data-open-script-trigger="true"]');
      if (!trigger || !rootEl.contains(trigger)) return;
      openInStudio(e);
    });
  }

  // Extract the line range of the first changed region from diff data
  getFirstChangeRange(diffData) {
    const lines = this.normalizeDiffLines(diffData);
    if (!lines || lines.length === 0) return null;

    let startLine = 0;
    let endLine = 0;
    let lastContextLineNum = 0;
    let inChangeBlock = false;

    for (const line of lines) {
      if (line.type === 'context' || line.type === 'separator') {
        if (line.lineNum > 0) lastContextLineNum = line.lineNum;
        if (inChangeBlock) break; // end of first change group
        continue;
      }

      // added or removed
      inChangeBlock = true;

      if (line.type === 'added' && line.lineNum > 0) {
        if (startLine === 0) startLine = line.lineNum;
        endLine = line.lineNum;
      } else if (line.type === 'removed' && startLine === 0) {
        // For removed lines, use the preceding context line's lineNum
        startLine = lastContextLineNum > 0 ? lastContextLineNum : 1;
        endLine = startLine;
      }
    }

    return startLine > 0 ? { startLine, endLine } : null;
  }

  // Open a script in Roblox Studio's script editor
  async openScriptInStudio(scriptPath, startLine, endLine) {
    const effectiveKey = this.app.getEffectiveApiKey();
    console.log('[openScriptInStudio] Called with scriptPath:', scriptPath);
    console.log('[openScriptInStudio] API key present:', !!effectiveKey);

    if (!effectiveKey) {
      console.warn('Cannot open script in Studio: no API key');
      return;
    }

    try {
      const response = await localApiFetch('http://localhost:8765/open-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: scriptPath,
          api_key: effectiveKey,
          start_line: startLine || 0,
          end_line: endLine || 0
        })
      });

      const result = await response.json();
      console.log('[openScriptInStudio] Response:', result);
      if (!result.success) {
        console.error('Failed to open script in Studio:', result.error);
      } else {
        console.log('[openScriptInStudio] Successfully sent open request');
      }
    } catch (err) {
      console.error('Failed to open script in Studio:', err);
    }
  }

  // Restore a script to its original content via edge server (for rollback)
  async restoreScriptViaEdge(scriptPath, originalContent) {
    const effectiveKey = this.app.getEffectiveApiKey();
    if (!effectiveKey) {
      console.warn('Cannot restore script: no API key');
      return false;
    }

    try {
      // Call dedicated restore-script endpoint (bypasses requestedScripts check)
      const edgeUrl = resolveEdgeUrlForApiKey(effectiveKey, this.app.config?.edgeUrl);
      const response = await fetch(`${edgeUrl}/restore-script/${effectiveKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: scriptPath,
          content: originalContent
        })
      });

      if (!response.ok) {
        console.error(`[RESTORE] Edge server returned ${response.status}`);
        return false;
      }

      const result = await response.json();

      // Check for error in response
      if (!result.success) {
        console.error('[RESTORE] Error:', result.error || result.message);
        return false;
      }

      console.log(`[RESTORE] Successfully restored: ${scriptPath}`);
      return true;
    } catch (err) {
      console.error(`[RESTORE] Failed to restore ${scriptPath}:`, err);
      return false;
    }
  }

  // Restore a local file to its original content (for file sync/Rojo mode rollback)
  // If originalContent is empty/null, the file didn't exist before - delete it instead
  async restoreLocalFile(localPath, originalContent) {
    if (!localPath) {
      console.warn('Cannot restore local file: no localPath provided');
      return false;
    }

    try {
      // If original content is empty/null, the file didn't exist before - delete it
      if (!originalContent || originalContent.trim() === '') {
        console.log(`[RESTORE LOCAL] File was newly created, deleting: ${localPath}`);
        const result = await electronAPI().deleteFile(localPath);

        if (!result.success) {
          console.error(`[RESTORE LOCAL] Failed to delete: ${result.error}`);
          return false;
        }

        console.log(`[RESTORE LOCAL] Successfully deleted: ${localPath}`);
        return true;
      }

      // File existed before - restore original content
      console.log(`[RESTORE LOCAL] Restoring file: ${localPath}`);
      const result = await electronAPI().writeFile(localPath, originalContent);

      if (!result.success) {
        console.error(`[RESTORE LOCAL] Failed: ${result.error}`);
        return false;
      }

      console.log(`[RESTORE LOCAL] Successfully restored: ${localPath}`);
      return true;
    } catch (err) {
      console.error(`[RESTORE LOCAL] Failed to restore ${localPath}:`, err);
      return false;
    }
  }
}
