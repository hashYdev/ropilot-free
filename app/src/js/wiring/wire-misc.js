// @ts-check
// Miscellaneous wiring: setup/auth screens, Rojo button + context menu, global keyboard shortcuts, drag-and-drop.
import { electronAPI } from '../core/platform.js';

export function wireMisc(app) {
  // Anthropic notice screen
  document.getElementById('btn-acknowledge-anthropic').onclick = () => app.setupFlow.acknowledgeAnthropicNotice();

  // Setup screen
  document.getElementById('btn-check-again').onclick = () => app.setupFlow.checkClaudeInstallation(true);
  document.getElementById('link-download-claude').onclick = (e) => {
    e.preventDefault();
    electronAPI().openExternal('https://code.claude.com');
  };

  // Plugin setup screen
  document.getElementById('btn-install-plugin-setup').onclick = () => app.setupFlow.installPlugin();
  document.getElementById('btn-plugin-already-installed').onclick = (e) => {
    e.preventDefault();
    app.setupFlow.confirmPluginAlreadyInstalled();
  };

  // API key setup screen
  document.getElementById('btn-save-setup-api-key').onclick = () => app.setupFlow.saveSetupApiKey();
  document.getElementById('btn-complete-advanced-input-setup')?.addEventListener('click', () => app.setupFlow.completeAdvancedInputSetup());
  document.getElementById('btn-skip-advanced-input-setup')?.addEventListener('click', (e) => {
    e.preventDefault();
    app.setupFlow.skipAdvancedInputSetup();
  });

  // Install screen
  document.getElementById('btn-install-claude')?.addEventListener('click', () => app.setupFlow.installProviderCli());

  // Auth screen - terminal login buttons
  document.getElementById('btn-open-login-terminal')?.addEventListener('click', () => {
    app.setupFlow.openProviderLogin(app.setupFlow.getSelectedProvider());
  });
  document.getElementById('btn-recheck-auth')?.addEventListener('click', () => {
    app.setupFlow.handleAuthAction();
  });
  document.getElementById('btn-back-to-install-from-auth')?.addEventListener('click', (e) => {
    e.preventDefault();
    app.setupFlow.showInstallScreen();
  });
  document.getElementById('btn-reinstall-claude')?.addEventListener('click', (e) => {
    e.preventDefault();
    app.setupFlow.reinstallClaudeCliFromAuthScreen();
  });

  document.getElementById('btn-claim-free-offer')?.addEventListener('click', () => app.setupFlow.claimFreeOfferAndContinue());
  // Standing escape hatch from the free-offer screen: whatever state the
  // claim CTA is in, the user can always reach ChatGPT Codex sign-in.
  document.getElementById('btn-free-offer-codex-signin')?.addEventListener('click', () => app.setupFlow.continueFreeOfferToCodexAuth());

  // Rojo server button
  document.getElementById('btn-rojo').onclick = () => app.rojoManager.toggle();

  // Rojo button right-click context menu
  document.getElementById('btn-rojo').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    app.rojoManager.showContextMenu(e.clientX, e.clientY);
  });

  // Rojo context menu items
  document.getElementById('rojo-menu-logs').onclick = () => {
    app.rojoManager.hideContextMenu();
    app.rojoManager.showLogsModal();
  };

  // Hide context menu when clicking elsewhere
  document.addEventListener('click', (event) => {
    app.rojoManager.hideContextMenu();
    const target = event.target;
    const slashMenu = document.getElementById('slash-command-menu');
    const inputEl = document.getElementById('input-message');
    const clickInsideSlashMenu = slashMenu && target instanceof Node && slashMenu.contains(target);
    const clickInsideInput = inputEl && target instanceof Node && inputEl.contains(target);
    if (!clickInsideSlashMenu && !clickInsideInput) {
      app.slashCommandManager.hide();
    }
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Escape: Close modals
    if (e.key === 'Escape') {
      const newProjectModal = document.getElementById('new-project-modal');
      const folderApiKeyModal = document.getElementById('folder-api-key-modal');
      const folderCustomPromptModal = document.getElementById('folder-custom-prompt-modal');
      const configureDirModal = document.getElementById('configure-dir-modal');
      const appAlertModal = document.getElementById('app-alert-modal');
      const deleteChatModal = document.getElementById('chat-delete-confirm-modal');
      const deleteProjectModal = document.getElementById('project-delete-confirm-modal');
      const imagePreviewModal = document.getElementById('image-preview-modal');
      const astraModal = document.getElementById('astra-announcement-modal');
      const fable51Modal = document.getElementById('fable51-announcement-modal');
      if (imagePreviewModal && !imagePreviewModal.classList.contains('hidden')) {
        app.closeImagePreview();
      } else if (astraModal && !astraModal.classList.contains('hidden')) {
        app.closeAstraAnnouncement();
      } else if (fable51Modal && !fable51Modal.classList.contains('hidden')) {
        app.closeFable51Announcement();
      } else if (appAlertModal && !appAlertModal.classList.contains('hidden')) {
        app.closeAppAlertModal();
      } else if (deleteChatModal && !deleteChatModal.classList.contains('hidden')) {
        app.closeDeleteChatModal();
      } else if (deleteProjectModal && !deleteProjectModal.classList.contains('hidden')) {
        app.closeDeleteProjectModal();
      } else if (!newProjectModal.classList.contains('hidden')) {
        app.closeNewProjectModal();
      } else if (!folderApiKeyModal.classList.contains('hidden')) {
        app.closeFolderApiKeyModal();
      } else if (folderCustomPromptModal && !folderCustomPromptModal.classList.contains('hidden')) {
        app.projectManager.closeCustomPromptModal();
      } else if (configureDirModal && !configureDirModal.classList.contains('hidden')) {
        app.projectManager.closeConfigureDirModal();
      }
    }
    // Alt+Up: Navigate to previous chat
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      app.navigateChat(-1);
    }
    // Alt+Down: Navigate to next chat
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      app.navigateChat(1);
    }
    // Ctrl+T/Ctrl+N / Cmd+T/Cmd+N: New chat in current project
    if ((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'n')) {
      e.preventDefault();
      // If there's an active chat, create new chat in the same project
      // Otherwise, create in the active/default project
      if (app.activeChat) {
        // Find which project contains the active chat
        for (const project of app.projects) {
          if (project.chats.some(c => c.id === app.activeChat.id)) {
            app.chatManager.createInProject(project.id);
            return;
          }
        }
      }
      // Fallback: create in active project
      app.createNewChat();
    }
  });

  // Drag and drop folder handling
  app.dragDrop.setup();
}
