/**
 * Process utilities module
 */

const { execSync } = require('child_process');
const { dialog } = require('electron');

/**
 * Check if port is in use and get the PID
 */
function getProcessOnPort(port) {
  if (process.platform === 'win32') {
    try {
      const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const lines = result.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) {
          return parseInt(pid, 10);
        }
      }
    } catch (e) {
      // No process found on port
    }
  } else {
    // Unix: use lsof
    try {
      const result = execSync(`lsof -nP -t -iTCP:${port} -sTCP:LISTEN`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const pid = result.trim().split('\n')[0];
      if (pid && /^\d+$/.test(pid)) {
        return parseInt(pid, 10);
      }
    } catch (e) {
      // No process found
    }
  }
  return null;
}

/**
 * Kill a process by PID
 */
function killProcessByPid(pid) {
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch (e) {
      return false;
    }
  }
}

async function waitForPortRelease(port, previousPid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentPid = getProcessOnPort(port);
    if (!currentPid || currentPid !== previousPid) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Check for existing Ropilot instance and handle it
 */
async function handleExistingInstance(port) {
  const existingPid = getProcessOnPort(port);

  if (!existingPid) {
    return true; // No existing instance, proceed
  }

  console.log('Found existing process on port', port, 'PID:', existingPid);

  // Show dialog asking user what to do
  const result = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Kill and Continue', 'Exit'],
    defaultId: 0,
    cancelId: 1,
    title: 'Ropilot Studio Already Running',
    message: 'Ropilot Studio is already running',
    detail: `Another instance is using port ${port} (PID: ${existingPid}).\n\nWould you like to kill it and start a new instance?`
  });

  if (result.response === 0) {
    // Kill the existing process
    console.log('User chose to kill existing instance');
    killProcessByPid(existingPid);
    if (await waitForPortRelease(port, existingPid, 4000)) return true;

    if (process.platform !== 'win32') {
      try { process.kill(existingPid, 'SIGKILL'); } catch (_) {}
      if (await waitForPortRelease(port, existingPid, 1000)) return true;
    }

    dialog.showErrorBox(
      'Backend Still Running',
      `The process using local port ${port} did not stop. Please restart Ropilot Studio.`
    );
    return false;
  } else {
    // User chose to exit
    console.log('User chose to exit');
    return false;
  }
}

/**
 * Legacy function for backwards compatibility
 */
function killOrphanedProcess(port) {
  const pid = getProcessOnPort(port);
  if (pid) {
    console.log('Killing orphaned process on port', port, 'PID:', pid);
    killProcessByPid(pid);
  }
}

module.exports = {
  getProcessOnPort,
  killProcessByPid,
  handleExistingInstance,
  killOrphanedProcess,
  waitForPortRelease
};
