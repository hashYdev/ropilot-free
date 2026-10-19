// @ts-check
// Top-bar chat tabs (Synara's dock tabs): every chat opened is kept as a tab
// in the title bar. Clicking a tab switches to that chat, × closes the tab
// (the chat itself is untouched), and tabs can be dragged to reorder — a
// pointer sortable matching Synara's SurfaceContentTabs (dnd-kit, 6px
// activation, horizontal axis, closestCenter). The open-tab list is
// remembered across restarts.

import { escapeHtml } from '../utils.js';
import { getProviderMarkSvg } from './provider-marks.js';
import { bindPointerSortable } from './sortable.js';

const STORAGE_KEY = 'ropilot_open_chat_tabs_v1';
const MAX_TABS = 24;

const CHAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 18.5V7a2.5 2.5 0 0 1 2.5-2.5h10A2.5 2.5 0 0 1 19.5 7v6.5A2.5 2.5 0 0 1 17 16H8.2l-2.9 2.9a.5.5 0 0 1-.8-.4Z"/></svg>';
const GRIP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';

export class TitlebarTabs {
  constructor(app) {
    this.app = app;
    this.strip = null;
    this.tabs = this.load();
    this.scheduled = false;
    this.sortable = null;
    this.renderPending = false;
  }

  bind() {
    const strip = document.getElementById('titlebar-tab-strip');
    if (!strip || this.strip) return;
    this.strip = strip;

    strip.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const tab = /** @type {HTMLElement | null} */ (target.closest('.titlebar-tab'));
      if (!tab) return;
      const chatId = tab.dataset.chatId || '';
      if (target.closest('.titlebar-tab-close')) {
        event.stopPropagation();
        this.close(chatId);
        return;
      }
      this.activate(chatId);
    });

    // Middle-click closes, like browser and Synara tabs
    strip.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      const tab = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('.titlebar-tab'));
      if (tab) {
        event.preventDefault();
        this.close(tab.dataset.chatId || '');
      }
    });

    // Ctrl+click is left alone (context click), as in Synara.
    this.sortable = bindPointerSortable(strip, {
      axis: 'x',
      collision: 'closestCenter',
      draggingClass: 'is-dragging',
      items: () => /** @type {HTMLElement[]} */ ([...strip.querySelectorAll('.titlebar-tab')]),
      itemFromEvent: (event) => /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest?.('.titlebar-tab')),
      onDrop: (item, fromIndex, toIndex) => {
        const tabs = [...strip.querySelectorAll('.titlebar-tab')];
        const target = tabs[toIndex];
        if (!target) return;
        strip.insertBefore(item, fromIndex < toIndex ? target.nextElementSibling : target);
        this.move(item.dataset.chatId || '', target.dataset.chatId || '', fromIndex < toIndex);
      },
      onDragEnd: () => {
        if (this.renderPending) this.render();
      },
    });


    this.app.store?.subscribe?.('activeChatId', () => this.schedule());
    this.app.store?.subscribe?.('projects', () => this.schedule());
    // Renames and provider changes re-render the sidebar list; mirror them.
    const list = document.getElementById('sidebar-scroll') || document.getElementById('chat-list');
    if (list) new MutationObserver(() => this.schedule()).observe(list, { childList: true, subtree: true });

    this.render();
  }

  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string').slice(0, MAX_TABS) : [];
    } catch (_) {
      return [];
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.tabs));
    } catch (_) { /* storage full or unavailable: tabs just won't persist */ }
  }

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.render();
    });
  }

  findChat(chatId) {
    if (!chatId) return null;
    const projects = this.app.store?.get?.('projects') || [];
    for (const project of projects) {
      const chat = (project.chats || []).find((c) => c.id === chatId);
      if (chat) return { chat, projectId: project.id };
    }
    return null;
  }

  activeChatId() {
    return this.app.store?.get?.('activeChatId') || null;
  }

  render() {
    if (!this.strip) return;
    // Re-rendering mid-drag would drop the tab out from under the pointer.
    if (this.sortable?.isDragging) {
      this.renderPending = true;
      return;
    }
    // Let a cancelled drag finish easing home before the strip is rebuilt.
    if (this.sortable?.isSettling) {
      setTimeout(() => this.schedule(), 250);
      return;
    }
    this.renderPending = false;
    const activeId = this.activeChatId();

    // Drop tabs whose chats were deleted; the active chat always has a tab.
    const before = this.tabs.join('|');
    this.tabs = this.tabs.filter((id) => this.findChat(id));
    if (activeId && this.findChat(activeId) && !this.tabs.includes(activeId)) {
      this.tabs.push(activeId);
      while (this.tabs.length > MAX_TABS) {
        const dropIndex = this.tabs.findIndex((id) => id !== activeId);
        this.tabs.splice(dropIndex, 1);
      }
    }
    if (this.tabs.join('|') !== before) this.save();

    const single = this.tabs.length <= 1;
    this.strip.innerHTML = this.tabs.map((id) => {
      const found = this.findChat(id);
      const chat = found?.chat;
      const title = (chat?.title || 'New Chat').trim();
      const isActive = id === activeId;
      const mark = getProviderMarkSvg(chat?.provider) || CHAT_ICON;
      return `
        <div class="titlebar-tab${isActive ? ' is-active' : ''}" role="tab" aria-selected="${isActive}" data-chat-id="${escapeHtml(id)}" title="${escapeHtml(title)}">
          <span class="titlebar-tab-icon" aria-hidden="true"><span class="titlebar-tab-mark">${mark}</span><span class="titlebar-tab-grip">${GRIP_ICON}</span></span>
          <span class="titlebar-tab-title">${escapeHtml(title)}</span>
          ${single ? '' : `<button class="titlebar-tab-close" type="button" title="Close tab" aria-label="Close ${escapeHtml(title)}">${CLOSE_ICON}</button>`}
        </div>`;
    }).join('');

    this.strip.querySelector('.titlebar-tab.is-active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  activate(chatId) {
    const found = this.findChat(chatId);
    if (!found || chatId === this.activeChatId()) return;
    void this.app.chatManager?.setActive?.(chatId, found.projectId);
  }

  close(chatId) {
    const index = this.tabs.indexOf(chatId);
    if (index < 0 || this.tabs.length <= 1) return;
    const wasActive = chatId === this.activeChatId();
    this.tabs.splice(index, 1);
    this.save();
    if (wasActive) {
      const next = this.tabs[index] || this.tabs[index - 1];
      if (next) this.activate(next);
    }
    this.render();
  }

  move(dragId, targetId, after) {
    if (!dragId || !targetId || dragId === targetId) return;
    const from = this.tabs.indexOf(dragId);
    if (from < 0) return;
    this.tabs.splice(from, 1);
    let to = this.tabs.indexOf(targetId);
    if (to < 0) return;
    if (after) to += 1;
    this.tabs.splice(to, 0, dragId);
    this.save();
    this.render();
  }
}
