// Playtest Panel - manages playtest UI during Roblox tests
import { escapeHtml, scrollChatMessagesToEnd } from './utils.js';
import { formatMessage } from './message-formatter.js';
import { store } from './state-store.js';

export class PlaytestPanel {
  constructor(app) {
    this.app = app;
    this.pendingScriptScreenshots = new Map();
  }

  isRenderableScreenshotPath(path) {
    if (typeof path !== 'string') return false;
    let trimmed = path.trim();
    try {
      trimmed = decodeURIComponent(trimmed);
    } catch (_) {
      // Keep original text if it is not valid URI-encoded data.
    }
    if (!trimmed) return false;
    if (/^(data:|file:|https?:)/i.test(trimmed)) return true;
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
    if (/^(\/|\\\\)/.test(trimmed)) return true;
    return false;
  }

  normalizeScreenshots(screenshots) {
    if (!Array.isArray(screenshots)) return [];
    return screenshots
      .map((item, index) => {
        if (!item || typeof item.path !== 'string') return null;
        let path = item.path.trim();
        try {
          path = decodeURIComponent(path);
        } catch (_) {
          // Keep original text if it is not valid URI-encoded data.
        }
        if (!this.isRenderableScreenshotPath(path)) return null;
        const filename = typeof item.filename === 'string' && item.filename.trim() !== ''
          ? item.filename.trim()
          : `Screenshot ${index + 1}`;
        return { path, filename };
      })
      .filter(Boolean);
  }

  mergeScreenshots(existing, incoming) {
    const merged = [];
    const seen = new Set();
    for (const item of [...this.normalizeScreenshots(existing), ...this.normalizeScreenshots(incoming)]) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      merged.push(item);
    }
    return merged;
  }

  queuePendingScreenshots(scriptId, screenshots) {
    if (typeof scriptId !== 'string' || scriptId.trim() === '') return;
    const resolvedScriptId = scriptId.trim();
    const merged = this.mergeScreenshots(
      this.pendingScriptScreenshots.get(resolvedScriptId) || [],
      screenshots
    );
    if (merged.length > 0) {
      this.pendingScriptScreenshots.set(resolvedScriptId, merged);
    }
  }

  consumePendingScreenshots(scriptId) {
    if (typeof scriptId !== 'string' || scriptId.trim() === '') return [];
    const resolvedScriptId = scriptId.trim();
    const screenshots = this.pendingScriptScreenshots.get(resolvedScriptId) || [];
    this.pendingScriptScreenshots.delete(resolvedScriptId);
    return screenshots;
  }

  resolvePlaytestTarget(preferredChatId = null) {
    const activePanelId = store.get('activePlaytestPanelId');
    const activeChatId = store.get('activePlaytestChatId');

    if (activePanelId && activeChatId && (!preferredChatId || preferredChatId === activeChatId)) {
      return { panelId: activePanelId, chatId: activeChatId };
    }

    const candidateChatIds = [];
    if (typeof preferredChatId === 'string' && preferredChatId.trim() !== '') {
      candidateChatIds.push(preferredChatId.trim());
    }
    const currentChatId = store.get('activeChatId');
    if (currentChatId && !candidateChatIds.includes(currentChatId)) {
      candidateChatIds.push(currentChatId);
    }

    for (const chatId of candidateChatIds) {
      const chat = store.getChatById(chatId);
      const playtest = [...(chat?.timeline || [])].reverse().find(item => item.type === 'playtest');
      if (playtest?.id) {
        return { panelId: playtest.id, chatId };
      }
    }

    return { panelId: activePanelId || null, chatId: preferredChatId || activeChatId || null };
  }

  toPreviewSrc(rawPath) {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') return '';
    return this.app.normalizeLocalPreviewSrc(rawPath);
  }

  renderScriptScreenshots(screenshots) {
    const items = this.normalizeScreenshots(screenshots);
    if (items.length === 0) return '';

    return `
      <div class="playtest-script-screenshots">
        ${items.map((item) => {
          const previewSrc = this.toPreviewSrc(item.path);
          return `
            <button
              type="button"
              class="playtest-screenshot-card"
              data-preview-src="${escapeHtml(previewSrc)}"
              data-preview-alt="${escapeHtml(item.filename)}"
            >
              <span class="playtest-screenshot-banner">${escapeHtml(item.filename)}</span>
              <img
                class="playtest-screenshot-image"
                src="${escapeHtml(previewSrc)}"
                alt="${escapeHtml(item.filename)}"
                loading="lazy"
              >
            </button>
          `;
        }).join('')}
      </div>
    `;
  }

  getResultMessages(data) {
    if (!data) return [];
    if (Array.isArray(data.resultMessages) && data.resultMessages.length > 0) {
      return data.resultMessages.filter(msg => typeof msg === 'string' && msg.trim() !== '');
    }
    if (typeof data.finalMessage === 'string' && data.finalMessage.trim() !== '') {
      return [data.finalMessage];
    }
    return [];
  }

  renderResultMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    return messages
      .filter(message => typeof message === 'string' && message.trim() !== '')
      .map(message => `<div class="playtest-result-entry">${formatMessage(message)}</div>`)
      .join('');
  }

  appendResultMessage(data, message) {
    const trimmed = typeof message === 'string' ? message.trim() : '';
    if (!data || !trimmed) return false;

    const resultMessages = this.getResultMessages(data);
    if (resultMessages[resultMessages.length - 1] === trimmed) {
      data.resultMessages = resultMessages;
      data.finalMessage = trimmed;
      return false;
    }

    resultMessages.push(trimmed);
    data.resultMessages = resultMessages;
    data.finalMessage = trimmed;
    return true;
  }

  resolveResultTarget(preferredChatId = null) {
    let panelId = store.get('activePlaytestPanelId');
    let chatId = store.get('activePlaytestChatId');

    if (panelId && chatId) {
      return { panelId, chatId };
    }

    const candidateChatIds = [];
    if (typeof preferredChatId === 'string' && preferredChatId.trim() !== '') {
      candidateChatIds.push(preferredChatId.trim());
    }
    const activeChatId = store.get('activeChatId');
    if (activeChatId && !candidateChatIds.includes(activeChatId)) {
      candidateChatIds.push(activeChatId);
    }

    for (const candidateChatId of candidateChatIds) {
      const chat = store.getChatById(candidateChatId);
      const playtest = [...(chat?.timeline || [])].reverse().find(item => item.type === 'playtest');
      if (playtest?.id) {
        return { panelId: playtest.id, chatId: candidateChatId };
      }
    }

    return { panelId: null, chatId: preferredChatId || null };
  }

  getLatestResultMessage(preferredChatId = null) {
    const { panelId, chatId } = this.resolveResultTarget(preferredChatId);
    if (!panelId || !chatId) return '';

    const targetChat = store.getChatById(chatId);
    const playtestData = targetChat?.timeline?.find(
      item => item.type === 'playtest' && item.id === panelId
    );
    const messages = this.getResultMessages(playtestData);
    return typeof messages[messages.length - 1] === 'string' ? messages[messages.length - 1].trim() : '';
  }

  findActivePlaytestInChat(chat) {
    return [...(chat?.timeline || [])]
      .reverse()
      .find(item => item.type === 'playtest' && item.status !== 'stopped') || null;
  }

  // Show a playtest panel. Reuse the current active panel for the same chat so
  // duplicate/late start events do not create duplicate playtest cards.
  // targetChatId: the chat that initiated the playtest (may differ from active chat if user switched)
  show(targetChatId = null) {
    console.log('[PLAYTEST] showPlaytestPanel() called, targetChatId:', targetChatId);

    // Use target chat from parameter, or fall back to active chat
    const chatId = targetChatId || store.get('activeChatId');
    const targetChat = store.getChatById(chatId);
    if (!targetChat) {
      console.log('[PLAYTEST] showPlaytestPanel: no target chat found for:', chatId);
      return;
    }

    // CRITICAL: Refresh activeChat reference to avoid stale data
    this.app.refreshActiveChat();

    console.log('[PLAYTEST] showPlaytestPanel: proceeding for chat:', chatId);

    // Hide the regular thinking indicator
    this.app.statusManager.hide();

    const activePanelId = store.get('activePlaytestPanelId');
    const activeChatId = store.get('activePlaytestChatId');
    const activePlaytest = activePanelId && activeChatId === chatId
      ? targetChat.timeline?.find(item => item.type === 'playtest' && item.id === activePanelId && item.status !== 'stopped')
      : null;
    const existingPlaytest = activePlaytest || this.findActivePlaytestInChat(targetChat);
    if (existingPlaytest?.id) {
      const isOnTargetChat = store.get('activeChatId') === chatId;
      if (isOnTargetChat && !document.getElementById(existingPlaytest.id)) {
        const container = document.getElementById('messages');
        if (container) {
          container.appendChild(this.createElement(existingPlaytest));
          scrollChatMessagesToEnd();
        }
      }
      this.app.setPlaytestState(true, existingPlaytest.id, chatId);
      console.log('[PLAYTEST] Reusing active panel:', existingPlaytest.id, 'in chat:', chatId);
      return existingPlaytest.id;
    }

    // Generate unique ID for this playtest panel
    const panelId = `playtest-${Date.now()}`;

    // Create playtest data for unified timeline
    const playtestData = {
      type: 'playtest',
      id: panelId,
      status: 'active',
      statusText: 'Starting...',
      scripts: [],
      finalMessage: null,
      collapsed: false
    };

    // Add to target chat's timeline (even if user is on a different chat)
    this.app.addToTimeline(playtestData, targetChat);

    // Only create DOM element if user is currently viewing the target chat
    const isOnTargetChat = store.get('activeChatId') === chatId;
    if (isOnTargetChat) {
      const container = document.getElementById('messages');
      if (container) {
        const panel = this.createElement(playtestData);
        container.appendChild(panel);
        scrollChatMessagesToEnd();
      }
    }

    // Track the active playtest panel AND the chat it's in
    this.app.setPlaytestState(true, panelId, chatId);
    console.log('[PLAYTEST] Panel created:', panelId, 'in chat:', chatId, '(viewing:', isOnTargetChat, ')');
    return panelId;
  }

  // Create a playtest panel DOM element from data
  createElement(data) {
    console.log('[PLAYTEST] createPlaytestPanelElement called with:', {
      id: data.id,
      status: data.status,
      scriptsCount: data.scripts?.length,
      finalMessage: data.finalMessage?.substring(0, 100)
    });
    const panel = document.createElement('div');
    panel.className = 'playtest-panel';
    if (data.status === 'stopped') panel.classList.add('stopped');
    if (data.collapsed) panel.classList.add('collapsed');
    panel.id = data.id;

    panel.innerHTML = `
      <div class="playtest-header" onclick="window.app.playtestPanel.toggleById('${data.id}')">
        <div class="playtest-info">
          <span class="playtest-badge">Playtest</span>
          <div class="playtest-status">
            ${data.status !== 'stopped' ? '<div class="playtest-spinner"></div>' : ''}
            <span class="playtest-status-text">${escapeHtml(data.statusText || 'Starting...')}</span>
          </div>
        </div>
        <div class="playtest-actions">
          <button class="playtest-toggle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="playtest-body">
        <div class="playtest-scripts">
          ${!data.scripts || data.scripts.length === 0 ? '<div class="playtest-empty">Waiting for scripts...</div>' : ''}
        </div>
        <div class="playtest-result" style="display: ${this.getResultMessages(data).length > 0 ? 'block' : 'none'};">
          ${this.renderResultMessages(this.getResultMessages(data))}
        </div>
      </div>
    `;

    // Add script entries
    if (data.scripts && data.scripts.length > 0) {
      const scriptsContainer = panel.querySelector('.playtest-scripts');
      // Remove placeholder
      const placeholder = scriptsContainer.querySelector('.playtest-empty');
      if (placeholder) placeholder.remove();

      data.scripts.forEach(script => {
        const entry = this.createScriptElement(script);
        scriptsContainer.appendChild(entry);
      });
    }

    return panel;
  }

  // Create a playtest script entry DOM element (styled like inline-diff)
  createScriptElement(script) {
    const iconPath = script.runContext === 'server'
      ? 'icons/ServerRunContext@3x.png'
      : 'icons/ClientRunContext@3x.png';
    const contextLabel = script.runContext === 'server' ? 'Server' : 'Client';
    const badgeClass = script.runContext === 'server' ? 'server' : 'client';

    const entry = document.createElement('div');
    entry.className = 'playtest-script-entry';
    if (script.id) {
      entry.dataset.scriptId = script.id;
    }
    entry.innerHTML = `
      <div class="playtest-script-header" onclick="this.parentElement.classList.toggle('expanded')">
        <img class="playtest-context-icon" src="${iconPath}" alt="${contextLabel}">
        <span class="playtest-script-badge ${badgeClass}">${contextLabel}</span>
        <span class="playtest-script-label">Script</span>
        <button class="playtest-script-toggle">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      </div>
      <div class="playtest-script-code">
        <pre><code class="language-lua">${escapeHtml(script.code)}</code></pre>
      </div>
      ${this.renderScriptScreenshots(script.screenshots)}
    `;

    // Apply syntax highlighting if available
    const codeBlock = entry.querySelector('code');
    if (window.hljs && codeBlock) {
      window.hljs.highlightElement(codeBlock);
    }

    entry.querySelectorAll('.playtest-screenshot-card').forEach(card => {
      card.addEventListener('click', (event) => {
        event.stopPropagation();
        const src = card.dataset.previewSrc;
        const alt = card.dataset.previewAlt || 'Screenshot';
        this.app.openImagePreview(src, alt);
      });
    });

    return entry;
  }

  // Hide/finish the current playtest panel (auto-collapse, show final message)
  hide(finalMessage) {
    const activePlaytestPanelId = store.get('activePlaytestPanelId');
    if (!activePlaytestPanelId) return;

    // Update stored data in timeline
    // IMPORTANT: Use the chat where playtest was started, not activeChat (user may have switched)
    const activePlaytestChatId = store.get('activePlaytestChatId');
    const targetChat = store.getChatById(activePlaytestChatId);
    if (targetChat?.timeline) {
      const playtestData = targetChat.timeline.find(
        item => item.type === 'playtest' && item.id === activePlaytestPanelId
      );
      if (playtestData) {
        playtestData.status = 'stopped';
        playtestData.statusText = 'Playtest complete';
        if (finalMessage) {
          this.appendResultMessage(playtestData, finalMessage);
        }
        // Mark chat for full update since we modified existing timeline item
        this.app.projectManager.markChatForFullUpdate(targetChat.id);
        this.app.saveChats();
      }
    }

    const panel = document.getElementById(activePlaytestPanelId);
    if (!panel) return;

    // Update the panel to show it's finished
    panel.classList.add('stopped');
    const statusText = panel.querySelector('.playtest-status-text');
    if (statusText) statusText.textContent = 'Playtest complete';

    // Remove spinner
    const spinner = panel.querySelector('.playtest-spinner');
    if (spinner) spinner.remove();

    // Show final message if provided
    if (finalMessage) {
      const resultContainer = panel.querySelector('.playtest-result');
      if (resultContainer) {
        resultContainer.style.display = 'block';
        const playtestData = targetChat?.timeline?.find(
          item => item.type === 'playtest' && item.id === activePlaytestPanelId
        );
        const messages = this.getResultMessages(playtestData);
        resultContainer.innerHTML = this.renderResultMessages(messages);
      }
    }

    // Clear active flag but keep panel IDs for setResult()
    this.app.setPlaytestState(false, activePlaytestPanelId, activePlaytestChatId);
    // Note: Don't clear activePlaytestPanelId/ChatId here - wait for:
    // 1. setResult() to process and clear, OR
    // 2. 'done' message to clear as backup
    console.log('[PLAYTEST] Panel finished and collapsed');
  }

  // Set the subagent's final result message on the playtest panel
  setResult(message, preferredChatId = null) {
    const resolvedTarget = this.resolveResultTarget(preferredChatId);
    const resultPanelId = resolvedTarget.panelId;
    const resultChatId = resolvedTarget.chatId;

    console.log('[PLAYTEST] setPlaytestResult called');
    console.log('[PLAYTEST]   panelId:', resultPanelId);
    console.log('[PLAYTEST]   chatId:', resultChatId);
    console.log('[PLAYTEST]   message length:', message?.length);

    if (!message) {
      console.log('[PLAYTEST] setPlaytestResult: no message, returning');
      return;
    }

    if (!resultPanelId) {
      console.log('[PLAYTEST] setPlaytestResult: no playtest panel target found, dropping panel-only result.');
      return;
    }

    // Update stored data in timeline
    const targetChat = store.getChatById(resultChatId);
    console.log('[PLAYTEST]   targetChat found:', !!targetChat);
    if (targetChat?.timeline) {
      const playtestData = targetChat.timeline.find(
        item => item.type === 'playtest' && item.id === resultPanelId
      );
      console.log('[PLAYTEST]   playtestData found:', !!playtestData);
      if (playtestData) {
        this.appendResultMessage(playtestData, message);
        // Mark chat for full update since we modified existing timeline item
        this.app.projectManager.markChatForFullUpdate(targetChat.id);
        this.app.saveChats();
        console.log('[PLAYTEST] Updated timeline with final message');
      }
    }

    // Update the panel UI
    const panel = document.getElementById(resultPanelId);
    console.log('[PLAYTEST]   panel element found:', !!panel);
    if (panel) {
      const resultContainer = panel.querySelector('.playtest-result');
      if (resultContainer) {
        const playtestData = targetChat?.timeline?.find(
          item => item.type === 'playtest' && item.id === resultPanelId
        );
        resultContainer.style.display = 'block';
        resultContainer.innerHTML = this.renderResultMessages(this.getResultMessages(playtestData));
        // Expand the panel so user can see the result
        panel.classList.remove('collapsed');
        console.log('[PLAYTEST] Updated panel UI with final message, expanded panel');
      }
    } else {
      console.log('[PLAYTEST] Panel not found in DOM! ID:', resultPanelId);
    }

    // Note: panel IDs are cleared by the 'done' handler in message-handler.js
    // Do NOT clear here - setResult may be called multiple times during streaming
  }

  // Toggle a specific playtest panel by ID
  toggleById(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.classList.toggle('collapsed');
  }

  // Toggle the currently active playtest panel (legacy support)
  toggle() {
    const panelId = store.get('activePlaytestPanelId');
    if (panelId) {
      this.toggleById(panelId);
    }
  }

  // Update playtest status text (in the active panel)
  updateStatus(text) {
    const panelId = store.get('activePlaytestPanelId');
    if (!panelId) return;

    const panel = document.getElementById(panelId);
    if (!panel) return;

    const statusText = panel.querySelector('.playtest-status-text');
    if (statusText) {
      statusText.textContent = text;
    }
    console.log('[PLAYTEST] Status updated:', text);
  }

  // Add a script execution to the active playtest panel
  addScript(scriptId, runContext, code, preferredChatId = null) {
    console.log('[PLAYTEST] addPlaytestScript called:', runContext, 'code length:', code?.length);

    let { panelId: scriptPanelId, chatId: scriptChatId } = this.resolvePlaytestTarget(preferredChatId);

    // Ensure panel exists (in case playtest_script arrives before playtest_event start)
    if (!scriptPanelId) {
      console.log('[PLAYTEST] No active panel, creating one first');
      this.show(preferredChatId);
      ({ panelId: scriptPanelId, chatId: scriptChatId } = this.resolvePlaytestTarget(preferredChatId));
    }

    // Store script in timeline playtest data
    // IMPORTANT: Use the chat where playtest was started, not activeChat (user may have switched)
    const scriptData = {
      id: scriptId || `playtest-script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      runContext,
      code,
      screenshots: this.consumePendingScreenshots(scriptId),
      timestamp: Date.now()
    };
    const targetChat = store.getChatById(scriptChatId);
    if (targetChat?.timeline) {
      // Track debug ID
      if (!targetChat._debugId) targetChat._debugId = Math.random().toString(36).substr(2, 6);

      const playtestData = targetChat.timeline.find(
        item => item.type === 'playtest' && item.id === scriptPanelId
      );
      if (playtestData) {
        playtestData.scripts.push(scriptData);
        playtestData.statusText = `Running ${runContext === 'server' ? 'server' : 'client'} script...`;
        console.log('[PLAYTEST] Script added to timeline, total scripts now:', playtestData.scripts.length,
          'in chat:', scriptChatId, '_debugId:', targetChat._debugId);
        // Mark chat for full update since we modified existing timeline item
        this.app.projectManager.markChatForFullUpdate(targetChat.id);
        this.app.saveChats();
      } else {
        console.log('[PLAYTEST] WARNING: Could not find playtest in timeline!', {
          panelId: scriptPanelId,
          chatId: scriptChatId,
          debugId: targetChat._debugId,
          timelineItems: targetChat.timeline.map(i => ({ type: i.type, id: i.id }))
        });
      }
    } else {
      console.log('[PLAYTEST] WARNING: Could not find chat or timeline!', {
        chatId: scriptChatId
      });
    }

    const panel = document.getElementById(scriptPanelId);
    if (!panel) {
      console.log('[PLAYTEST] ERROR: Panel not found after creation');
      return;
    }

    const scriptsContainer = panel.querySelector('.playtest-scripts');
    if (!scriptsContainer) {
      console.log('[PLAYTEST] ERROR: scriptsContainer not found');
      return;
    }

    // Remove placeholder if present
    const placeholder = scriptsContainer.querySelector('.playtest-empty');
    if (placeholder) {
      placeholder.remove();
    }

    // Create and append script entry
    const entry = this.createScriptElement(scriptData);
    scriptsContainer.appendChild(entry);

    // Update status
    const contextLabel = runContext === 'server' ? 'Server' : 'Client';
    this.updateStatus(`Running ${contextLabel.toLowerCase()} script...`);

    // Scroll to show new script
    scrollChatMessagesToEnd();
  }

  addScriptScreenshots(scriptId, screenshots, preferredChatId = null) {
    if (typeof scriptId !== 'string' || scriptId.trim() === '') return;
    const resolvedScriptId = scriptId.trim();
    const nextScreenshots = this.normalizeScreenshots(screenshots);
    if (nextScreenshots.length === 0) return;
    this.queuePendingScreenshots(resolvedScriptId, nextScreenshots);

    const { panelId: scriptPanelId, chatId: scriptChatId } = this.resolvePlaytestTarget(preferredChatId);
    const targetChat = store.getChatById(scriptChatId);
    if (!targetChat?.timeline) return;

    const playtestData = targetChat.timeline.find(
      item => item.type === 'playtest' && item.id === scriptPanelId
    );
    if (!playtestData || !Array.isArray(playtestData.scripts)) return;

    const scriptData = playtestData.scripts.find(script => script.id === resolvedScriptId)
      || playtestData.scripts[playtestData.scripts.length - 1];
    if (!scriptData) return;

    scriptData.screenshots = this.mergeScreenshots(scriptData.screenshots, this.consumePendingScreenshots(resolvedScriptId));
    this.app.projectManager.markChatForFullUpdate(targetChat.id);
    this.app.saveChats();

    const panel = document.getElementById(scriptPanelId);
    if (!panel) return;

    const entries = [...panel.querySelectorAll('.playtest-script-entry')];
    const existingEntry = entries.find(entry => entry.dataset.scriptId === scriptData.id)
      || entries[entries.length - 1];
    if (!existingEntry) return;

    const replacement = this.createScriptElement(scriptData);
    if (existingEntry.classList.contains('expanded')) {
      replacement.classList.add('expanded');
    }
    existingEntry.replaceWith(replacement);
  }
}
