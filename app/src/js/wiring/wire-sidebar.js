// @ts-check
// Sidebar wiring: new chat/project buttons and collapse/expand toggles.

export function wireSidebar(app) {
  // Sidebar
  document.getElementById('btn-new-chat').onclick = () => app.createNewChat();
  document.getElementById('btn-start-chat').onclick = () => app.createNewChat();
  document.getElementById('btn-new-project').onclick = () => app.createNewProject();

  // Sidebar collapse/expand
  document.getElementById('btn-collapse-sidebar').onclick = () => app.toggleSidebar();
  document.getElementById('btn-expand-sidebar').onclick = () => app.toggleSidebar();
}
