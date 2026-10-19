// @ts-check
// Electron IPC subscriptions: Rojo server stopped/log events from the main process.
import { electronAPI } from '../core/platform.js';

export function wireIpc(app) {
  const api = electronAPI();
  // Listen for rojo stopped event from main process
  api.onRojoStopped((data) => {
    console.log('[ROJO] Server stopped:', data);
    app.rojoManager.running = false;
    app.rojoManager.updateButton();
    // If there was an error during runtime, show it
    if (data.error && data.code !== 0) {
      app.rojoManager.showError('Rojo server stopped unexpectedly', data.error);
    }
  });

  // Listen for rojo log events
  api.onRojoLog((data) => {
    app.rojoManager.addLog(data.type, data.message);
  });
}
