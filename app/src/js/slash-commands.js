export const SLASH_COMMANDS = [
  {
    id: 'compact',
    command: '/compact',
    description: 'Force conversation compaction',
  },
];

export function findSlashCommand(rawInput) {
  if (typeof rawInput !== 'string') return null;
  const trimmed = rawInput.trim().toLowerCase();
  if (!trimmed.startsWith('/')) return null;
  const token = trimmed.split(/\s+/)[0];
  return SLASH_COMMANDS.find(cmd => cmd.command === token) || null;
}

export class SlashCommandManager {
  constructor(app) {
    this.app = app;
    this.suggestions = [];
    this.activeIndex = 0;
  }

  get menuEl() {
    return document.getElementById('slash-command-menu');
  }

  isVisible() {
    const menu = this.menuEl;
    return Boolean(menu && !menu.classList.contains('hidden') && this.suggestions.length > 0);
  }

  hide() {
    const menu = this.menuEl;
    if (!menu) return;
    this.suggestions = [];
    this.activeIndex = 0;
    menu.classList.add('hidden');
    menu.innerHTML = '';
  }

  updateForInput(rawValue) {
    const menu = this.menuEl;
    if (!menu) return;

    const queryToken = this.getQueryToken(rawValue);
    if (!queryToken) {
      this.hide();
      return;
    }

    const query = queryToken.slice(1).toLowerCase();
    const matches = SLASH_COMMANDS.filter((cmd) => {
      if (!query) return true;
      return cmd.command.slice(1).startsWith(query) || cmd.id.startsWith(query);
    });

    if (matches.length === 0) {
      this.hide();
      return;
    }

    this.suggestions = matches;
    this.activeIndex = Math.max(0, Math.min(this.activeIndex, matches.length - 1));
    this.render();
  }

  handleKeyDown(event) {
    if (!this.isVisible()) return false;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex = (this.activeIndex + 1) % this.suggestions.length;
      this.render();
      return true;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex = (this.activeIndex - 1 + this.suggestions.length) % this.suggestions.length;
      this.render();
      return true;
    }

    if (event.key === 'Tab' || event.key === 'Enter') {
      if (event.key === 'Enter') {
        const input = document.getElementById('input-message');
        const token = this.getQueryToken(input?.value || '').toLowerCase();
        const selected = this.suggestions[this.activeIndex] || this.suggestions[0];
        if (selected && token === selected.command) {
          return false;
        }
      }
      event.preventDefault();
      this.applyActiveCommand();
      return true;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.hide();
      return true;
    }

    return false;
  }

  applyActiveCommand() {
    const input = document.getElementById('input-message');
    if (!input || this.suggestions.length === 0) return;

    const selected = this.suggestions[this.activeIndex] || this.suggestions[0];
    input.value = selected.command;
    this.app.autoResizeTextarea(input);
    this.app.updateSendButton();
    this.hide();
    input.focus();
  }

  render() {
    const menu = this.menuEl;
    if (!menu) return;

    menu.innerHTML = this.suggestions.map((cmd, index) => {
      const activeClass = index === this.activeIndex ? ' active' : '';
      return `
        <button class="slash-command-item${activeClass}" type="button" data-command="${cmd.command}" role="option" aria-selected="${index === this.activeIndex}">
          <span class="slash-command-label">${cmd.command}</span>
          <span class="slash-command-desc">${cmd.description}</span>
        </button>
      `;
    }).join('');

    menu.querySelectorAll('.slash-command-item').forEach((btn, index) => {
      btn.addEventListener('click', () => {
        this.activeIndex = index;
        this.applyActiveCommand();
      });
    });

    menu.classList.remove('hidden');
  }

  getQueryToken(rawValue) {
    if (typeof rawValue !== 'string') return '';
    const trimmedStart = rawValue.trimStart();
    if (!trimmedStart.startsWith('/')) return '';
    const token = trimmedStart.split(/\s+/)[0];
    return token || '';
  }
}
