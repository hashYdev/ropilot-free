// @ts-check
// Modal wiring: settings (incl. CLI upgrade buttons), Rojo/debug modals, delete confirms, backdrops, project/folder modals, edit-confirm and diff preview.
import { electronAPI } from '../core/platform.js';
import { localApiFetch } from '../local-api-auth.js';

export async function runCodexCliSettingsUpdate(app, elements) {
  const {
    button,
    statusEl,
    statusTextEl,
    spinnerEl,
    defaultButtonHTML,
  } = elements;
  const codexApi = electronAPI();
  const currentVersionLine = 'Installed version: verifying with the updater';

  button.disabled = true;
  button.textContent = 'Updating...';
  if (statusTextEl) statusTextEl.textContent = 'Preparing Codex CLI update...';
  if (statusEl) statusEl.className = 'upgrade-status';
  if (statusEl) statusEl.classList.remove('hidden');
  if (spinnerEl) spinnerEl.classList.remove('hidden');

  try {
    if (!app.setupFlow?.updateCodexCliViaGoOrShell) {
      throw new Error('Codex CLI installer is unavailable');
    }

    if (statusTextEl) {
      statusTextEl.textContent = `${currentVersionLine}\nContacting the local Codex updater...`;
    }

    const result = await app.setupFlow.updateCodexCliViaGoOrShell({
      onStatus(update) {
        const message = typeof update === 'string' ? update : update?.message;
        if (statusTextEl && message) {
          const elapsedSeconds = Math.max(0, Math.floor(Number(update?.elapsedMs || 0) / 1000));
          const elapsed = elapsedSeconds >= 5 ? ` (${elapsedSeconds}s elapsed)` : '';
          statusTextEl.textContent = `${currentVersionLine}\n${message}${elapsed}`;
        }
      },
    });
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to update Codex CLI');
    }

    let after = null;
    if (!result.version) {
      try {
        after = await codexApi?.getCodexCliStatus?.();
      } catch (_) {
        after = null;
      }
    }
    const newVersion = result.version || after?.version;
    const updatedVersionLine = newVersion
      ? `Updated version: ${newVersion}`
      : 'Updated version metadata is unavailable';
    if (statusTextEl) {
      statusTextEl.textContent = `${currentVersionLine}\n${updatedVersionLine}\nCodex CLI updated successfully.`;
    }
    if (statusEl) statusEl.className = 'upgrade-status success';
    return result;
  } catch (e) {
    const message = e?.message || 'Failed to update Codex CLI';
    if (statusTextEl) statusTextEl.textContent = `${currentVersionLine}\n${message}`;
    if (statusEl) statusEl.className = 'upgrade-status error';
    return { success: false, error: message };
  } finally {
    if (spinnerEl) spinnerEl.classList.add('hidden');
    if (statusEl && !statusTextEl?.textContent?.trim()) statusEl.classList.add('hidden');
    button.disabled = false;
    button.innerHTML = defaultButtonHTML;
  }
}

export function wireModals(app) {
  // Settings
  document.getElementById('btn-settings').onclick = () => app.openSettings();
  document.getElementById('btn-close-settings').onclick = () => app.closeSettings();
  document.getElementById('btn-cancel-settings').onclick = () => app.closeSettings();
  document.getElementById('btn-save-settings').onclick = () => app.saveSettings();
  document.getElementById('btn-open-advanced-input-setup')?.addEventListener('click', () => app.settings.openAdvancedInputSetup());
  const installPluginBtn = document.getElementById('btn-install-plugin');
  if (installPluginBtn) installPluginBtn.onclick = () => app.installPlugin();
  const returnLoginBtn = document.getElementById('btn-return-login-screen');
  if (returnLoginBtn) returnLoginBtn.onclick = () => app.returnToLoginScreen();
  const upgradeClaudeBtn = document.getElementById('btn-upgrade-claude');
  if (upgradeClaudeBtn) {
    const defaultUpgradeBtnHTML = upgradeClaudeBtn.innerHTML;
    upgradeClaudeBtn.onclick = async () => {
      const statusEl = document.getElementById('upgrade-claude-status');
      const statusTextEl = document.getElementById('upgrade-claude-status-text');
      const spinnerEl = document.getElementById('upgrade-claude-spinner');
      upgradeClaudeBtn.disabled = true;
      upgradeClaudeBtn.textContent = 'Checking...';
      if (statusTextEl) statusTextEl.textContent = '';
      if (statusEl) statusEl.className = 'upgrade-status';
      if (statusEl) statusEl.classList.remove('hidden');
      if (spinnerEl) spinnerEl.classList.remove('hidden');
      const controller = new AbortController();
      let sawError = false;
      let sawDone = false;
      const maxStatusChars = 8000;

      const appendStatus = (text, className = '') => {
        if (!statusTextEl || !text) return;
        statusTextEl.textContent = statusTextEl.textContent
          ? `${statusTextEl.textContent}\n${text}`
          : text;
        if (statusTextEl.textContent.length > maxStatusChars) {
          statusTextEl.textContent = `${statusTextEl.textContent.slice(-maxStatusChars)}\n...[truncated]`;
        }
        if (statusEl) statusEl.className = className ? `upgrade-status ${className}` : 'upgrade-status';
      };

      const handleSseEvent = (eventType, data) => {
        if (!data) return;
        if (eventType === 'error') {
          sawError = true;
          appendStatus(data, 'error');
          return;
        }
        if (eventType === 'done') {
          sawDone = true;
          if (!statusEl) return;
          statusEl.className = data.trim() === 'success' && !sawError ? 'upgrade-status success' : 'upgrade-status error';
          return;
        }
        appendStatus(data, sawError ? 'error' : '');
      };

      try {
        const resp = await localApiFetch('http://localhost:8765/upgrade-claude', {
          method: 'POST',
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal
        });

        if (!resp.body) {
          const fallbackText = await resp.text();
          appendStatus(fallbackText || `Request failed (${resp.status})`, resp.ok ? '' : 'error');
          if (statusEl && !resp.ok) statusEl.className = 'upgrade-status error';
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

          while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary === -1) break;

            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!rawEvent.trim()) continue;

            let eventType = 'message';
            const dataLines = [];
            for (const line of rawEvent.split('\n')) {
              if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
              }
            }
            handleSseEvent(eventType, dataLines.join('\n'));
          }
        }

        if (buffer.trim()) {
          let eventType = 'message';
          const dataLines = [];
          for (const line of buffer.split('\n')) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
          handleSseEvent(eventType, dataLines.join('\n'));
        }

        if (!sawDone && statusEl && !sawError) {
          statusEl.className = 'upgrade-status success';
        }
      } catch (e) {
        const message = e?.name === 'AbortError'
          ? 'Update canceled.'
          : 'Failed to reach local server';
        if (statusTextEl) statusTextEl.textContent = message;
        if (statusEl) statusEl.className = 'upgrade-status error';
      } finally {
        if (spinnerEl) spinnerEl.classList.add('hidden');
        if (statusEl && !statusTextEl?.textContent?.trim()) statusEl.classList.add('hidden');
        upgradeClaudeBtn.disabled = false;
        upgradeClaudeBtn.innerHTML = defaultUpgradeBtnHTML;
      }
    };
  }
  const upgradeCodexBtn = document.getElementById('btn-upgrade-codex');
  if (upgradeCodexBtn) {
    const defaultUpgradeBtnHTML = upgradeCodexBtn.innerHTML;
    upgradeCodexBtn.onclick = () => runCodexCliSettingsUpdate(app, {
      button: upgradeCodexBtn,
      statusEl: document.getElementById('upgrade-codex-status'),
      statusTextEl: document.getElementById('upgrade-codex-status-text'),
      spinnerEl: document.getElementById('upgrade-codex-spinner'),
      defaultButtonHTML: defaultUpgradeBtnHTML,
    });
  }

  // Rojo setup modal
  document.getElementById('btn-close-rojo-setup').onclick = () => app.rojoManager.closeSetupModal();
  document.getElementById('btn-rojo-setup-later').onclick = () => app.rojoManager.closeSetupModal();
  document.getElementById('btn-rojo-setup-create').onclick = () => {
    app.rojoManager.closeSetupModal();
    app.showNewProjectModal();
  };

  // Rojo error modal
  document.getElementById('btn-close-rojo-error').onclick = () => app.rojoManager.closeErrorModal();
  document.getElementById('btn-ok-rojo-error').onclick = () => app.rojoManager.closeErrorModal();

  // Debug modal (Claude Code detection)
  document.getElementById('setup-debug-btn')?.addEventListener('click', () => app.rojoManager.openDebugModal());
  document.getElementById('btn-close-debug-modal')?.addEventListener('click', () => app.rojoManager.closeDebugModal());
  document.getElementById('btn-ok-debug-modal')?.addEventListener('click', () => app.rojoManager.closeDebugModal());

  // Rojo logs modal
  document.getElementById('btn-close-rojo-logs').onclick = () => app.rojoManager.closeLogsModal();
  document.getElementById('btn-clear-rojo-logs').onclick = () => app.rojoManager.clearLogs();

  // Connection error modal buttons
  document.getElementById('btn-connection-retry')?.addEventListener('click', () => {
    // Show spinner
    const retryText = document.querySelector('#btn-connection-retry .retry-text');
    const retrySpinner = document.querySelector('#btn-connection-retry .retry-spinner');
    if (retryText) retryText.classList.add('hidden');
    if (retrySpinner) retrySpinner.classList.add('visible');
    // Reset attempts and reconnect
    app.wsManager.forceReconnect();
  });
  document.getElementById('btn-connection-open-folder')?.addEventListener('click', async () => {
    const folderApi = electronAPI();
    const userDataPath = await folderApi?.getUserDataPath();
    if (userDataPath) {
      folderApi?.openExternal(`file:///${userDataPath.replace(/\\/g, '/')}/bin`);
    }
  });
  document.getElementById('btn-connection-support')?.addEventListener('click', () => {
    electronAPI()?.openExternal(`${app.config.siteUrl}/support`);
  });

  // Chat delete confirm modal
  document.getElementById('btn-close-delete-chat')?.addEventListener('click', () => app.closeDeleteChatModal());
  document.getElementById('btn-cancel-delete-chat')?.addEventListener('click', () => app.closeDeleteChatModal());
  document.getElementById('btn-confirm-delete-chat')?.addEventListener('click', () => app.confirmDeleteChat());
  document.getElementById('btn-close-delete-project')?.addEventListener('click', () => app.closeDeleteProjectModal());
  document.getElementById('btn-cancel-delete-project')?.addEventListener('click', () => app.closeDeleteProjectModal());
  document.getElementById('btn-confirm-delete-project')?.addEventListener('click', () => app.confirmDeleteProject());
  document.getElementById('input-delete-project-confirmation')?.addEventListener('input', () => app.updateDeleteProjectConfirmState());
  document.getElementById('input-delete-project-confirmation')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !document.getElementById('btn-confirm-delete-project')?.disabled) {
      e.preventDefault();
      app.confirmDeleteProject();
    }
  });

  // App alert modal
  document.getElementById('btn-close-app-alert')?.addEventListener('click', () => app.closeAppAlertModal());
  document.getElementById('btn-ok-app-alert')?.addEventListener('click', () => app.closeAppAlertModal());
  document.getElementById('btn-close-image-preview')?.addEventListener('click', () => app.closeImagePreview());

  // Claim bonus button (sidebar) - opens modal
  document.getElementById('claim-bonus-btn')?.addEventListener('click', () => {
    app.settings.showClaimBonusModal();
  });
  // Modal claim button
  document.getElementById('modal-claim-bonus-btn')?.addEventListener('click', () => {
    app.settings.claimBonus();
  });
  document.getElementById('modal-claim-bonus-close')?.addEventListener('click', () => {
    app.settings.hideClaimBonusModal();
  });

  // GPT-6 Astra announcement modal
  document.getElementById('btn-astra-try')?.addEventListener('click', () => {
    app.selectAstraAndCloseAnnouncement();
  });
  document.getElementById('btn-astra-close')?.addEventListener('click', () => {
    app.closeAstraAnnouncement();
  });

  // Fable 5.1 announcement modal
  document.getElementById('btn-fable51-try')?.addEventListener('click', () => {
    app.selectFable51AndCloseAnnouncement();
  });
  document.getElementById('btn-fable51-close')?.addEventListener('click', () => {
    app.closeFable51Announcement();
  });

  // Modal backdrop click (skip connection-error-modal - it's unskippable)
  document.querySelectorAll('.modal-backdrop:not(.no-close)').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      if (modal.id === 'settings-modal') {
        app.closeSettings();
      } else if (modal.id === 'edit-confirm-modal') {
        app.closeEditConfirmModal();
      } else if (modal.id === 'new-project-modal') {
        app.closeNewProjectModal();
      } else if (modal.id === 'folder-api-key-modal') {
        app.closeFolderApiKeyModal();
      } else if (modal.id === 'configure-dir-modal') {
        app.projectManager.closeConfigureDirModal();
      } else if (modal.id === 'no-actions-modal') {
        app.hideNoActionsModal();
      } else if (modal.id === 'chat-delete-confirm-modal') {
        app.closeDeleteChatModal();
      } else if (modal.id === 'project-delete-confirm-modal') {
        app.closeDeleteProjectModal();
      } else if (modal.id === 'app-alert-modal') {
        app.closeAppAlertModal();
      } else if (modal.id === 'image-preview-modal') {
        app.closeImagePreview();
      } else if (modal.id === 'astra-announcement-modal') {
        app.closeAstraAnnouncement();
      } else if (modal.id === 'fable51-announcement-modal') {
        app.closeFable51Announcement();
      }
    });
  });

  // New Project Modal
  document.getElementById('btn-close-new-project').onclick = () => app.closeNewProjectModal();
  document.getElementById('btn-project-no-dir').onclick = () => app.createProjectWithoutDirectory();
  document.getElementById('btn-project-with-dir').onclick = () => app.createProjectWithDirectory();

  // Configure Directory Modal
  document.getElementById('btn-close-configure-dir').onclick = () => app.projectManager.closeConfigureDirModal();
  document.getElementById('btn-change-dir').onclick = async () => {
    const projectId = app.projectManager._configureDirProjectId;
    if (projectId) await app.projectManager.changeDirectory(projectId);
  };
  document.getElementById('btn-remove-dir').onclick = () => {
    const projectId = app.projectManager._configureDirProjectId;
    if (projectId) app.projectManager.removeDirectory(projectId);
  };
  document.getElementById('configure-dir-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', () => app.projectManager.closeConfigureDirModal());

  // Folder API Key Modal
  document.getElementById('btn-close-folder-api-key').onclick = () => app.closeFolderApiKeyModal();
  document.getElementById('btn-cancel-folder-api-key').onclick = () => app.closeFolderApiKeyModal();
  document.getElementById('btn-save-folder-api-key').onclick = () => app.saveFolderApiKey();
  document.getElementById('input-folder-api-key').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      app.saveFolderApiKey();
    }
  };

  // Folder Custom Prompt Modal
  document.getElementById('btn-save-folder-custom-prompt')?.addEventListener('click', () => app.projectManager.saveCustomPrompt());
  document.getElementById('btn-cancel-folder-custom-prompt')?.addEventListener('click', () => app.projectManager.closeCustomPromptModal());
  document.getElementById('btn-close-folder-custom-prompt')?.addEventListener('click', () => app.projectManager.closeCustomPromptModal());
  document.getElementById('folder-custom-prompt-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', () => app.projectManager.closeCustomPromptModal());

  // API Key validation on input
  app.apiKeyValidationTimeout = null;
  const apiKeyInput = document.getElementById('input-api-key');
  const folderKeyInput = document.getElementById('input-folder-api-key');
  const projectKeyInput = document.getElementById('input-project-api-key');

  if (apiKeyInput) {
    apiKeyInput.addEventListener('input', (e) => {
      app.validateApiKeyInput(e.target, 'api-key-error');
    });
  } else {
    console.error('[API Key Validation] input-api-key element not found!');
  }

  if (folderKeyInput) {
    folderKeyInput.addEventListener('input', (e) => {
      app.validateApiKeyInput(e.target, 'folder-api-key-error');
    });
  } else {
    console.error('[API Key Validation] input-folder-api-key element not found!');
  }

  if (projectKeyInput) {
    projectKeyInput.addEventListener('input', (e) => {
      app.validateApiKeyInput(e.target, 'project-api-key-error');
    });
  } else {
    console.error('[API Key Validation] input-project-api-key element not found!');
  }

  // Edit confirm modal (rewind dialog)
  document.getElementById('btn-close-edit-modal').onclick = () => app.closeEditConfirmModal();
  document.getElementById('btn-cancel-edit').onclick = () => app.closeEditConfirmModal();
  document.getElementById('btn-rewind-only').onclick = () => app.confirmRewind(false);
  document.getElementById('btn-rewind-and-revert').onclick = () => app.confirmRewind(true);

  // Diff preview modal
  document.getElementById('btn-close-diff')?.addEventListener('click', () => app.closeDiffPreview());
  document.querySelector('#diff-modal .modal-backdrop')?.addEventListener('click', () => app.closeDiffPreview());
}
