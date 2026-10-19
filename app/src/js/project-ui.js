// Project UI - handles project list rendering and event binding
//
// The sidebar mirrors Synara's project tree (components/Sidebar.tsx):
// - A "Pinned" section above "Projects" lists pinned chats (newest pin first)
//   with their project name on the right; pinned chats leave their project's
//   list, as in Synara (getUnpinnedThreadsForSidebar).
// - Each project shows 5 chats, "Show more" reveals 5 more per click and
//   "Show less" hides them again page by page; paging resets when the folder
//   closes (THREAD_PREVIEW_LIMIT / THREAD_PREVIEW_PAGE_SIZE).
// - Clicking anywhere on a project row toggles it with Synara's disclosure
//   motion (grid rows 0fr→1fr, fade and a 4px drift, 220ms). Rendering is
//   keyed and in place, so toggling a folder only flips its class and the
//   CSS transition runs; a closed folder keeps only its active chat.
// - Folders reorder by dragging their row (js/ui/sortable.js, a port of the
//   dnd-kit sortable Synara uses).
import { escapeHtml } from './utils.js';
import { store } from './state-store.js';
import { bindPointerSortable } from './ui/sortable.js';

const THREAD_PREVIEW_LIMIT = 5;
const THREAD_PREVIEW_PAGE_SIZE = 5;
const PINNED_STORAGE_KEY = 'ropilot_pinned_chats_v1';

// Synara's project glyphs: Hugeicons folder-closed / folder-02 (MIT), copied
// from Synara's lib/hugeicons.tsx (1.5 stroke on a 24 grid).
export const FOLDER_CLOSED_ICON = `<svg class="project-folder-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M2 13C2.06427 12.3499 2.20951 11.9124 2.53777 11.5858C3.12654 11 4.07416 11 5.9694 11H18.0306C19.9258 11 20.8735 11 21.4622 11.5858C21.7905 11.9124 21.9357 12.3499 22 13"/><path stroke-linecap="round" d="M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7"/></svg>`;
export const FOLDER_OPEN_ICON = `<svg class="project-folder-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M2 19V7.54902C2 6.10516 2 5.38322 2.24332 4.81647C2.5467 4.10985 3.10985 3.5467 3.81647 3.24332C4.38322 3 5.09805 3 6.54902 3H7.04311C7.64819 3 8.22075 3.27394 8.60041 3.74509L10.4175 6M10.4175 6H16C17.4001 6 18.1002 6 18.635 6.27248C19.1054 6.51217 19.4878 6.89462 19.7275 7.36502C20 7.8998 20 8.59987 20 10V11M10.4175 6H7"/><path stroke-linejoin="round" d="M3.15802 15.5144L3.45643 14.7717C4.19029 12.9449 4.55723 12.0316 5.3224 11.5158C6.08757 11 7.07557 11 9.05157 11H17.1119C19.8004 11 21.1446 11 21.7422 11.8787C22.3397 12.7575 21.8405 14.0002 20.842 16.4856L20.5436 17.2283C19.8097 19.0551 19.4428 19.9684 18.6776 20.4842C17.9124 21 16.9244 21 14.9484 21H6.88812C4.19961 21 2.85535 21 2.25782 20.1213C1.66029 19.2425 2.15953 17.9998 3.15802 15.5144Z"/></svg>`;

export class ProjectUI {
  constructor(app, projectManager) {
    this.app = app;
    this.projectManager = projectManager;
    // Extra "Show more" pages per project id (Synara's threadListExtraPagesByProjectCwd)
    this.extraPages = new Map();
    this.delegatedRoot = null;
    this.sortable = null;
    this.renderPending = false;
    this.pinnedIds = this.loadPinned();
  }

  // ---------- Pins (Synara's pinnedThreadsStore) ----------

  loadPinned() {
    try {
      const raw = JSON.parse(localStorage.getItem(PINNED_STORAGE_KEY) || '[]');
      return Array.isArray(raw) ? [...new Set(raw.filter((id) => typeof id === 'string' && id))] : [];
    } catch (_) {
      return [];
    }
  }

  savePinned() {
    try {
      localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(this.pinnedIds));
    } catch (_) { /* storage unavailable: pins just won't persist */ }
  }

  isPinned(chatId) {
    return this.pinnedIds.includes(chatId);
  }

  togglePinned(chatId) {
    if (!chatId) return;
    this.pinnedIds = this.isPinned(chatId)
      ? this.pinnedIds.filter((id) => id !== chatId)
      : [chatId, ...this.pinnedIds];
    this.savePinned();
    this.renderList();
  }

  // Drops pins whose chats no longer exist (deleted chats or projects).
  prunePinned(projects) {
    if (this.pinnedIds.length === 0) return;
    let total = 0;
    const ids = new Set();
    for (const project of projects) {
      for (const chat of project.chats || []) {
        ids.add(chat.id);
        total += 1;
      }
    }
    if (total === 0) return; // nothing loaded yet: never wipe pins on an empty store
    const next = this.pinnedIds.filter((id) => ids.has(id));
    if (next.length !== this.pinnedIds.length) {
      this.pinnedIds = next;
      this.savePinned();
    }
  }

  // Sort chats by updatedAt (most recent first), also de-duplicates by ID
  getSortedChats(chats) {
    // De-duplicate by ID (keep first occurrence which is typically newer)
    const seen = new Set();
    const uniqueChats = chats.filter(chat => {
      if (seen.has(chat.id)) {
        console.warn('[UI] Duplicate chat ID found and filtered:', chat.id);
        return false;
      }
      seen.add(chat.id);
      return true;
    });

    return uniqueChats.sort((a, b) => {
      const aTime = a.updatedAt || a.createdAt || 0;
      const bTime = b.updatedAt || b.createdAt || 0;
      return bTime - aTime;
    });
  }

  // ---------- Rendering ----------

  renderList() {
    const list = document.getElementById('chat-list');
    if (!list) return;
    // A re-render mid-drag would pull the dragged folder out from under the pointer.
    if (this.sortable?.isDragging) {
      this.renderPending = true;
      return;
    }
    this.renderPending = false;

    const root = this.getRoot(list);
    const focus = this.captureFocus(root);
    const storeProjects = store.get('projects') || [];
    const projects = [...storeProjects].reverse();
    const activeProjectId = store.get('activeProjectId');

    this.prunePinned(storeProjects);
    for (const project of projects) {
      if (!project.expanded) this.extraPages.delete(project.id);
    }

    this.renderPinned(projects);

    // Keyed, in-place reconcile: folders persist across renders so their
    // disclosure transition can run when `expanded` flips.
    const existing = new Map();
    for (const el of [...list.children]) {
      if (el.classList?.contains('project-folder') && el.dataset.projectId) existing.set(el.dataset.projectId, el);
      else el.remove();
    }
    let previous = null;
    for (const project of projects) {
      let folder = existing.get(project.id);
      existing.delete(project.id);
      const headerHtml = this.renderProjectHeader(project, activeProjectId === project.id);
      const chatsHtml = this.renderProjectChats(project);
      if (!folder) {
        folder = document.createElement('div');
        folder.className = 'project-folder';
        folder.dataset.projectId = project.id;
        folder.innerHTML = `${headerHtml}<div class="project-chats"><div class="project-chats-inner"><div class="project-chats-list">${chatsHtml}</div></div></div>`;
        folder._headerHtml = headerHtml;
        folder._chatsHtml = chatsHtml;
      } else {
        if (folder._headerHtml !== headerHtml) {
          folder.querySelector(':scope > .project-header')?.remove();
          folder.insertAdjacentHTML('afterbegin', headerHtml);
          folder._headerHtml = headerHtml;
        }
        if (folder._chatsHtml !== chatsHtml) {
          const chatList = folder.querySelector('.project-chats-list');
          if (chatList) chatList.innerHTML = chatsHtml;
          folder._chatsHtml = chatsHtml;
        }
      }
      folder.classList.toggle('expanded', Boolean(project.expanded));
      const expectedNext = previous ? previous.nextElementSibling : list.firstElementChild;
      if (expectedNext !== folder) list.insertBefore(folder, expectedNext);
      previous = folder;
    }
    for (const stale of existing.values()) stale.remove();

    this.bindEditingInputs(root);
    this.ensureDelegatedEvents(root, list);
    this.restoreFocus(root, focus);
  }

  getRoot(list) {
    return document.getElementById('sidebar-scroll') || list.parentElement || list;
  }

  // Renders keep row focus (Synara's rows reveal their actions on focus-within).
  captureFocus(root) {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    const row = active.closest?.('.chat-item, .project-header');
    if (!row || row !== active) return null;
    if (row.classList.contains('chat-item')) return { selector: `.chat-item[data-chat-id="${CSS.escape(row.dataset.chatId || '')}"]` };
    const folder = row.closest('.project-folder');
    return folder ? { selector: `.project-folder[data-project-id="${CSS.escape(folder.dataset.projectId || '')}"] > .project-header` } : null;
  }

  restoreFocus(root, focus) {
    if (!focus) return;
    const current = document.activeElement;
    if (current && current !== document.body && current.isConnected) return;
    const el = root.querySelector(focus.selector);
    if (el) el.focus({ preventScroll: true });
  }

  renderPinned(projects) {
    const section = document.getElementById('sidebar-pinned');
    if (!section) return;
    const byId = new Map();
    for (const project of projects) {
      for (const chat of project.chats || []) {
        if (!byId.has(chat.id)) byId.set(chat.id, { chat, project });
      }
    }
    const rows = this.pinnedIds.map((id) => byId.get(id)).filter(Boolean);
    const html = rows.length === 0 ? '' : `
      <div class="sidebar-pinned-header"><span class="sidebar-section-label">Pinned</span></div>
      <div class="sidebar-pinned-list">
        ${rows.map(({ chat, project }) => this.app.chatManager.renderItem(chat, project.id, { pinned: true, projectLabel: project.name || '' })).join('')}
      </div>`;
    if (section._html !== html) {
      section.innerHTML = html;
      section._html = html;
    }
    section.hidden = rows.length === 0;
  }

  renderProjectHeader(project, isActive) {
    const isEditing = this.app.editingProjectId === project.id;
    const isDefault = project.id === 'default';
    const expanded = Boolean(project.expanded);
    return `<div class="project-header${isActive ? ' active' : ''}" role="button" tabindex="0" aria-expanded="${expanded}">
          <span class="project-folder-icon" aria-hidden="true">
            ${FOLDER_CLOSED_ICON}
            ${FOLDER_OPEN_ICON}
          </span>
          <div class="project-name-wrap">
          ${isEditing ? `
            <input type="text" class="project-name-input" data-project-id="${project.id}" value="${escapeHtml(project.name)}" />
          ` : `
            <span class="project-name">${escapeHtml(project.name)}</span>
          `}
          </div>
          <div class="project-actions">
            <button class="project-add-chat-btn" type="button" title="New chat" aria-label="Create new chat in ${escapeHtml(project.name)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M16.862 4.487a2.1 2.1 0 1 1 2.97 2.97L10.5 16.79 7 17.5l.71-3.5 9.152-9.513Z"/>
                <path d="M19 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5.5"/>
              </svg>
            </button>
            <button class="project-menu-btn" type="button" title="Project options" aria-label="Project options" data-is-default="${isDefault}">
              <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                <circle cx="5.5" cy="12" r="1.5"/>
                <circle cx="12" cy="12" r="1.5"/>
                <circle cx="18.5" cy="12" r="1.5"/>
              </svg>
            </button>
          </div>
        </div>`;
  }

  // Synara's deriveSidebarProjectData: pinned chats leave the list; an open
  // folder pages its chats 5 at a time (the active chat is always kept
  // visible); a closed folder renders only its active chat.
  renderProjectChats(project) {
    const activeChatId = store.get('activeChatId');
    const chats = this.getSortedChats([...(project.chats || [])]).filter((chat) => !this.isPinned(chat.id));

    if (!project.expanded) {
      const active = activeChatId ? chats.find((chat) => chat.id === activeChatId) : null;
      return active ? this.app.chatManager.renderItem(active, project.id) : '';
    }

    const total = chats.length;
    const maxExtraPages = Math.ceil(Math.max(0, total - THREAD_PREVIEW_LIMIT) / THREAD_PREVIEW_PAGE_SIZE);
    const extraPages = Math.min(Math.max(0, this.extraPages.get(project.id) || 0), maxExtraPages);
    const previewLimit = THREAD_PREVIEW_LIMIT + extraPages * THREAD_PREVIEW_PAGE_SIZE;
    let visible = chats;
    if (total > previewLimit) {
      visible = chats.slice(0, previewLimit);
      const activeIndex = activeChatId ? chats.findIndex((chat) => chat.id === activeChatId) : -1;
      if (activeIndex >= previewLimit) visible = [...visible, chats[activeIndex]];
    }
    const canShowMore = total > previewLimit && visible.length < total;
    const canShowLess = extraPages > 0;

    let html = visible.map((chat) => this.app.chatManager.renderItem(chat, project.id)).join('');
    if (canShowMore || canShowLess) {
      html += `<div class="chat-paging">${canShowMore ? `<button class="chat-show-more" type="button" data-project-id="${project.id}" data-extra-pages="${extraPages}">Show more</button>` : ''}${canShowLess ? `<button class="chat-show-less${canShowMore ? '' : ' is-alone'}" type="button" data-project-id="${project.id}" data-extra-pages="${extraPages}">Show less</button>` : ''}</div>`;
    }
    return html;
  }

  // Name inputs only exist while a rename is in flight (at most one project
  // and one chat), so direct binding here stays O(1) per render.
  bindEditingInputs(root) {
    const projectInput = root.querySelector('.project-name-input');
    if (projectInput) {
      const projectId = projectInput.dataset.projectId;
      projectInput.onblur = () => this.projectManager.finishEditingName(projectId, projectInput.value);
      projectInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          this.projectManager.finishEditingName(projectId, projectInput.value);
        } else if (e.key === 'Escape') {
          this.app.editingProjectId = null;
          this.renderList();
        }
      };
    }

    const chatInput = root.querySelector('.chat-name-input');
    if (chatInput) {
      const chatId = chatInput.dataset.chatId;
      chatInput.onblur = () => this.app.chatManager.finishEditingName(chatId, chatInput.value);
      chatInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          this.app.chatManager.finishEditingName(chatId, chatInput.value);
        } else if (e.key === 'Escape') {
          this.app.editingChatId = null;
          this.renderList();
        }
      };
    }
  }

  ensureDelegatedEvents(root, list) {
    if (this.delegatedRoot === root) return;
    this.delegatedRoot = root;
    root.addEventListener('click', (e) => this.handleListClick(e));
    root.addEventListener('dblclick', (e) => this.handleListDblClick(e));
    root.addEventListener('keydown', (e) => this.handleListKeyDown(e));
    root.addEventListener('contextmenu', (e) => this.handleListContextMenu(e));
    this.bindFolderDragReorder(list);
  }

  // Folders reorder by dragging their row (Synara's dnd-kit sortable: 6px
  // activation, vertical axis, pointerWithin → closestCorners). The list
  // renders newest-first (projects reversed), so drops are resolved in display
  // order and written back reversed.
  bindFolderDragReorder(list) {
    this.sortable = bindPointerSortable(list, {
      axis: 'y',
      collision: 'pointerWithin',
      draggingClass: 'is-dragging',
      overClass: 'is-drop-over',
      items: () => /** @type {HTMLElement[]} */ ([...list.querySelectorAll(':scope > .project-folder')]),
      itemFromEvent: (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const header = target.closest?.('.project-header');
        if (!header || target.closest('button, input, textarea')) return null;
        if (this.app.editingProjectId) return null;
        return header.closest('.project-folder');
      },
      onDrop: (item, fromIndex, toIndex) => {
        const folders = [...list.querySelectorAll(':scope > .project-folder')];
        const target = folders[toIndex];
        if (!target) return;
        // Move the node first so the snap lands on the final layout.
        list.insertBefore(item, fromIndex < toIndex ? target.nextElementSibling : target);
        this.moveProject(item.dataset.projectId, target.dataset.projectId, fromIndex < toIndex);
      },
      onDragEnd: () => {
        if (this.renderPending) this.renderList();
      },
    });
  }

  moveProject(dragId, targetId, after) {
    if (!dragId || !targetId || dragId === targetId) return;
    const display = [...(store.get('projects') || [])].reverse();
    const from = display.findIndex((p) => p.id === dragId);
    if (from < 0) return;
    const [moved] = display.splice(from, 1);
    let to = display.findIndex((p) => p.id === targetId);
    if (to < 0) return;
    if (after) to += 1;
    display.splice(to, 0, moved);
    this.app.projects = display.reverse();
    this.projectManager.save();
    this.renderList();
  }

  // Synara's project row click: the whole row toggles the folder. Ropilot also
  // makes the clicked project the active one (setActive opens a closed folder,
  // so an open folder is closed after it).
  toggleProjectFromRow(projectId) {
    const project = (store.get('projects') || []).find((p) => p.id === projectId);
    if (!project) return;
    const wasExpanded = Boolean(project.expanded);
    if (store.get('activeProjectId') !== projectId) {
      this.projectManager.setActive(projectId);
      if (wasExpanded) this.projectManager.toggleExpanded(projectId);
    } else {
      this.projectManager.toggleExpanded(projectId);
    }
  }

  handleListClick(e) {
    if (e.target.closest('input')) return;

    const showMore = e.target.closest('.chat-show-more');
    if (showMore) {
      const id = showMore.dataset.projectId;
      this.extraPages.set(id, Number(showMore.dataset.extraPages || 0) + 1);
      this.renderList();
      return;
    }
    const showLess = e.target.closest('.chat-show-less');
    if (showLess) {
      const id = showLess.dataset.projectId;
      const next = Math.max(0, Number(showLess.dataset.extraPages || 0) - 1);
      if (next > 0) this.extraPages.set(id, next);
      else this.extraPages.delete(id);
      this.renderList();
      return;
    }

    const chatItem = e.target.closest('.chat-item');
    if (chatItem) {
      const chatId = chatItem.dataset.chatId;
      const chatProjectId = chatItem.dataset.projectId;
      if (e.target.closest('.chat-item-pin')) {
        e.preventDefault();
        this.togglePinned(chatId);
      } else if (e.target.closest('.chat-item-delete')) {
        const chatTitle = chatItem.querySelector('.chat-item-title')?.textContent?.trim() || '';
        this.app.showDeleteChatModal(chatId, chatProjectId, chatTitle);
      } else if (!chatItem.classList.contains('editing')) {
        void this.app.chatManager.setActive(chatId, chatProjectId);
      }
      return;
    }

    const projectEl = e.target.closest('.project-folder');
    if (!projectEl) return;
    const projectId = projectEl.dataset.projectId;

    if (e.target.closest('.project-add-chat-btn')) {
      this.app.chatManager.createInProject(projectId);
      return;
    }
    const menuBtn = e.target.closest('.project-menu-btn');
    if (menuBtn) {
      this.showMenu(projectId, menuBtn, menuBtn.dataset.isDefault === 'true');
      return;
    }
    if (e.target.closest('.project-header') && !e.target.closest('button')) {
      this.toggleProjectFromRow(projectId);
    }
  }

  // Rows are role="button": Enter / Space activate them, as in Synara.
  handleListKeyDown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target;
    if (!(row instanceof HTMLElement) || !row.matches('.chat-item, .project-header')) return;
    e.preventDefault();
    if (row.classList.contains('chat-item')) {
      if (!row.classList.contains('editing')) void this.app.chatManager.setActive(row.dataset.chatId, row.dataset.projectId);
      return;
    }
    const projectId = row.closest('.project-folder')?.dataset.projectId;
    if (projectId) this.toggleProjectFromRow(projectId);
  }

  // Right-clicking a project row opens its menu at the pointer (Synara's
  // project context menu).
  handleListContextMenu(e) {
    const header = e.target.closest('.project-header');
    if (!header || e.target.closest('input')) return;
    const projectEl = header.closest('.project-folder');
    if (!projectEl) return;
    e.preventDefault();
    const point = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY - 4, bottom: e.clientY - 4 }) };
    this.showMenu(projectEl.dataset.projectId, point, projectEl.dataset.projectId === 'default');
  }

  handleListDblClick(e) {
    if (e.target.closest('input')) return;

    const chatTitle = e.target.closest('.chat-item-title');
    if (chatTitle) {
      const chatItem = chatTitle.closest('.chat-item');
      if (chatItem) this.app.chatManager.startEditingName(chatItem.dataset.chatId);
      return;
    }

    const projectName = e.target.closest('.project-name');
    if (projectName) {
      const projectEl = projectName.closest('.project-folder');
      if (projectEl) this.projectManager.startEditingName(projectEl.dataset.projectId);
    }
  }

  showMenu(projectId, anchorEl, isDefaultProject = false) {
    const existingMenu = document.querySelector('.project-context-menu');
    if (existingMenu) existingMenu.remove();

    const projects = store.get('projects') || [];
    const project = projects.find(p => p.id === projectId);
    const hasDirectory = project?.workingDir;
    const hasCustomApiKey = project?.apiKey;
    const hasCustomPrompt = project?.customPrompt;

    const menu = document.createElement('div');
    menu.className = 'project-context-menu';
    menu.innerHTML = `
      <button class="menu-item" data-action="rename">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        Rename
      </button>
      ${!isDefaultProject ? `
      <div class="menu-item-separator"></div>
      <button class="menu-item${hasDirectory ? ' menu-item-has-value' : ''}" data-action="configure-dir">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
        </svg>
        Configure Directory...
        ${hasDirectory ? '<span class="menu-item-badge">Set</span>' : ''}
      </button>
      ` : ''}
      <div class="menu-item-separator"></div>
      <button class="menu-item${hasCustomApiKey ? ' menu-item-has-value' : ''}" data-action="set-api-key">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
        </svg>
        Set Folder API Key...
        ${hasCustomApiKey ? '<span class="menu-item-badge">Custom</span>' : ''}
      </button>
      ${hasCustomApiKey ? `
        <button class="menu-item" data-action="use-studio-key">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 12h18M3 6h18M3 18h18"/>
          </svg>
          Use Studio Key
        </button>
      ` : ''}
      <div class="menu-item-separator"></div>
      <button class="menu-item${hasCustomPrompt ? ' menu-item-has-value' : ''}" data-action="set-custom-prompt">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        Set System Prompt...
        ${hasCustomPrompt ? '<span class="menu-item-badge">Custom</span>' : ''}
      </button>
      ${hasCustomPrompt ? `
        <button class="menu-item" data-action="clear-custom-prompt">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 12h18M3 6h18M3 18h18"/>
          </svg>
          Clear System Prompt
        </button>
      ` : ''}
      ${!isDefaultProject ? `
        <div class="menu-item-separator"></div>
        <button class="menu-item menu-item-danger" data-action="delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
          Delete
        </button>
      ` : ''}
    `;

    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = rect.left + 'px';

    document.body.appendChild(menu);

    menu.querySelectorAll('.menu-item').forEach(item => {
      item.onclick = async (e) => {
        const action = item.dataset.action;
        menu.remove();

        switch (action) {
          case 'rename':
            this.projectManager.startEditingName(projectId);
            break;
          case 'configure-dir':
            this.projectManager.showConfigureDirModal(projectId);
            break;
          case 'set-api-key':
            this.projectManager.showFolderApiKeyModal(projectId);
            break;
          case 'use-studio-key':
            this.projectManager.clearApiKey(projectId);
            break;
          case 'set-custom-prompt':
            this.projectManager.showCustomPromptModal(projectId);
            break;
          case 'clear-custom-prompt':
            this.projectManager.clearCustomPrompt(projectId);
            break;
          case 'delete':
            this.app.showDeleteProjectModal(projectId, project?.name || '');
            break;
        }
      };
    });

    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }
}
