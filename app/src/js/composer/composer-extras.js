// @ts-check
// Composer "+" extras panel — Synara's ComposerExtrasTrigger + ComposerExtrasPanel.
// One flat "Add" list floating above the composer. Its rows are the real
// controls (#btn-add-image, the fast-mode rows, the Ropilot Credits route
// dropdown, #btn-rojo), so their own click handlers keep running; this module
// only owns open/close, the highlighted row and the keyboard.
//
// Like Synara, the editor keeps focus while the panel is open: rows swallow
// mousedown, and the panel claims only its navigation keys in capture phase so
// Enter cannot reach the composer and send the draft.

const EXTRAS_TRIGGER_ATTRIBUTE = 'data-composer-extras-trigger';

export class ComposerExtras {
  constructor(app) {
    this.app = app;
    this.isOpen = false;
    this.activeRow = null;
    this.trigger = null;
    this.panel = null;
    this._onWindowKeyDown = (event) => this.handleWindowKeyDown(event);
    this._onWindowPointerDown = (event) => this.handleWindowPointerDown(event);
  }

  init() {
    this.trigger = document.getElementById('composer-extras-trigger');
    this.panel = document.getElementById('composer-extras-panel');
    if (!this.trigger || !this.panel) return;

    this.trigger.addEventListener('click', (event) => {
      event.preventDefault();
      this.toggle();
    });
    // The "+" never steals the editor's focus either.
    this.trigger.addEventListener('mousedown', (event) => event.preventDefault());

    this.panel.addEventListener('mousedown', (event) => {
      if (event.target.closest('.composer-extras-row')) event.preventDefault();
    });

    this.panel.addEventListener('mousemove', (event) => {
      const row = event.target.closest('.composer-extras-row');
      if (row && row !== this.activeRow && this.isSelectable(row)) this.setActiveRow(row);
    });

    // Picking a row runs its own handler first (bubble), then the panel
    // closes — except the route row, which opens its own menu.
    this.panel.addEventListener('click', (event) => {
      const row = event.target.closest('.composer-extras-row');
      if (!row || !this.isOpen) return;
      if (row.id === 'composer-credit-priority-trigger') return;
      window.setTimeout(() => this.close(), 0);
    }, true);
    this.panel.addEventListener('click', (event) => {
      // Route menu picks also finish the gesture.
      if (event.target.closest('#composer-credit-priority-menu [data-value]')) {
        window.setTimeout(() => this.close(), 0);
      }
    });
  }

  isSelectable(row) {
    return !!row
      && !row.disabled
      && !row.classList.contains('hidden')
      && row.offsetParent !== null;
  }

  getRows() {
    if (!this.panel) return [];
    return Array.from(this.panel.querySelectorAll('.composer-extras-row')).filter((row) => this.isSelectable(row));
  }

  setActiveRow(row) {
    for (const candidate of this.panel?.querySelectorAll('.composer-extras-row.is-highlighted') || []) {
      if (candidate !== row) candidate.classList.remove('is-highlighted');
    }
    this.activeRow = row || null;
    row?.classList.add('is-highlighted');
    row?.scrollIntoView?.({ block: 'nearest' });
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (!this.panel || !this.trigger || this.isOpen) return;
    this.app.closeComposerDropdowns?.();
    this.app.slashCommandManager?.hide?.();
    this.isOpen = true;
    this.panel.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.trigger.classList.add('is-open');
    this.setActiveRow(this.getRows()[0] || null);
    window.addEventListener('keydown', this._onWindowKeyDown, true);
    window.addEventListener('pointerdown', this._onWindowPointerDown, true);
  }

  close() {
    if (!this.panel || !this.trigger || !this.isOpen) return;
    this.isOpen = false;
    this.panel.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.classList.remove('is-open');
    this.setActiveRow(null);
    if (document.getElementById('composer-credit-priority-control')?.classList.contains('is-open')) {
      this.app.closeComposerDropdowns?.();
    }
    window.removeEventListener('keydown', this._onWindowKeyDown, true);
    window.removeEventListener('pointerdown', this._onWindowPointerDown, true);
  }

  handleWindowPointerDown(event) {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.panel?.contains(target)) return;
    if (target instanceof Element && target.closest(`[${EXTRAS_TRIGGER_ATTRIBUTE}]`)) return;
    this.close();
  }

  handleWindowKeyDown(event) {
    if (!this.isOpen || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const priorityOpen = document.getElementById('composer-credit-priority-control')?.classList.contains('is-open');
    // The route menu owns the keys while it is open.
    if (priorityOpen && event.key !== 'Escape') return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (priorityOpen) {
        this.app.closeComposerDropdowns?.();
        return;
      }
      this.close();
      return;
    }

    const rows = this.getRows();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!rows.length) return;
      event.preventDefault();
      event.stopPropagation();
      const index = rows.indexOf(this.activeRow);
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      const next = rows[(index + offset + rows.length) % rows.length];
      this.setActiveRow(next);
      return;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      if (!this.activeRow || !rows.includes(this.activeRow)) return;
      event.preventDefault();
      event.stopPropagation();
      this.activeRow.click();
    }
  }
}

export function initComposerExtras(app) {
  const extras = new ComposerExtras(app);
  extras.init();
  return extras;
}
