// Project Manager - handles project CRUD and delegates to sync/UI modules
import { clearApiKeyValidation, validateApiKeyAtStartup } from './api-validation.js';
import { ProjectSyncManager } from './project-sync.js';
import { ProjectUI } from './project-ui.js';
import { electronAPI } from './core/platform.js';

export class ProjectManager {
  constructor(app) {
    this.app = app;

    // Initialize sub-modules
    this.syncManager = new ProjectSyncManager(app);
    this.ui = new ProjectUI(app, this);
  }

  // ============================================
  // Sync delegation methods
  // ============================================

  markProjectDirty(projectId, changeType, project = null) {
    this.syncManager.markProjectDirty(projectId, changeType, project);
  }

  markChatDirty(chatId, changeType, projectId = null, chat = null, updates = null) {
    this.syncManager.markChatDirty(chatId, changeType, projectId, chat, updates);
  }

  queueMessage(chatId, message) {
    this.syncManager.queueMessage(chatId, message);
  }

  queueTruncate(chatId, afterIndex) {
    this.syncManager.queueTruncate(chatId, afterIndex);
  }

  queueTitleUpdate(chatId, title) {
    this.syncManager.queueTitleUpdate(chatId, title);
  }

  markChatForFullUpdate(chatId) {
    this.syncManager.markChatForFullUpdate(chatId);
  }

  async loadWithSync() {
    return this.syncManager.loadWithSync();
  }

  ensureChatLoaded(chatOrId, projectId = null) {
    return this.syncManager.ensureChatLoaded(chatOrId, projectId);
  }

  prepareProjectsForSync(projects = this.app.projects) {
    return this.syncManager.prepareProjectsForSync(projects);
  }

  saveToLocal() {
    this.syncManager.saveToLocal();
  }

  save() {
    this.syncManager.save();
  }

  requestFullSync() {
    this.syncManager.requestFullSync();
  }

  startPolling() {
    this.syncManager.startPolling();
  }

  stopPolling() {
    this.syncManager.stopPolling();
  }

  // ============================================
  // UI delegation methods
  // ============================================

  renderList() {
    this.ui.renderList();
  }

  getSortedChats(chats) {
    return this.ui.getSortedChats(chats);
  }

  // ============================================
  // Core CRUD methods
  // ============================================

  getActive() {
    return this.app.projects.find(p => p.id === this.app.activeProjectId) || this.app.projects[0];
  }

  findChatById(chatId) {
    if (!chatId) return null;
    for (const project of this.app.projects) {
      const chat = project.chats.find(c => c.id === chatId);
      if (chat) return chat;
    }
    return null;
  }

  async create() {
    if (this.isManagedCreditsMode()) {
      this.createProject();
      return;
    }
    this.showNewModal();
  }

  isManagedCreditsMode() {
    return this.app.isUseRopilotCreditsEnabled?.() === true
      || this.app.useRopilotCredits === true;
  }

  showNewModal() {
    document.getElementById('input-project-api-key').value = '';
    document.getElementById('new-project-modal').classList.remove('hidden');
  }

  closeNewModal() {
    document.getElementById('new-project-modal').classList.add('hidden');
    clearApiKeyValidation('input-project-api-key', 'project-api-key-error');
  }

  async createWithoutDirectory() {
    const inputEl = document.getElementById('input-project-api-key');

    if (inputEl.classList.contains('input-invalid')) {
      inputEl.focus();
      return;
    }

    const apiKey = inputEl.value.trim();
    this.closeNewModal();

    this.createProject({ apiKey });
  }

  async createWithDirectory() {
    const inputEl = document.getElementById('input-project-api-key');

    if (inputEl.classList.contains('input-invalid')) {
      inputEl.focus();
      return;
    }

    const apiKey = inputEl.value.trim();
    this.closeNewModal();

    const dir = await electronAPI().selectDirectory();
    if (!dir) return;

    // Use folder name as default project name
    const folderName = dir.split(/[/\\]/).pop() || 'New Project';

    this.createProject({ name: folderName, workingDir: dir, apiKey });
  }

  createProject({ name = 'New Project', workingDir = null, apiKey = '' } = {}) {
    const now = Date.now();
    const project = {
      id: 'project-' + now,
      name,
      chats: [],
      expanded: true,
      createdAt: now,
      workingDir
    };

    if (apiKey) {
      project.apiKey = apiKey;
    }

    this.app.projects.push(project);
    this.markProjectDirty(project.id, 'create', project);
    this.save();
    this.app.activeProjectId = project.id;
    this.app.projectDir = workingDir;
    this.app.updateProjectDirDisplay();
    this.renderList();

    setTimeout(() => this.startEditingName(project.id), 50);
    return project;
  }

  delete(projectId) {
    if (projectId === 'default') return;

    const index = this.app.projects.findIndex(p => p.id === projectId);
    if (index === -1) return;

    // Mark all chats in this project as deleted
    const project = this.app.projects[index];
    for (const chat of project.chats || []) {
      this.markChatDirty(chat.id, 'delete');
    }

    this.app.projects.splice(index, 1);
    this.markProjectDirty(projectId, 'delete');
    this.save();

    if (this.app.activeProjectId === projectId) {
      this.app.activeProjectId = 'default';
      this.app.activeChat = null;
      document.getElementById('welcome-screen').classList.remove('hidden');
      document.getElementById('chat-view').classList.add('hidden');

      const defaultProject = this.app.projects.find(p => p.id === 'default');
      this.app.projectDir = defaultProject?.workingDir || null;
      this.app.updateProjectDirDisplay();
    }

    this.renderList();
  }

  rename(projectId, newName) {
    const project = this.app.projects.find(p => p.id === projectId);
    if (!project) return;

    project.name = newName.trim() || 'Unnamed Project';
    this.markProjectDirty(projectId, 'update', project);
    this.save();
    this.renderList();
  }

  // ============================================
  // Configure Directory modal methods
  // ============================================

  showConfigureDirModal(projectId) {
    if (projectId === 'default') return; // Default project has no configurable directory
    this._configureDirProjectId = projectId;
    const project = this.app.projects.find(p => p.id === projectId);
    const pathEl = document.getElementById('configure-dir-path');
    const removeBtn = document.getElementById('btn-remove-dir');

    if (project?.workingDir) {
      pathEl.textContent = project.workingDir;
      pathEl.classList.remove('no-dir');
      removeBtn.disabled = false;
    } else {
      pathEl.textContent = 'No directory set';
      pathEl.classList.add('no-dir');
      removeBtn.disabled = true;
    }

    document.getElementById('configure-dir-modal')?.classList.remove('hidden');
  }

  closeConfigureDirModal() {
    document.getElementById('configure-dir-modal')?.classList.add('hidden');
    this._configureDirProjectId = null;
  }

  async changeDirectory(projectId) {
    if (projectId === 'default') return; // Default project has no configurable directory
    const project = this.app.projects.find(p => p.id === projectId);
    if (!project) return;

    const dir = await electronAPI().selectDirectory();
    if (dir) {
      project.workingDir = dir;
      // workingDir is device-specific and not synced, so no need to mark dirty
      this.save();

      if (this.app.activeProjectId === projectId) {
        this.app.projectDir = dir;
        this.app.updateProjectDirDisplay();
      }

      // Update modal display if still open
      const pathEl = document.getElementById('configure-dir-path');
      const removeBtn = document.getElementById('btn-remove-dir');
      if (pathEl) {
        pathEl.textContent = dir;
        pathEl.classList.remove('no-dir');
      }
      if (removeBtn) removeBtn.disabled = false;
    }
  }

  removeDirectory(projectId) {
    const project = this.app.projects.find(p => p.id === projectId);
    if (!project) return;

    project.workingDir = null;
    // workingDir is device-specific and not synced, so no need to mark dirty
    this.save();

    if (this.app.activeProjectId === projectId) {
      this.app.projectDir = null;
      this.app.updateProjectDirDisplay();
    }

    // Update modal display if still open
    const pathEl = document.getElementById('configure-dir-path');
    const removeBtn = document.getElementById('btn-remove-dir');
    if (pathEl) {
      pathEl.textContent = 'No directory set';
      pathEl.classList.add('no-dir');
    }
    if (removeBtn) removeBtn.disabled = true;
  }

  getEffectiveApiKey() {
    const project = this.getActive();
    return project?.apiKey || this.app.apiKey;
  }

  // ============================================
  // API Key modal methods
  // ============================================

  showFolderApiKeyModal(projectId) {
    this.app.folderApiKeyProjectId = projectId;
    const project = this.app.projects.find(p => p.id === projectId);
    const input = document.getElementById('input-folder-api-key');
    input.value = project?.apiKey || '';
    document.getElementById('folder-api-key-modal').classList.remove('hidden');
    input.focus();
  }

  closeFolderApiKeyModal() {
    document.getElementById('folder-api-key-modal').classList.add('hidden');
    this.app.folderApiKeyProjectId = null;
    clearApiKeyValidation('input-folder-api-key', 'folder-api-key-error');
  }

  saveFolderApiKey() {
    const projectId = this.app.folderApiKeyProjectId;
    const project = this.app.projects.find(p => p.id === projectId);
    if (!project) {
      this.closeFolderApiKeyModal();
      return;
    }
    const previousEffectiveKey = this.getEffectiveApiKey();

    const inputEl = document.getElementById('input-folder-api-key');

    if (inputEl.classList.contains('input-invalid')) {
      inputEl.focus();
      return;
    }

    const newKey = inputEl.value.trim();
    if (newKey) {
      project.apiKey = newKey;
    } else {
      delete project.apiKey;
    }
    this.save();
    this.closeFolderApiKeyModal();

    // Remove any API key reminder since we now have a key
    const reminder = document.querySelector('.api-key-reminder');
    if (reminder) reminder.remove();

    // Trigger validation for the effective key (fire and forget)
    const effectiveKey = this.getEffectiveApiKey();
    if (this.app.settings) {
      this.app.settings.syncActiveApiKeyToServerBridge();
    }
    if (effectiveKey !== previousEffectiveKey && this.app.settings) {
      this.app.settings.loadFromEdge();
    }
    if (effectiveKey) {
      validateApiKeyAtStartup(effectiveKey);
    }
    this.app.chatSync?.handleApiKeyChange();
  }

  clearApiKey(projectId) {
    const project = this.app.projects.find(p => p.id === projectId);
    if (!project) return;
    const previousEffectiveKey = this.getEffectiveApiKey();

    delete project.apiKey;
    // apiKey is device-specific and not synced, so no need to mark dirty
    this.save();
    if (this.app.settings) {
      this.app.settings.syncActiveApiKeyToServerBridge();
      const effectiveKey = this.getEffectiveApiKey();
      if (effectiveKey !== previousEffectiveKey && effectiveKey) {
        this.app.settings.loadFromEdge();
      }
    }
    this.app.chatSync?.handleApiKeyChange();
  }

  // ============================================
  // Custom Prompt modal methods
  // ============================================

  showCustomPromptModal(projectId) {
    this._customPromptProjectId = projectId;
    const project = this.app.projects.find(p => p.id === projectId);
    const textarea = document.getElementById('input-folder-custom-prompt');
    if (textarea) textarea.value = project?.customPrompt || '';
    document.getElementById('folder-custom-prompt-modal')?.classList.remove('hidden');
  }

  saveCustomPrompt() {
    const projectId = this._customPromptProjectId;
    if (!projectId) return;
    const project = this.app.projects.find(p => p.id === projectId);
    if (!project) return;
    const value = document.getElementById('input-folder-custom-prompt')?.value?.trim() || '';
    project.customPrompt = value || null;
    // customPrompt is device-specific like workingDir, not synced
    this.save();
    document.getElementById('folder-custom-prompt-modal')?.classList.add('hidden');
    this._customPromptProjectId = null;
  }

  closeCustomPromptModal() {
    document.getElementById('folder-custom-prompt-modal')?.classList.add('hidden');
    this._customPromptProjectId = null;
  }

  clearCustomPrompt(projectId) {
    const project = this.app.projects.find(p => p.id === projectId);
    if (!project) return;
    project.customPrompt = null;
    this.save();
  }

  // ============================================
  // State management methods
  // ============================================

  toggleExpanded(projectId) {
    const project = this.app.projects.find(p => p.id === projectId);
    if (!project) return;

    project.expanded = !project.expanded;
    // expanded is synced so users have consistent UI across devices
    this.markProjectDirty(projectId, 'update', project);
    this.save();
    this.renderList();
  }

  setActive(projectId) {
    const previousEffectiveKey = this.getEffectiveApiKey();

    this.app.activeProjectId = projectId;

    const project = this.app.projects.find(p => p.id === projectId);
    if (project) {
      if (!project.expanded) {
        project.expanded = true;
        // expanded is synced, mark project dirty
        this.markProjectDirty(projectId, 'update', project);
        this.save();
      }
      this.app.projectDir = project.workingDir || null;
      this.app.updateProjectDirDisplay();
    }

    this.renderList();

    // If effective API key changed, re-validate (fire and forget)
    const newEffectiveKey = this.getEffectiveApiKey();
    if (newEffectiveKey !== previousEffectiveKey && this.app.settings) {
      this.app.settings.syncActiveApiKeyToServerBridge();
      if (newEffectiveKey) {
        this.app.settings.loadFromEdge();
      }
    }
    if (newEffectiveKey && newEffectiveKey !== previousEffectiveKey) {
      validateApiKeyAtStartup(newEffectiveKey);
    }
    if (newEffectiveKey !== previousEffectiveKey) {
      this.app.chatSync?.handleApiKeyChange();
    }
  }

  startEditingName(projectId) {
    this.app.editingProjectId = projectId;
    this.renderList();

    const input = document.querySelector(`.project-name-input[data-project-id="${projectId}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }

  finishEditingName(projectId, newName) {
    this.app.editingProjectId = null;
    this.rename(projectId, newName);
  }
}
