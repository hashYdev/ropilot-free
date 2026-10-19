// Utility functions

/** Scroll container for the chat timeline (full-width scrollbar). */
export function getChatMessagesScroller() {
  return document.getElementById('chat-messages-scroll');
}

// Auto-scroll pinning: the distance from the bottom is sampled on scroll
// events (not on DOM appends), so at append time it still reflects the user's
// position from BEFORE the new content landed — appended height can't unpin.
const SCROLL_PIN_THRESHOLD_PX = 120;
const scrollTrackedEls = new WeakSet();
let scrollTrackedEl = null;
let scrollDistanceFromBottom = 0;
let scrollWritePending = false;
let scrollWriteForced = false;

function measureScrollDistanceFromBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function ensureScrollTracking(el) {
  if (scrollTrackedEl !== el) {
    scrollTrackedEl = el;
    scrollDistanceFromBottom = measureScrollDistanceFromBottom(el);
  }
  if (scrollTrackedEls.has(el)) return;
  scrollTrackedEls.add(el);
  el.addEventListener('scroll', () => {
    if (scrollTrackedEl === el) {
      scrollDistanceFromBottom = measureScrollDistanceFromBottom(el);
    }
  }, { passive: true });
}

export function isChatScrollPinnedToBottom() {
  const el = getChatMessagesScroller();
  if (!el) return true;
  ensureScrollTracking(el);
  return scrollDistanceFromBottom <= SCROLL_PIN_THRESHOLD_PX;
}

// Coalesced: any number of calls per frame produce a single scroll write on
// the next frame (scrollHeight reads force layout, so per-append writes were
// O(n^2) across a turn). Unforced calls are skipped while the user has
// scrolled up so streaming output doesn't yank them back down; pass
// { force: true } to pin regardless (e.g. the user just sent a message).
export function scrollChatMessagesToEnd(options = {}) {
  const el = getChatMessagesScroller();
  if (!el) return;
  ensureScrollTracking(el);
  if (options.force === true) scrollWriteForced = true;
  if (scrollWritePending) return;
  scrollWritePending = true;
  window.requestAnimationFrame(() => {
    scrollWritePending = false;
    const forced = scrollWriteForced;
    scrollWriteForced = false;
    const target = getChatMessagesScroller();
    if (!target) return;
    ensureScrollTracking(target);
    if (!forced && scrollDistanceFromBottom > SCROLL_PIN_THRESHOLD_PX) return;
    target.scrollTop = target.scrollHeight;
    scrollDistanceFromBottom = measureScrollDistanceFromBottom(target);
  });
}

// Synchronous variant for full re-renders: the container was just rebuilt, so
// the write must land before paint and must ignore prior scroll position.
export function scrollChatMessagesToEndNow() {
  const el = getChatMessagesScroller();
  if (!el) return;
  ensureScrollTracking(el);
  el.scrollTop = el.scrollHeight;
  scrollDistanceFromBottom = measureScrollDistanceFromBottom(el);
}

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function createRipple(event, button) {
  const circle = document.createElement('span');
  const diameter = Math.max(button.clientWidth, button.clientHeight);
  const radius = diameter / 2;
  const rect = button.getBoundingClientRect();

  circle.style.width = circle.style.height = `${diameter}px`;
  circle.style.left = `${event.clientX - rect.left - radius}px`;
  circle.style.top = `${event.clientY - rect.top - radius}px`;
  circle.classList.add('ripple');

  const ripple = button.querySelector('.ripple');
  if (ripple) ripple.remove();

  button.appendChild(circle);
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function toPastTense(label) {
  const pastTenseMap = {
    'Exploring': 'Explored',
    'Searching': 'Searched',
    'Looking closer at': 'Looked closer at',
    'Reading': 'Read',
    'Writing': 'Wrote',
    'Editing': 'Edited',
    'Running Studio command': 'Ran Studio command',
    'Running': 'Ran',
    'Installing': 'Installed',
    'Importing': 'Imported',
    'Building': 'Built',
    'Testing': 'Tested',
    'Fetching': 'Fetched',
    'Connecting': 'Connected',
    'Downloading': 'Downloaded',
    'Uploading': 'Uploaded',
    'Creating': 'Created',
    'Deleting': 'Deleted',
    'Updating': 'Updated',
    'Loading': 'Loaded',
    'Listing': 'Listed',
    'Saving': 'Saved',
    'Analyzing': 'Analyzed',
    'Processing': 'Processed',
    'Compiling': 'Compiled',
    'Executing': 'Executed',
    'Cloning': 'Cloned',
    'Pushing': 'Pushed',
    'Pulling': 'Pulled',
    'Committing': 'Committed',
    'Compacting': 'Compacted',
    'Thinking': 'Thought',
    'Checking': 'Checked',
    'Verifying': 'Verified',
    'Inspecting': 'Inspected',
    'Getting': 'Got',
    'Starting': 'Started',
    'Stopping': 'Stopped',
    'Finding': 'Found',
    'Moving': 'Moved',
    'Resetting': 'Reset',
    'Working': 'Worked',
    'Onboarding': 'Onboarded'
  };
  // Try exact match first
  if (pastTenseMap[label]) return pastTenseMap[label];
  // For multi-word labels, convert just the first word
  const spaceIdx = label.indexOf(' ');
  if (spaceIdx > 0) {
    const firstWord = label.substring(0, spaceIdx);
    const rest = label.substring(spaceIdx);
    if (pastTenseMap[firstWord]) {
      return pastTenseMap[firstWord] + rest;
    }
  }
  return label;
}

export function truncateMiddle(str, maxLen = 40) {
  if (!str || str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 3) / 2);
  return str.slice(0, half) + '...' + str.slice(-half);
}

// Inline code chip for the Lua source of a Studio run-command status line.
// Collapsed to a single truncated line by CSS; clicking toggles .expanded
// (delegated document-level handler in StatusManager). The optional output
// (relayed tool result) renders as a drawer that CSS reveals while expanded.
export function statusCommandHTML(command, output) {
  if (typeof command !== 'string' || !command.trim()) return '';
  let html = ` <code class="status-command" title="Click to expand">${escapeHtml(command.trim())}</code>`;
  if (typeof output === 'string' && output.trim()) {
    html += `<div class="status-command-output"><div class="status-command-output-label">Output</div><pre class="status-command-output-text">${escapeHtml(output)}</pre></div>`;
  }
  return html;
}

export function isTempPath(path) {
  if (!path) return false;
  const normalized = path.toLowerCase().replace(/\\/g, '/');
  return normalized.includes('/temp/') ||
         normalized.includes('/tmp/') ||
         normalized.includes('/var/folders/') ||
         normalized.includes('appdata/local/temp/');
}

const LUA_BLUE_DOT_RECEIVERS = [
  'Axes', 'BitBuffer', 'BrickColor', 'buffer', 'CatalogSearchParams', 'CFrame',
  'Color3', 'ColorSequence', 'ColorSequenceKeypoint', 'coroutine', 'DateTime',
  'debug', 'DockWidgetPluginGuiInfo', 'Enum', 'Faces', 'FloatCurveKey', 'Font',
  'Instance', 'math', 'NumberRange', 'NumberSequence', 'NumberSequenceKeypoint',
  'os', 'OverlapParams', 'PathWaypoint', 'PhysicalProperties', 'Random', 'Ray',
  'RaycastParams', 'Rect', 'Region3', 'Region3int16', 'RotationCurveKey', 'string',
  'table', 'task', 'TweenInfo', 'UDim', 'UDim2', 'utf8', 'Vector2',
  'Vector2int16', 'Vector3', 'Vector3int16'
];
const LUA_BLUE_GLOBALS = ['game', 'shared'];
const LUA_HIGHLIGHT_SKIP_CLASSES = [
  'hljs-string', 'hljs-comment', 'hljs-quote', 'hljs-meta',
  'lua-string', 'lua-comment'
];

function replaceHtmlTextSegments(html, replacer, skipClasses = []) {
  const skipPatterns = skipClasses.map(className => new RegExp(`(?:^|\\s)${className}(?:\\s|$)`));
  const classStack = [];

  return html
    .split(/(<[^>]+>)/g)
    .map((segment) => {
      if (!segment) return segment;
      if (segment.startsWith('<')) {
        if (/^<\/span/i.test(segment)) {
          classStack.pop();
          return segment;
        }

        const openSpanMatch = segment.match(/^<span\b[^>]*class="([^"]+)"/i);
        if (openSpanMatch) {
          classStack.push(openSpanMatch[1]);
        }
        return segment;
      }

      const shouldSkip = classStack.some(className => skipPatterns.some(pattern => pattern.test(className)));
      return shouldSkip ? segment : replacer(segment);
    })
    .join('');
}

export function highlightLua(code) {
  const wrapSelfKeyword = (html) => replaceHtmlTextSegments(
    html,
    segment => segment.replace(/\bself\b/g, '<span class="hljs-keyword">self</span>'),
    LUA_HIGHLIGHT_SKIP_CLASSES
  );
  const wrapBuiltinGlobals = (html) => replaceHtmlTextSegments(
    html,
    segment => segment.replace(
      new RegExp(`\\b(${LUA_BLUE_GLOBALS.join('|')})\\b`, 'g'),
      '<span class="lua-builtin-name">$1</span>'
    ),
    LUA_HIGHLIGHT_SKIP_CLASSES
  );

  // Use highlight.js if available for better syntax highlighting
  if (typeof hljs !== 'undefined' && hljs.getLanguage('lua')) {
    try {
      let result = hljs.highlight(code, { language: 'lua' }).value;
      // Post-process hljs output to match Roblox Studio coloring:
      // - Function declarations: keep title span, split Object:Method
      // - Non-declaration hljs-title spans: unwrap (hljs often wraps call sites in blue)
      result = result.replace(
        /(<span class="hljs-title[^"]*">)([^<]+)(<\/span>)/g,
        (match, open, content, close, offset, str) => {
          const before = str.substring(Math.max(0, offset - 80), offset);
          const isDeclaration = /hljs-keyword[^>]*>function<\/span>\s*$/.test(before);
          if (!isDeclaration) return content;
          if (content.includes(':')) {
            const [obj, method] = content.split(':');
            return `${obj}:${open}${method}${close}`;
          }
          return match;
        }
      );
      const blueDotReceiverPattern = LUA_BLUE_DOT_RECEIVERS.join('|').replace(/\./g, '\\.');
      // Studio colors builtin receivers like `task` / `Color3` blue, and keeps
      // dotted call targets blue as well: `task.defer()`, `Color3.new()`.
      result = result.replace(
        new RegExp(`(^|[^A-Za-z0-9_])((?:<span class="[^"]+">)?(${blueDotReceiverPattern})(?:</span>)?)\\.(\\s*)((?:<span class="[^"]+">)?([A-Za-z_][A-Za-z0-9_]*)(?:</span>)?)(\\s*\\()`, 'g'),
        (match, prefix, receiverHtml, receiverName, ws, memberHtml, memberName, openParen) => {
          const normalizedReceiver = `<span class="lua-builtin-name">${receiverName}</span>`;
          return `${prefix}${normalizedReceiver}.${ws}<span class="lua-builtin-member-name">${memberName}</span>${openParen}`;
        }
      );
      // Luau / Roblox: property chain segment after . when followed by another access
      // Studio colors `PlayerService.Client.CheckEventPrompt:Fire()` with
      // `Client` and `CheckEventPrompt` as blue property names.
      result = result.replace(
        /\.(\s*)([A-Za-z_][A-Za-z0-9_]*)(?=\s*[.:])/g,
        '.$1<span class="lua-property-name">$2</span>'
      );
      // Luau / Roblox: plain property access after . should also be blue
      // (e.g. `Rebirths.Parent = leaderstats`).
      result = result.replace(
        /\.(\s*)([A-Za-z_][A-Za-z0-9_]*)(?=\s*(?:$|[,)\]}=+\-*/%<>;]))/g,
        '.$1<span class="lua-property-name">$2</span>'
      );
      // Luau / Roblox: method name after . or : before ( — Studio uses yellow/gold (e.g. GetService)
      result = result.replace(
        /\.(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*\()/g,
        '.$1<span class="lua-method-name">$2</span>$3'
      );
      result = result.replace(
        /:(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*\()/g,
        ':$1<span class="lua-method-name">$2</span>$3'
      );
      result = wrapBuiltinGlobals(result);
      result = wrapSelfKeyword(result);
      return result;
    } catch (e) {
      console.warn('[highlightLua] Error highlighting code:', e);
    }
  }

  // Fallback to simple highlighting
  const keywords = ['local', 'function', 'end', 'if', 'then', 'else', 'elseif', 'for', 'while', 'do', 'repeat', 'until', 'return', 'break', 'in', 'and', 'or', 'not', 'true', 'false', 'nil', 'self'];
  let escaped = escapeHtml(code);

  // Highlight strings
  escaped = escaped.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, '<span class="lua-string">$1</span>');

  // Highlight comments
  escaped = escaped.replace(/(--.*$)/gm, '<span class="lua-comment">$1</span>');

  // Highlight keywords
  keywords.forEach(kw => {
    const regex = new RegExp(`\\b(${kw})\\b`, 'g');
    escaped = escaped.replace(regex, '<span class="lua-keyword">$1</span>');
  });

  // Highlight numbers
  escaped = escaped.replace(/\b(\d+\.?\d*)\b/g, '<span class="lua-number">$1</span>');
  escaped = wrapBuiltinGlobals(escaped);

  return escaped;
}

export function inferScriptTypeFromPath(path, fileName) {
  if (!path) return 'file';
  const pathLower = path.toLowerCase();
  const fileNameLower = fileName ? fileName.toLowerCase() : '';

  // Check file extension for explicit script type (Rojo convention)
  // .server.lua or .server.luau -> Script
  // .client.lua or .client.luau -> LocalScript
  const hasServerExt = fileNameLower.endsWith('.server.lua') || fileNameLower.endsWith('.server.luau');
  const hasClientExt = fileNameLower.endsWith('.client.lua') || fileNameLower.endsWith('.client.luau');

  // File extension takes precedence
  if (hasServerExt) {
    return 'Script';
  }
  if (hasClientExt) {
    return 'LocalScript';
  }

  // Check path for Roblox container hints
  // This handles both sourcecontrol mode (game.ServerScriptService.X) and
  // Rojo mode paths (src/server/..., src/client/..., etc.)

  // Server containers
  if (pathLower.includes('serverscriptservice') || pathLower.includes('serverstorage')) {
    // In server containers without explicit .server extension -> ModuleScript
    return 'ModuleScript';
  }

  // LocalScript containers
  if (pathLower.includes('starterplayerscripts') || pathLower.includes('startercharacterscripts') ||
      pathLower.includes('startergui') || pathLower.includes('starterpack')) {
    // In LocalScript containers without explicit .client extension -> ModuleScript
    return 'ModuleScript';
  }

  // Module containers
  if (pathLower.includes('replicatedstorage') || pathLower.includes('replicatedfirst')) {
    return 'ModuleScript';
  }

  // Legacy fallback: check for generic container names
  if (pathLower.includes('starterplayer')) {
    return 'ModuleScript';
  }

  // For sourcecontrol paths (game.X.Y), try to infer from path structure
  if (pathLower.startsWith('game.')) {
    // Already handled above, default to ModuleScript for unknown containers
    return 'ModuleScript';
  }

  return 'file';
}

export function getScriptIcon(scriptType) {
  switch (scriptType) {
    case 'Script':
      return `<img class="script-icon" src="icons/Script@3x.png" width="16" height="16" alt="Script">`;
    case 'LocalScript':
      return `<img class="script-icon" src="icons/LocalScript@3x.png" width="16" height="16" alt="LocalScript">`;
    case 'ModuleScript':
      return `<img class="script-icon" src="icons/ModuleScript@3x.png" width="16" height="16" alt="ModuleScript">`;
    default:
      // Default to Script icon for unknown types
      return `<img class="script-icon" src="icons/Script@3x.png" width="16" height="16" alt="Script">`;
  }
}

export function autoResizeTextarea(textarea) {
  const minHeight = 24;
  const maxHeight = 200;
  const lineHeight = 24;

  textarea.style.height = 'auto';
  const scrollHeight = textarea.scrollHeight;
  const lines = Math.ceil(scrollHeight / lineHeight);
  let newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);

  textarea.style.height = newHeight + 'px';
  textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
}

export function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
