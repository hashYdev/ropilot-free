// @ts-check
// Sidebar chat hover card — Synara's ThreadHoverCardContent in its
// TooltipPopup (sidebarHoverCardStyles.ts): it opens the moment the pointer
// lands on a chat row (delay 0), sits against the sidebar's right edge with a
// -2px overlap, top-aligned with the row, and scales/fades in from the row
// (.98 → 1, 150ms). Moving to another row swaps the card instantly; leaving
// fades it out; pressing a row dismisses it at once. The card itself is
// hoverable, as Base UI tooltips are. Rows: title + relative time, a
// "Working" status while the chat runs, the project folder, and the chat's
// provider/model/effort. Read-only: it never changes state.
//
// Project rows get Synara's ProjectHoverCardContent on the same surface:
// name, chat count, the linked folder and an "Edit project" row (which opens
// the project's options menu). Synara's project pin toggle is left out —
// Ropilot has no pinned projects.

import { escapeHtml } from '../utils.js';
import { getProviderMarkSvg } from './provider-marks.js';
import { REASONING_LEVEL_LABELS } from '../models/model-catalog.js';
import { FOLDER_CLOSED_ICON, FOLDER_OPEN_ICON } from '../project-ui.js';

const CLOSE_MS = 150;
const COLLISION_PADDING_PX = 5;
const SIDE_OFFSET_PX = -2;

const FOLDER_ICON = FOLDER_CLOSED_ICON;
// Tabler message-circle / settings (MIT) for the project card rows
const CHATS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293l-4.7 1"/></svg>';
const SETTINGS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>';

// Synara's abbreviateHomePath, without a known home dir: C:\Users\<name>\… → ~\…
function abbreviateHomePath(path) {
  const value = String(path || '');
  const win = value.match(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i);
  if (win) return '~' + value.slice(win[0].length);
  const posix = value.match(/^\/(?:Users|home)\/[^/]+/);
  if (posix) return '~' + value.slice(posix[0].length);
  return value;
}
// Tabler bolt-filled (MIT) for fast mode
const FAST_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2l.018 .001l.016 .001l.083 .005l.011 .002h.011l.038 .009l.052 .008l.016 .006l.011 .001l.029 .011l.052 .014l.019 .009l.015 .004l.028 .014l.04 .017l.021 .012l.022 .01l.023 .015l.031 .017l.034 .024l.018 .011l.013 .012l.024 .017l.038 .034l.022 .017l.008 .01l.014 .012l.036 .041l.026 .027l.006 .009c.12 .147 .196 .322 .218 .513l.001 .012l.002 .041l.004 .064v6h5a1 1 0 0 1 .868 1.497l-.06 .091l-8 11c-.568 .783 -1.808 .38 -1.808 -.588v-6h-5a1 1 0 0 1 -.868 -1.497l.06 -.091l8 -11l.01 -.013l.018 -.024l.033 -.038l.018 -.022l.009 -.008l.013 -.014l.04 -.036l.028 -.026l.008 -.006a1 1 0 0 1 .402 -.199l.011 -.001l.027 -.005l.074 -.013l.011 -.001l.041 -.002z"/></svg>';

export class SidebarHoverCard {
  constructor(app) {
    this.app = app;
    this.card = null;
    this.currentRow = null;
    this.closeTimer = 0;
    this.open = false;
    this.following = false;
  }

  bind() {
    const root = document.getElementById('sidebar-scroll') || document.getElementById('chat-list');
    if (!root || this.card) return;

    this.card = document.createElement('div');
    this.card.className = 'chat-hover-card';
    this.card.setAttribute('role', 'tooltip');
    this.card.hidden = true;
    document.body.appendChild(this.card);

    root.addEventListener('mouseover', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const row = /** @type {HTMLElement | null} */ (target.closest?.('.chat-item, .project-header'));
      if (!row) {
        if (this.currentRow) this.hide();
        return;
      }
      if (row === this.currentRow && this.open) return;
      if (this.isSorting()) return;
      if (row.classList.contains('editing') || row.querySelector(':scope .project-name-input')) {
        this.hide({ instant: true });
        return;
      }
      this.show(row);
    });
    root.addEventListener('mouseleave', (event) => {
      if (this.isSorting()) return;
      const to = /** @type {Node | null} */ (event.relatedTarget);
      if (to && this.card?.contains(to)) return;
      this.hide();
    });
    this.card.addEventListener('mouseleave', (event) => {
      const to = /** @type {HTMLElement | null} */ (event.relatedTarget);
      if (to && to.closest?.('.chat-item, .project-header') === this.currentRow) return;
      this.hide();
    });
    // "Edit project" opens the project's options menu, as Synara's opens its editor.
    this.card.addEventListener('click', (event) => {
      const action = /** @type {HTMLElement} */ (event.target).closest?.('[data-card-action="edit-project"]');
      if (!action) return;
      const projectId = /** @type {HTMLElement} */ (action).dataset.projectId || '';
      const anchor = document.querySelector(`.project-folder[data-project-id="${CSS.escape(projectId)}"] .project-menu-btn`);
      this.hide({ instant: true });
      const ui = this.app.projectManager?.ui;
      if (ui && anchor) {
        event.stopPropagation();
        setTimeout(() => ui.showMenu(projectId, anchor, projectId === 'default'), 0);
      }
    });
    // Pressing a chat row dismisses its tooltip at once. The project card is a
    // PreviewCard in Synara: it stays through a press and, while the folder is
    // dragged, rides along with the row (its positioner eases top/left, 150ms).
    root.addEventListener('pointerdown', (event) => {
      const header = /** @type {HTMLElement} */ (event.target).closest?.('.project-header');
      if (header && header === this.currentRow && this.open) {
        this.follow();
        return;
      }
      this.hide({ instant: true });
    });
    root.addEventListener('scroll', () => this.hide({ instant: true }), { passive: true });
    window.addEventListener('blur', () => this.hide({ instant: true }));
  }

  follow() {
    const card = this.card;
    if (!card || this.following) return;
    this.following = true;
    card.classList.add('is-following');
    const tick = () => {
      const sortable = this.app.projectManager?.ui?.sortable;
      const row = this.currentRow;
      if (!this.open || !row || !row.isConnected || !(sortable?.isPressed || sortable?.isSettling)) {
        this.following = false;
        card.classList.remove('is-following');
        if (this.open && row && row.isConnected) this.place(row, true);
        return;
      }
      this.place(row, true);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  isSorting() {
    return Boolean(this.app.projectManager?.ui?.sortable?.isPressed) || document.body.classList.contains('is-sortable-dragging');
  }

  /** @param {{ instant?: boolean }} [options] */
  hide({ instant = false } = {}) {
    const card = this.card;
    this.currentRow = null;
    if (!card || card.hidden) {
      this.open = false;
      return;
    }
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = 0;
    this.open = false;
    if (instant) {
      card.classList.add('is-instant');
      card.classList.remove('is-open');
      card.hidden = true;
      return;
    }
    card.classList.remove('is-instant');
    card.classList.remove('is-open');
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = 0;
      if (!this.open) card.hidden = true;
    }, CLOSE_MS);
  }

  /** @param {HTMLElement} row */
  show(row) {
    const card = this.card;
    if (!card || !row.isConnected || row.classList.contains('editing')) return;
    // A card already on screen (open or still fading out) swaps instantly,
    // as Base UI marks the follow-up tooltip data-instant.
    const instant = !card.hidden;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = 0;
    this.currentRow = row;
    this.open = true;

    if (row.classList.contains('project-header')) {
      card.innerHTML = this.renderProjectCard(row);
      this.place(row, instant);
      return;
    }

    const chatId = row.dataset.chatId;
    const projectId = row.dataset.projectId;
    const chat = chatId ? this.app.findChatById?.(chatId) : null;
    const project = (this.app.store?.get('projects') || []).find((p) => p.id === projectId);
    const title = row.querySelector('.chat-item-title')?.textContent?.trim() || chat?.title || '';

    const updated = chat?.updatedAt || chat?.createdAt || 0;
    const age = this.app.chatManager?.formatRelativeTime?.(updated) || '';

    const footer = this.app.composerFooter;
    const model = typeof chat?.model === 'string' ? chat.model : '';
    const modelLabel = model && footer?.getComposerModelDisplayLabel ? footer.getComposerModelDisplayLabel(model) : '';
    const provider = typeof chat?.provider === 'string' ? chat.provider : '';
    const providerIcon = getProviderMarkSvg(provider);
    const effort = REASONING_LEVEL_LABELS[String(chat?.reasoningLevel || '').toLowerCase()] || '';
    const isWorking = Boolean(chatId && this.app.store?.isChatProcessing?.(chatId));

    card.innerHTML = `
      <div class="chat-hover-card-body">
        <div class="chat-hover-card-row chat-hover-card-head">
          <span class="chat-hover-card-title">${escapeHtml(title)}</span>
          ${age ? `<span class="chat-hover-card-age">${escapeHtml(age)}</span>` : ''}
        </div>
        ${isWorking ? '<span class="chat-hover-card-row chat-hover-card-meta"><span class="chat-hover-card-icon"><span class="chat-hover-card-spinner"></span></span><span class="chat-hover-card-text">Working</span></span>' : ''}
        ${project ? `<span class="chat-hover-card-row chat-hover-card-meta"><span class="chat-hover-card-icon chat-hover-card-icon--muted">${FOLDER_ICON}</span><span class="chat-hover-card-text">${escapeHtml(project.name || '')}</span></span>` : ''}
        ${modelLabel ? `<span class="chat-hover-card-row chat-hover-card-meta">${providerIcon ? `<span class="chat-hover-card-icon">${providerIcon}</span>` : ''}<span class="chat-hover-card-text">${escapeHtml(modelLabel)}</span>${chat?.fastMode === true ? `<span class="chat-hover-card-icon chat-hover-card-icon--muted">${FAST_ICON}</span>` : ''}${effort ? `<span class="chat-hover-card-muted">${escapeHtml(effort)}</span>` : ''}</span>` : ''}
      </div>
    `;

    this.place(row, instant);
  }

  /** @param {HTMLElement} header */
  renderProjectCard(header) {
    const projectId = header.closest('.project-folder')?.dataset.projectId || '';
    const project = (this.app.store?.get('projects') || []).find((p) => p.id === projectId);
    if (!project) return '';
    const count = (project.chats || []).length;
    const path = typeof project.workingDir === 'string' && project.workingDir ? abbreviateHomePath(project.workingDir) : '';
    return `
      <div class="chat-hover-card-body">
        <div class="chat-hover-card-row chat-hover-card-head chat-hover-card-head--project">
          <span class="chat-hover-card-icon chat-hover-card-icon--strong">${FOLDER_OPEN_ICON}</span>
          <span class="chat-hover-card-name">${escapeHtml(project.name || '')}</span>
        </div>
        <span class="chat-hover-card-row chat-hover-card-meta"><span class="chat-hover-card-icon chat-hover-card-icon--strong">${CHATS_ICON}</span><span class="chat-hover-card-text">${count} ${count === 1 ? 'chat' : 'chats'}</span></span>
        ${path ? `<div class="chat-hover-card-sep" aria-hidden="true"></div><span class="chat-hover-card-row chat-hover-card-meta"><span class="chat-hover-card-icon chat-hover-card-icon--strong">${FOLDER_ICON}</span><span class="chat-hover-card-text">${escapeHtml(path)}</span></span>` : ''}
        <div class="chat-hover-card-sep" aria-hidden="true"></div>
        <button type="button" class="chat-hover-card-row chat-hover-card-meta chat-hover-card-action" data-card-action="edit-project" data-project-id="${escapeHtml(projectId)}"><span class="chat-hover-card-icon chat-hover-card-icon--strong">${SETTINGS_ICON}</span><span class="chat-hover-card-text">Edit project</span></button>
      </div>
    `;
  }

  /** @param {HTMLElement} row @param {boolean} instant */
  place(row, instant) {
    const card = this.card;
    if (!card) return;
    // Anchor: the sidebar's right edge at the row's top (align start), -2px side offset.
    const rect = row.getBoundingClientRect();
    // Synara anchors to the sidebar container's edge, inside its hairline border.
    const sidebar = document.getElementById('sidebar');
    const sidebarRight = sidebar
      ? sidebar.getBoundingClientRect().right - (parseFloat(getComputedStyle(sidebar).borderRightWidth) || 0)
      : rect.right;
    card.classList.toggle('is-instant', instant);
    if (!instant) card.classList.remove('is-open');
    card.hidden = false;
    const cardHeight = card.offsetHeight;
    const top = Math.max(COLLISION_PADDING_PX, Math.min(rect.top, window.innerHeight - cardHeight - COLLISION_PADDING_PX));
    const left = Math.round(sidebarRight + SIDE_OFFSET_PX);
    card.style.left = `${left}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.transformOrigin = `${Math.round(sidebarRight - left)}px ${Math.round(rect.top + rect.height / 2 - top)}px`;
    if (!instant) void card.offsetWidth;
    card.classList.add('is-open');
  }
}
