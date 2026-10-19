/**
 * Rojo server management module
 * Handles starting, stopping, and monitoring the Rojo file sync server
 */

const { spawn, execSync } = require('child_process');

// State
let rojoProcess = null;
let rojoProjectDir = null;
let mainWindowRef = null;

/**
 * Set the main window reference for sending IPC events
 * @param {BrowserWindow} window
 */
function setMainWindow(window) {
  mainWindowRef = window;
}

/**
 * Send a message to the renderer process
 * @param {string} channel
 * @param {any} data
 */
function sendToRenderer(channel, data) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, data);
  }
}

/**
 * Start the Rojo server in the given project directory
 * @param {string} projectDir
 * @returns {Promise<{success: boolean, error?: string, details?: string, running?: boolean, projectDir?: string}>}
 */
async function startRojo(projectDir) {
  // If rojo is already running, return current status
  if (rojoProcess) {
    return { success: false, error: 'Rojo is already running', running: true };
  }

  if (!projectDir) {
    return { success: false, error: 'No project directory specified' };
  }

  try {
    const isWin = process.platform === 'win32';
    // Use rojo.exe explicitly on Windows to prevent shell from finding rojo.js
    const rojoCmd = isWin ? 'rojo.exe' : 'rojo';

    // Check if rojo is installed by running rojo --version
    try {
      execSync(`${rojoCmd} --version`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWin
      });
    } catch (e) {
      const rawError = e.stderr?.toString() || e.message || '';
      return {
        success: false,
        error: 'Rojo is not installed or not in PATH',
        details: 'Install Rojo with: cargo install rojo\nOr download from: https://github.com/rojo-rbx/rojo/releases' +
                 (rawError ? '\n\n--- Error Log ---\n' + rawError : '')
      };
    }

    // Start rojo serve in the project directory
    console.log('Starting Rojo server in:', projectDir);

    rojoProcess = spawn(rojoCmd, ['serve'], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWin,
      windowsHide: true
    });

    rojoProjectDir = projectDir;

    let startupError = '';
    let started = false;
    let processEnded = false;

    // Promise that resolves when we can determine success or failure
    const startupResult = await new Promise((resolve) => {
      let timeoutId;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
      };

      // Collect stderr for potential errors
      rojoProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        console.error('[Rojo Error]', msg.trim());
        startupError += msg;
        // Send to renderer for logs display
        sendToRenderer('rojo-log', { type: 'stderr', message: msg });
      });

      rojoProcess.stdout.on('data', (data) => {
        const msg = data.toString();
        console.log('[Rojo]', msg.trim());
        // Send to renderer for logs display
        sendToRenderer('rojo-log', { type: 'stdout', message: msg });
        // Check if rojo started successfully (it prints "Rojo server listening" or similar)
        if (msg.includes('listening') || msg.includes('Serving') || msg.includes('started')) {
          started = true;
          cleanup();
          resolve({ success: true });
        }
      });

      rojoProcess.on('error', (err) => {
        console.error('Rojo process error:', err);
        startupError = err.message;
        processEnded = true;
        rojoProcess = null;
        rojoProjectDir = null;
        cleanup();
        resolve({ success: false, error: err.message });
      });

      rojoProcess.on('close', (code) => {
        console.log('Rojo process exited with code:', code);
        processEnded = true;
        rojoProcess = null;
        rojoProjectDir = null;
        // Notify renderer that rojo stopped
        sendToRenderer('rojo-stopped', { code, error: startupError });
        cleanup();
        // Process closed - this is a failure if we haven't seen "started"
        if (!started) {
          resolve({ success: false, exitCode: code, error: startupError });
        }
      });

      // Timeout after 3 seconds - if still running but no success message, assume it's working
      timeoutId = setTimeout(() => {
        if (!processEnded && rojoProcess) {
          // Process is still alive after 3 seconds, assume success
          resolve({ success: true });
        } else if (!started) {
          // Process ended but we didn't catch it somehow
          resolve({ success: false, error: startupError || 'Process exited unexpectedly' });
        }
      }, 3000);
    });

    if (!startupResult.success) {
      // Build a helpful error message
      let errorMessage = 'Rojo failed to start';
      const rawError = startupError || startupResult.error || '';
      let helpText = '';

      // Add helpful hints based on error content
      if (rawError.toLowerCase().includes('project') || rawError.toLowerCase().includes('default.project.json')) {
        errorMessage = 'No Rojo project file found';
        helpText = 'Make sure your project directory contains a default.project.json file.';
      } else if (rawError.toLowerCase().includes('not found') || rawError.toLowerCase().includes('enoent')) {
        errorMessage = 'Rojo is not installed';
        helpText = 'Install Rojo with: cargo install rojo\nOr download from: https://github.com/rojo-rbx/rojo/releases';
      }

      // Combine help text and raw error
      let details = '';
      if (helpText) {
        details = helpText;
      }
      if (rawError) {
        if (details) {
          details += '\n\n--- Error Log ---\n' + rawError;
        } else {
          details = rawError;
        }
      }
      if (!details) {
        details = 'Unknown error';
      }

      return {
        success: false,
        error: errorMessage,
        details: details
      };
    }

    return { success: true, running: true, projectDir };
  } catch (err) {
    console.error('Failed to start Rojo:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Stop the Rojo server
 * @returns {Promise<{success: boolean, running: boolean, error?: string}>}
 */
async function stopRojo() {
  if (!rojoProcess) {
    return { success: true, running: false };
  }

  try {
    const pid = rojoProcess.pid;
    console.log('Stopping Rojo server, PID:', pid);

    if (process.platform === 'win32' && pid) {
      // On Windows, kill the process tree
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } catch (e) {
        // Ignore errors - process may already be dead
      }
    } else {
      rojoProcess.kill('SIGTERM');
    }

    rojoProcess = null;
    rojoProjectDir = null;
    return { success: true, running: false };
  } catch (err) {
    console.error('Failed to stop Rojo:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Get the current Rojo server status
 * @returns {{running: boolean, projectDir: string|null}}
 */
function getRojoStatus() {
  return {
    running: rojoProcess !== null,
    projectDir: rojoProjectDir
  };
}

/**
 * Kill the Rojo server (cleanup on exit)
 */
function killRojoServer() {
  if (rojoProcess) {
    const pid = rojoProcess.pid;
    console.log('Killing Rojo server PID:', pid);
    if (process.platform === 'win32' && pid) {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } catch (e) {
        // Ignore
      }
    } else {
      rojoProcess.kill('SIGTERM');
    }
    rojoProcess = null;
    rojoProjectDir = null;
  }
}

module.exports = {
  setMainWindow,
  startRojo,
  stopRojo,
  getRojoStatus,
  killRojoServer
};
