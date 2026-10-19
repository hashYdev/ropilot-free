// @ts-check
// Settings page navigation: switches the visible section from the left nav
// and filters rows from the search box. Purely presentational — every
// control keeps its id, and SettingsManager (settings.js) still opens,
// loads, saves and closes the page exactly as it did the old modal.

const ACTIVE = 'is-active';

export class SettingsNav {
  constructor(app) {
    this.app = app;
    this.root = null;
    this.activeSection = 'general';
  }

  bind() {
    const root = document.getElementById('settings-modal');
    if (!root || this.root) return;
    this.root = root;

    root.querySelectorAll('.settings-nav-item[data-settings-section]').forEach((item) => {
      item.addEventListener('click', () => {
        this.clearSearch();
        this.showSection(/** @type {HTMLElement} */ (item).dataset.settingsSection || 'general');
      });
    });

    const search = /** @type {HTMLInputElement | null} */ (document.getElementById('settings-search-input'));
    search?.addEventListener('input', () => this.applySearch(search.value));
    search?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && search.value) {
        e.stopPropagation();
        this.clearSearch();
        this.showSection(this.activeSection);
      }
    });

    // SettingsManager.open() un-hides the page and focuses the API key input,
    // which lives in General — so every open starts on General with no filter.
    let wasHidden = root.classList.contains('hidden');
    new MutationObserver(() => {
      const hidden = root.classList.contains('hidden');
      if (wasHidden && !hidden) {
        this.clearSearch();
        this.showSection('general');
      }
      wasHidden = hidden;
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
  }

  panels() {
    return /** @type {HTMLElement[]} */ ([...(this.root?.querySelectorAll('.settings-panel[data-settings-panel]') || [])]);
  }

  showSection(section) {
    if (!this.root) return;
    const panels = this.panels();
    const target = panels.find((p) => p.dataset.settingsPanel === section) || panels[0];
    if (!target) return;
    this.activeSection = target.dataset.settingsPanel || 'general';

    this.app.closeComposerDropdowns?.();
    panels.forEach((p) => p.classList.toggle(ACTIVE, p === target));
    this.root.querySelectorAll('.settings-nav-item[data-settings-section]').forEach((item) => {
      const on = /** @type {HTMLElement} */ (item).dataset.settingsSection === this.activeSection;
      item.classList.toggle(ACTIVE, on);
      if (on) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    this.setHeader(target.dataset.title || '', target.dataset.desc || '');
    const scroll = document.getElementById('settings-scroll');
    if (scroll) scroll.scrollTop = 0;
  }

  setHeader(title, desc) {
    const titleEl = document.getElementById('settings-page-title');
    const descEl = document.getElementById('settings-page-desc');
    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.textContent = desc;
  }

  clearSearch() {
    const search = /** @type {HTMLInputElement | null} */ (document.getElementById('settings-search-input'));
    if (search) search.value = '';
    this.applySearch('');
  }

  applySearch(rawQuery) {
    if (!this.root) return;
    const query = String(rawQuery || '').trim().toLowerCase();
    const searching = query.length > 0;
    this.root.classList.toggle('is-searching', searching);

    const rows = /** @type {HTMLElement[]} */ ([...this.root.querySelectorAll('.settings-row')]);
    rows.forEach((row) => {
      const match = !searching || (row.textContent || '').toLowerCase().includes(query);
      row.classList.toggle('is-search-miss', !match);
    });

    let anyMatch = false;
    const onWin32 = document.body.classList.contains('platform-win32');
    this.root.querySelectorAll('.settings-section').forEach((section) => {
      if (!onWin32 && section.classList.contains('platform-win32-only')) {
        section.classList.toggle('is-search-miss', searching);
        return;
      }
      const visibleRows = [...section.querySelectorAll('.settings-row')].filter(
        (row) => !row.classList.contains('is-search-miss') && !row.classList.contains('hidden'),
      );
      section.classList.toggle('is-search-miss', searching && visibleRows.length === 0);
      if (visibleRows.length > 0) anyMatch = true;
    });
    this.panels().forEach((panel) => {
      const hasMatch = !!panel.querySelector('.settings-section:not(.is-search-miss)');
      panel.classList.toggle('is-search-hit', searching && hasMatch);
    });

    document.getElementById('settings-search-empty')?.classList.toggle('hidden', !searching || anyMatch);
    if (searching) {
      this.setHeader('Search', `Results for “${String(rawQuery).trim()}”`);
    } else {
      const active = this.panels().find((p) => p.dataset.settingsPanel === this.activeSection);
      if (active) this.setHeader(active.dataset.title || '', active.dataset.desc || '');
    }
  }
}
