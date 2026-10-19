/**
 * Claude CLI checking module
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const claudeManager = require('./claude-manager');

let userDataPath = null;

// Common paths where Claude CLI might be installed on macOS
function getCommonClaudePaths() {
  const home = os.homedir();
  const paths = [];

  if (process.platform === 'darwin') {
    // macOS common locations
    paths.push(
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(home, '.npm-global', 'bin', 'claude'),
      path.join(home, '.local', 'bin', 'claude'),
      '/usr/bin/claude'
    );

    // Check for nvm versions
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      try {
        const versions = fs.readdirSync(nvmDir);
        for (const version of versions) {
          paths.push(path.join(nvmDir, version, 'bin', 'claude'));
        }
      } catch (err) {
        // Ignore read errors
      }
    }
  } else if (process.platform === 'win32') {
    // Windows - native installer (new) and npm global
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    paths.push(
      // Native installer location (Claude Code native installer)
      path.join(home, '.local', 'bin', 'claude.exe'),
      // npm global locations
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(appData, 'npm', 'claude')
    );
  } else {
    // Linux
    paths.push(
      '/usr/local/bin/claude',
      path.join(home, '.npm-global', 'bin', 'claude'),
      path.join(home, '.local', 'bin', 'claude'),
      '/usr/bin/claude'
    );
  }

  return paths;
}

/**
 * Find Claude CLI path (checks common locations if not in PATH)
 */
function findClaudePath() {
  // Check Ropilot-managed Claude binary first
  const managedPath = claudeManager.getClaudeBinaryPath();
  if (managedPath && fs.existsSync(managedPath)) {
    console.log('Claude CLI found at managed path:', managedPath);
    return managedPath;
  }

  // First try PATH
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const foundPath = result.trim().split('\n')[0];
    console.log('Claude CLI found in PATH:', foundPath);
    return foundPath;
  } catch (err) {
    console.log('Claude CLI not in PATH, checking common locations...');
  }

  // Check common paths
  const commonPaths = getCommonClaudePaths();
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      console.log('Claude CLI found at:', p);
      return p;
    }
  }

  console.log('Claude CLI not found. Checked paths:', commonPaths.join(', '));
  return null;
}

/**
 * Set the user data path (must be called before using other functions)
 */
function setUserDataPath(p) {
  userDataPath = p;
}

/**
 * Get the path to the Claude CLI verification flag file
 */
function getClaudeVerifiedPath() {
  return path.join(userDataPath, 'claude-verified.json');
}

/**
 * Check if Claude CLI was previously verified
 */
function isClaudeVerified() {
  try {
    const flagPath = getClaudeVerifiedPath();
    if (fs.existsSync(flagPath)) {
      const data = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
      // Consider verified if checked within the last 30 days
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      if (data.verifiedAt && Date.now() - data.verifiedAt < thirtyDays) {
        console.log('Claude CLI previously verified at:', new Date(data.verifiedAt).toISOString());
        return true;
      }
    }
  } catch (err) {
    console.log('Error reading Claude verified flag:', err.message);
  }
  return false;
}

/**
 * Save Claude CLI verification flag
 */
function saveClaudeVerified() {
  try {
    const flagPath = getClaudeVerifiedPath();
    fs.writeFileSync(flagPath, JSON.stringify({ verifiedAt: Date.now() }));
    console.log('Claude CLI verification saved');
  } catch (err) {
    console.log('Error saving Claude verified flag:', err.message);
  }
}

/**
 * Reset Claude CLI verification (for force recheck)
 */
function resetClaudeVerified() {
  try {
    const flagPath = getClaudeVerifiedPath();
    if (fs.existsSync(flagPath)) {
      fs.unlinkSync(flagPath);
      console.log('Claude verification flag reset for forced recheck');
    }
  } catch (err) {
    console.log('Error resetting Claude verification flag:', err.message);
  }
}

/**
 * Check if Node.js is installed
 */
function checkNodeJS() {
  try {
    const result = execSync('node --version', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const version = result.trim();
    console.log('Node.js version:', version);
    return { installed: true, version };
  } catch (err) {
    console.log('Node.js not found');
    return { installed: false, error: 'Node.js not installed' };
  }
}

/**
 * Check if Claude CLI is installed and authenticated
 * If previously verified, just do a quick version check (no auth test)
 */
function checkClaudeCLI() {
  const previouslyVerified = isClaudeVerified();

  // Find Claude CLI path
  const claudePath = findClaudePath();
  if (!claudePath) {
    const commonPaths = getCommonClaudePaths();
    return {
      installed: false,
      error: 'Claude CLI not installed',
      details: {
        platform: process.platform,
        pathsChecked: commonPaths,
        hint: 'Install from: https://code.claude.com'
      }
    };
  }

  // Check version using the found path
  try {
    const versionResult = execSync(`"${claudePath}" --version`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: true
    });
    const version = versionResult.trim();
    console.log('Claude CLI version:', version);

    // If previously verified, skip the slow auth test
    if (previouslyVerified) {
      console.log('Claude CLI previously verified, skipping auth test');
      return { installed: true, version, authenticated: true, claudePath };
    }

    // If using managed binary with stored API key or credentials, skip auth test
    if (claudeManager.getSavedApiKey() || process.env.ANTHROPIC_API_KEY) {
      console.log('Claude CLI has stored API key, skipping auth test');
      saveClaudeVerified();
      return { installed: true, version, authenticated: true, claudePath };
    }

    // First install - test if Claude is authenticated by sending a simple message
    console.log('First install - running Claude CLI auth test...');
    try {
      const testResult = execSync(`echo "Reply with OK" | "${claudePath}" -p "Reply with just OK, nothing else" --max-turns 1`, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
      });
      console.log('Claude CLI test response:', testResult.trim());
      // Save verification flag for future startups
      saveClaudeVerified();
      return { installed: true, version, authenticated: true, claudePath };
    } catch (authErr) {
      console.log('Claude CLI auth test failed:', authErr.message);
      const stderr = authErr.stderr?.toString() || '';
      const stdout = authErr.stdout?.toString() || '';
      const testOutput = (stderr + '\n' + stdout).trim() || authErr.message || '';
      console.log('Claude CLI test stderr:', stderr);
      console.log('Claude CLI test stdout:', stdout);
      // Check if the error is about authentication
      if (stderr.includes('login') || stderr.includes('auth') || stderr.includes('API key')) {
        return { installed: true, version, authenticated: false, error: 'Not logged in - run: claude /login', testOutput, claudePath };
      }
      // Some other error, but CLI exists
      return { installed: true, version, authenticated: false, error: 'Authentication check failed', testOutput, claudePath };
    }
  } catch (err) {
    console.log('Claude CLI version check failed:', err.message);
    return {
      installed: false,
      error: 'Claude CLI found but failed to run',
      details: {
        claudePath,
        errorMessage: err.message
      }
    };
  }
}

/**
 * Combined installation check
 */
function checkFullInstallation() {
  const claudeResult = checkClaudeCLI();

  return {
    claude: claudeResult,
    ready: claudeResult.installed && claudeResult.authenticated
  };
}

module.exports = {
  setUserDataPath,
  getClaudeVerifiedPath,
  isClaudeVerified,
  saveClaudeVerified,
  resetClaudeVerified,
  checkNodeJS,
  checkClaudeCLI,
  checkFullInstallation,
  findClaudePath,
  getCommonClaudePaths
};
