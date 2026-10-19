// @ts-check
// Sidebar layout: collapse/expand state (user preference + narrow-window
// auto-collapse), Alt+Up/Down chat navigation, and the floating-composer
// clearance sync that keeps chat content clear of the overlaid composer.
// Extracted from app.js; holds the app reference and reaches back through
// it for chat/project state. The collapsed/preference flags stay on the app
// object (seeded here from localStorage) so existing readers keep working.

export class Sidebar {
  constructor(app) {
    this.app = app;
    const storedSidebarCollapsed = localStorage.getItem('ropilot_sidebar_collapsed');
    this.app.hasUserSidebarPreference = storedSidebarCollapsed !== null;
    this.app.sidebarCollapsed = this.app.hasUserSidebarPreference
      ? storedSidebarCollapsed === 'true'
      : this.shouldAutoCollapseSidebar();
  }

  setupChatFloatingComposerClearanceSync() {
    const chatMainColumn = document.querySelector('.chat-main-column');
    if (!chatMainColumn) return;

    this.app.chatFloatingClearanceObserver?.disconnect();
    this.app.chatFloatingClearanceObserver = null;

    if (typeof ResizeObserver === 'function') {
      this.app.chatFloatingClearanceObserver = new ResizeObserver(() => {
        this.updateChatFloatingComposerClearance();
      });
      this.app.chatFloatingClearanceObserver.observe(chatMainColumn);
    }

    window.addEventListener('resize', () => this.updateChatFloatingComposerClearance());
    this.updateChatFloatingComposerClearance();
  }

  updateChatFloatingComposerClearance() {
    if (this.app.pendingChatFloatingClearanceFrame !== null) {
      window.cancelAnimationFrame(this.app.pendingChatFloatingClearanceFrame);
    }

    this.app.pendingChatFloatingClearanceFrame = window.requestAnimationFrame(() => {
      this.app.pendingChatFloatingClearanceFrame = null;

      const chatView = document.getElementById('chat-view');
      const chatMainColumn = document.querySelector('.chat-main-column');
      if (!chatView || !chatMainColumn) return;

      const { height } = chatMainColumn.getBoundingClientRect();
      const clearance = Math.max(96, Math.ceil(height));
      chatView.style.setProperty('--chat-floating-composer-clearance', `${clearance}px`);
    });
  }

  // Navigate to previous/next chat (used by Alt+Up/Down shortcuts)
  // direction: -1 for previous, 1 for next
  navigateChat(direction) {
    // Build a flat list of all chats across all projects (in sidebar visual order)
    // Projects are rendered in array order, but chats within each project are sorted by updatedAt
    const allChats = [];
    for (const project of this.app.projects) {
      // Use the same sorting logic as the UI (getSortedChats sorts by updatedAt descending)
      const sortedChats = this.app.getSortedChats(project.chats);
      for (const chat of sortedChats) {
        allChats.push({ chat, projectId: project.id });
      }
    }

    // If no chats, nothing to do
    if (allChats.length === 0) return;

    // Find the current chat's index in the flat list
    let currentIndex = -1;
    if (this.app.activeChat) {
      currentIndex = allChats.findIndex(item => item.chat.id === this.app.activeChat.id);
    }

    // Calculate the new index
    let newIndex;
    if (currentIndex === -1) {
      // No active chat, select first or last depending on direction
      newIndex = direction > 0 ? 0 : allChats.length - 1;
    } else {
      newIndex = currentIndex + direction;
      // Clamp to valid range (don't wrap around)
      if (newIndex < 0) newIndex = 0;
      if (newIndex >= allChats.length) newIndex = allChats.length - 1;
    }

    // If the index didn't change, nothing to do
    if (currentIndex === newIndex) return;

    // Switch to the new chat
    const { chat, projectId } = allChats[newIndex];
    this.app.setActiveChat(chat.id, projectId);

    // Scroll the chat item into view in the sidebar
    const chatItem = document.querySelector(`.chat-item[data-chat-id="${chat.id}"]`);
    if (chatItem) {
      chatItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // Sidebar toggle
  toggleSidebar() {
    this.app.hasUserSidebarPreference = true;
    this.app.sidebarCollapsed = !this.app.sidebarCollapsed;
    localStorage.setItem('ropilot_sidebar_collapsed', this.app.sidebarCollapsed);
    this.applySidebarState();
  }

  shouldAutoCollapseSidebar() {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 700px)').matches;
  }

  bindSidebarAutoCollapse() {
    if (this.app.hasUserSidebarPreference || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(max-width: 700px)');
    const sync = () => {
      if (this.app.hasUserSidebarPreference) return;
      const nextCollapsed = mediaQuery.matches;
      if (this.app.sidebarCollapsed === nextCollapsed) return;
      this.app.sidebarCollapsed = nextCollapsed;
      this.applySidebarState();
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', sync);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(sync);
    }
    sync();
  }

  applySidebarState() {
    const sidebar = document.getElementById('sidebar');
    const expandBtn = document.getElementById('btn-expand-sidebar');

    if (this.app.sidebarCollapsed) {
      sidebar.classList.add('collapsed');
      expandBtn.classList.remove('hidden');
    } else {
      sidebar.classList.remove('collapsed');
      expandBtn.classList.add('hidden');
    }
  }
}
