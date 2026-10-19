// Rojo Manager - handles Rojo server lifecycle, UI, and logs
import { electronAPI } from './core/platform.js';

export class RojoManager {
  constructor(app) {
    this.app = app;
    this.running = false;
    this.starting = false;
    this.logs = [];
  }

  async toggle() {
    const btn = document.getElementById('btn-rojo');
    if (!btn) return;

    if (this.running) {
      // Stop Rojo
      btn.disabled = true;
      const result = await electronAPI().stopRojo();
      btn.disabled = false;

      if (result.success) {
        this.running = false;
        this.updateButton();
      } else {
        this.showError('Failed to stop Rojo', result.error);
      }
    } else {
      // Check if project directory is set
      if (!this.app.projectDir) {
        this.showSetupModal();
        return;
      }

      // Start Rojo - show starting state
      this.starting = true;
      this.updateButton();

      const result = await electronAPI().startRojo(this.app.projectDir);

      this.starting = false;

      if (result.success) {
        this.running = true;
        this.updateButton();
      } else {
        this.updateButton();
        this.showError(result.error, result.details);
      }
    }
  }

  updateButton() {
    const btn = document.getElementById('btn-rojo');
    const sepAfter = document.getElementById('composer-rojo-after');
    if (!btn) return;

    const show = !!this.app.projectDir;
    btn.classList.toggle('hidden', !show);
    if (sepAfter) sepAfter.classList.toggle('hidden', !show);
    if (!this.app.projectDir) {
      return;
    }

    // Remove all state classes first
    btn.classList.remove('running', 'starting');

    // Update button state based on status
    if (this.starting) {
      btn.classList.add('starting');
      btn.title = 'Starting Rojo Server...';
    } else if (this.running) {
      btn.classList.add('running');
      btn.title = 'Stop Rojo Server (running)';
    } else {
      btn.title = this.app.projectDir ? 'Start Rojo Server' : 'Rojo File Sync';
    }
  }

  showSetupModal() {
    document.getElementById('rojo-setup-modal').classList.remove('hidden');
  }

  closeSetupModal() {
    document.getElementById('rojo-setup-modal').classList.add('hidden');
  }

  showError(message, details) {
    const modal = document.getElementById('rojo-error-modal');
    const msgEl = document.getElementById('rojo-error-message');
    const detailsEl = document.getElementById('rojo-error-details');
    const logContainer = document.getElementById('rojo-error-log-container');

    if (msgEl) msgEl.textContent = message || 'An error occurred';
    if (detailsEl) detailsEl.textContent = details || '';

    // Show/hide log container based on whether there are details
    if (logContainer) {
      if (details && details.trim()) {
        logContainer.classList.remove('hidden');
      } else {
        logContainer.classList.add('hidden');
      }
    }

    modal.classList.remove('hidden');
  }

  closeErrorModal() {
    const modal = document.getElementById('rojo-error-modal');
    modal.classList.add('hidden');
  }

  openDebugModal() {
    const modal = document.getElementById('debug-modal');
    modal.classList.remove('hidden');
  }

  closeDebugModal() {
    const modal = document.getElementById('debug-modal');
    modal.classList.add('hidden');
  }

  async checkStatus() {
    try {
      const status = await electronAPI().getRojoStatus();
      this.running = status.running;
      this.updateButton();
    } catch (err) {
      console.error('Failed to check Rojo status:', err);
    }
  }

  // Context menu
  showContextMenu(x, y) {
    const menu = document.getElementById('rojo-context-menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');
  }

  hideContextMenu() {
    document.getElementById('rojo-context-menu').classList.add('hidden');
  }

  // Logs
  addLog(type, message) {
    const timestamp = new Date().toLocaleTimeString();
    this.logs.push({ type, message, timestamp });
    // Keep only last 1000 lines
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-1000);
    }
    // Update modal if open
    this.updateLogsDisplay();
  }

  updateLogsDisplay() {
    const content = document.getElementById('rojo-logs-content');
    if (!content) return;

    if (this.logs.length === 0) {
      content.innerHTML = 'No logs yet. Start the Rojo server to see output.';
      return;
    }

    content.innerHTML = this.logs.map(log => {
      const typeClass = log.type === 'stderr' ? 'log-stderr' : 'log-stdout';
      const escapedMsg = log.message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<span class="log-timestamp">[${log.timestamp}]</span><span class="${typeClass}">${escapedMsg}</span>`;
    }).join('');

    // Auto-scroll to bottom
    content.scrollTop = content.scrollHeight;
  }

  showLogsModal() {
    this.updateLogsDisplay();
    document.getElementById('rojo-logs-modal').classList.remove('hidden');
  }

  closeLogsModal() {
    document.getElementById('rojo-logs-modal').classList.add('hidden');
  }

  clearLogs() {
    this.logs = [];
    this.updateLogsDisplay();
  }
}
