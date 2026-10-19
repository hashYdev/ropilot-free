const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getWsUrl: () => ipcRenderer.invoke('get-ws-url'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  getPlatform: () => process.platform,
  isWindows11: () => ipcRenderer.invoke('is-windows-11'),
  onPlatform: (callback) => ipcRenderer.on('platform', (event, platform) => callback(platform)),
  onPlatformDetails: (callback) => ipcRenderer.on('platform-details', (event, details) => callback(details)),
  onNativeBlurStatus: (callback) => ipcRenderer.on('native-blur-status', (event, success) => callback(success)),
  getTransparencySetting: () => ipcRenderer.invoke('get-transparency-setting'),
  setTransparencySetting: (value) => ipcRenderer.invoke('set-transparency-setting', value),
  onTransparencySetting: (callback) => ipcRenderer.on('transparency-setting', (event, value) => callback(value)),
  checkClaude: () => ipcRenderer.invoke('check-claude'),
  // Claude CLI management
  installClaudeCli: () => ipcRenderer.invoke('install-claude-cli'),
  acceptChecksumMismatch: () => ipcRenderer.invoke('accept-checksum-mismatch'),
  getClaudeCliStatus: () => ipcRenderer.invoke('get-claude-cli-status'),
  openClaudeLoginTerminal: () => ipcRenderer.invoke('open-claude-login-terminal'),
  // Codex CLI management
  installCodexCli: () => ipcRenderer.invoke('install-codex-cli'),
  getCodexCliStatus: () => ipcRenderer.invoke('get-codex-cli-status'),
  openCodexLoginTerminal: () => ipcRenderer.invoke('open-codex-login-terminal'),
  cloneCodexThreadForRewind: (options) => ipcRenderer.invoke('clone-codex-thread-for-rewind', options),
  deleteCodexClonedRollout: (rolloutPath) => ipcRenderer.invoke('delete-codex-cloned-rollout', rolloutPath),
  saveApiKeyAuth: (key) => ipcRenderer.invoke('save-api-key-auth', key),
  onClaudeInstallProgress: (callback) => ipcRenderer.on('claude-install-progress', (event, data) => callback(data)),
  onCodexInstallProgress: (callback) => ipcRenderer.on('codex-install-progress', (event, data) => callback(data)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  installPlugin: () => ipcRenderer.invoke('install-plugin'),
  getPluginStatus: () => ipcRenderer.invoke('get-plugin-status'),
  // Rojo server management
  startRojo: (projectDir) => ipcRenderer.invoke('start-rojo', projectDir),
  stopRojo: () => ipcRenderer.invoke('stop-rojo'),
  getRojoStatus: () => ipcRenderer.invoke('get-rojo-status'),
  onRojoStopped: (callback) => ipcRenderer.on('rojo-stopped', (event, data) => callback(data)),
  onRojoLog: (callback) => ipcRenderer.on('rojo-log', (event, data) => callback(data)),
  // File operations for rollback
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  // Check if path is a directory (for drag-and-drop)
  isDirectory: (filePath) => ipcRenderer.invoke('is-directory', filePath),
  // Get user data path for persistent storage
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  // Window focus event (for auto-focusing chat input)
  onWindowFocus: (callback) => ipcRenderer.on('window-focus', () => callback()),
  logRendererDiagnostic: (payload) => ipcRenderer.invoke('log-renderer-diagnostic', payload),
});
