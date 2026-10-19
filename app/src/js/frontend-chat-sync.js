// Renderer-owned chat sync boundary. Cloud sync and commit sync
// stay orchestrated in the renderer, while privileged file access
// remains behind an injected adapter.
export class FrontendChatSync {
  constructor({ cloudSync, commitSync }) {
    this.cloudSync = cloudSync;
    this.commitSync = commitSync;
  }

  loadPendingState() {
    this.cloudSync.loadPendingChanges();
    this.commitSync.loadPendingCommits();
  }

  async flushPendingWork(options = {}) {
    await this.cloudSync.flushPendingChanges();
    await this.commitSync.flushAllPendingCommits(options);
  }

  handleApiKeyChange() {
    this.commitSync.handleApiKeyChange();
  }

  scheduleChatCommit(options) {
    return this.commitSync.scheduleChatCommit(options);
  }

  flushPendingChanges() {
    return this.cloudSync.flushPendingChanges();
  }

  flushAllPendingCommits(options = {}) {
    return this.commitSync.flushAllPendingCommits(options);
  }

  canSync() {
    return this.cloudSync.canSync();
  }

  fetchChats() {
    return this.cloudSync.fetchChats();
  }

  fetchChat(chatId) {
    return this.cloudSync.fetchChat(chatId);
  }

  saveProjects(projects) {
    return this.cloudSync.saveProjects(projects);
  }

  createChat(projectId, chat) {
    return this.cloudSync.createChat(projectId, chat);
  }

  updateChat(chatId, updates) {
    return this.cloudSync.updateChat(chatId, updates);
  }

  addTimelineItem(chatId, item) {
    return this.cloudSync.addTimelineItem(chatId, item);
  }

  deleteChat(chatId) {
    return this.cloudSync.deleteChat(chatId);
  }

  saveProject(project) {
    return this.cloudSync.saveProject(project);
  }

  deleteProject(projectId) {
    return this.cloudSync.deleteProject(projectId);
  }
}
