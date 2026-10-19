/**
 * Claude CLI binary management module
 * Downloads, updates, and manages the Claude CLI binary + login flow
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const MAX_REDIRECTS = 5;
const DOWNLOAD_ACTIVITY_TIMEOUT_MS = 120000;
const DOWNLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1500;
const MANAGED_AUTH_VERIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STATUS_CACHE_SUCCESS_TTL_MS = 60 * 1000;
const STATUS_CACHE_FAILURE_TTL_MS = 5 * 1000;

const INSTALL_SCRIPT_URL = 'https://claude.ai/install.ps1';
const FALLBACK_GCS_BASE = 'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases';
let cachedGcsBase = null;
let statusCache = null;
let statusCacheAt = 0;

/**
 * Check if git-bash is available on Windows (required by Claude CLI)
 */
function isGitBashAvailable() {
  if (process.platform !== 'win32') return true;

  // Check CLAUDE_CODE_GIT_BASH_PATH env var first
  const envPath = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (envPath && fs.existsSync(envPath)) return true;

  // Check if git is in PATH
  try {
    const { execSync } = require('child_process');
    execSync('git --version', { stdio: 'pipe', timeout: 5000, windowsHide: true });
    return true;
  } catch (_) {}

  // Check common install locations
  const commonPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
  ];
  for (const p of commonPaths) {
    if (p && fs.existsSync(p)) return true;
  }

  return false;
}

let userDataPath = null;
let pendingChecksumSkip = null;

/**
 * Initialize the module with userData path
 */
function init(config) {
  userDataPath = config.userDataPath;
}

/**
 * Get the platform key for GCS downloads
 */
function getPlatformKey() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'win32') return arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  return null;
}

/**
 * Get the directory where the managed Claude binary is stored
 */
function getClaudeDir() {
  return path.join(userDataPath, 'claude');
}

/**
 * Get the path to the managed Claude binary
 */
function getClaudeBinaryPath() {
  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  return path.join(getClaudeDir(), binaryName);
}

/**
 * Get the path to version.json
 */
function getVersionFilePath() {
  return path.join(getClaudeDir(), 'version.json');
}

function getManagedAuthVerifiedPath() {
  return path.join(getClaudeDir(), 'managed-auth-verified.json');
}

function invalidateStatusCache() {
  statusCache = null;
  statusCacheAt = 0;
}

function cloneStatus(status) {
  return status ? { ...status } : status;
}

function getStatusCacheTtl(status) {
  return status?.authenticated ? STATUS_CACHE_SUCCESS_TTL_MS : STATUS_CACHE_FAILURE_TTL_MS;
}

function getCachedStatus() {
  if (!statusCache) return null;
  const ttlMs = getStatusCacheTtl(statusCache);
  if (Date.now() - statusCacheAt >= ttlMs) {
    invalidateStatusCache();
    return null;
  }
  return cloneStatus(statusCache);
}

function setCachedStatus(status) {
  statusCache = cloneStatus(status);
  statusCacheAt = Date.now();
  return cloneStatus(statusCache);
}

function readManagedAuthVerification() {
  try {
    const verificationPath = getManagedAuthVerifiedPath();
    if (!fs.existsSync(verificationPath)) return null;
    const raw = JSON.parse(fs.readFileSync(verificationPath, 'utf8'));
    return {
      verifiedAt: Number(raw?.verifiedAt) || 0,
      version: typeof raw?.version === 'string' ? raw.version : null
    };
  } catch (err) {
    console.log('Error reading managed Claude auth verification:', err.message);
    return null;
  }
}

function writeManagedAuthVerification(version) {
  try {
    const claudeDir = getClaudeDir();
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    fs.writeFileSync(getManagedAuthVerifiedPath(), JSON.stringify({
      verifiedAt: Date.now(),
      version: version || null
    }, null, 2), 'utf8');
  } catch (err) {
    console.log('Error writing managed Claude auth verification:', err.message);
  }
}

function clearManagedAuthVerification() {
  try {
    const verificationPath = getManagedAuthVerifiedPath();
    if (fs.existsSync(verificationPath)) {
      fs.unlinkSync(verificationPath);
    }
  } catch (err) {
    console.log('Error clearing managed Claude auth verification:', err.message);
  }
}

function isManagedAuthRecentlyVerified(version) {
  const verification = readManagedAuthVerification();
  if (!verification?.verifiedAt) return false;
  if (Date.now() - verification.verifiedAt > MANAGED_AUTH_VERIFICATION_MAX_AGE_MS) {
    clearManagedAuthVerification();
    return false;
  }
  if (verification.version && version && verification.version !== version) {
    return false;
  }
  return true;
}

/**
 * Pick http or https module based on URL protocol
 */
function httpGet(url, callback) {
  const mod = url.startsWith('http://') ? http : https;
  return mod.get(url, callback);
}

/**
 * Fetch text content from a URL
 */
function fetchText(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount >= MAX_REDIRECTS) {
      reject(new Error(`Too many redirects fetching ${url}`));
      return;
    }
    httpGet(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchText(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data.trim()));
    }).on('error', reject);
  });
}

/**
 * Discover the GCS base URL by fetching and parsing the install script
 */
async function discoverGcsBaseUrl() {
  if (cachedGcsBase) return cachedGcsBase;

  try {
    const scriptContent = await fetchText(INSTALL_SCRIPT_URL);

    const match = scriptContent.match(/\$GCS_BUCKET\s*=\s*"([^"]+)"/);
    if (match && match[1]) {
      cachedGcsBase = match[1];
      console.log('Discovered GCS base URL from install script:', cachedGcsBase);
      return cachedGcsBase;
    }

    console.log('Could not parse GCS_BUCKET from install script, using fallback');
    return FALLBACK_GCS_BASE;
  } catch (err) {
    console.log('GCS URL discovery failed, using fallback:', err.message);
    return FALLBACK_GCS_BASE;
  }
}

/**
 * Fetch the latest version string from GCS
 */
async function getLatestVersion() {
  const base = await discoverGcsBaseUrl();
  return fetchText(`${base}/latest`);
}

/**
 * Get the currently installed version from version.json
 */
function getInstalledVersion() {
  try {
    const versionFile = getVersionFilePath();
    if (fs.existsSync(versionFile)) {
      const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      return data.version || null;
    }
  } catch (err) {
    console.log('Error reading Claude version file:', err.message);
  }
  return null;
}

/**
 * Check if the managed Claude binary is installed
 */
function isClaudeInstalled() {
  return fs.existsSync(getClaudeBinaryPath());
}

function isRetryableDownloadError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return false;

  return (
    msg.includes('download stalled') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('eai_again') ||
    msg.includes('temporarily unavailable') ||
    /http 5\d\d/.test(msg)
  );
}

/**
 * Download a file to disk with progress reporting.
 * Follows redirects (http/https), enforces a redirect limit and socket timeout.
 */
function downloadToFile(url, destPath, onProgress, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount >= MAX_REDIRECTS) {
      reject(new Error(`Too many redirects downloading ${url}`));
      return;
    }

    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = destPath + '.tmp';
    // Only create the write stream on the first call (not on redirects)
    const file = redirectCount === 0 ? fs.createWriteStream(tempPath) : null;

    const cleanup = () => {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
    };

    const request = httpGet(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        response.resume(); // drain the response
        if (file) file.close();
        downloadToFile(response.headers.location, destPath, onProgress, redirectCount + 1)
          .then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        if (file) file.close();
        cleanup();
        reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
        return;
      }

      const contentType = response.headers['content-type'] || '';
      if (contentType.includes('text/html')) {
        if (file) file.close();
        cleanup();
        reject(new Error('Received HTML instead of binary'));
        return;
      }

      // We have the final response — create the write stream if we came through redirects
      const writeStream = file || fs.createWriteStream(tempPath);

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;

      // Timeout if no data is received for a while (slow networks can pause)
      let activityTimeout;
      const resetTimeout = () => {
        clearTimeout(activityTimeout);
        activityTimeout = setTimeout(() => {
          request.destroy();
          writeStream.close();
          cleanup();
          reject(new Error(`Download stalled — no data received for ${Math.round(DOWNLOAD_ACTIVITY_TIMEOUT_MS / 1000)} seconds`));
        }, DOWNLOAD_ACTIVITY_TIMEOUT_MS);
      };
      resetTimeout();

      response.on('data', (chunk) => {
        resetTimeout();
        downloadedBytes += chunk.length;
        if (onProgress && totalBytes > 0) {
          onProgress(Math.round((downloadedBytes / totalBytes) * 100));
        }
      });

      response.pipe(writeStream);

      writeStream.on('finish', () => {
        clearTimeout(activityTimeout);
        writeStream.close(() => {
          try {
            fs.renameSync(tempPath, destPath);
            if (process.platform !== 'win32') {
              fs.chmodSync(destPath, 0o755);
            }
            resolve(destPath);
          } catch (err) {
            cleanup();
            reject(err);
          }
        });
      });

      writeStream.on('error', (err) => {
        clearTimeout(activityTimeout);
        cleanup();
        reject(err);
      });
    });

    request.on('error', (err) => {
      if (file) file.close();
      cleanup();
      reject(err);
    });
  });
}

async function downloadToFileWithRetry(url, destPath, onProgress, onStatus) {
  let lastErr = null;

  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      return await downloadToFile(url, destPath, onProgress);
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableDownloadError(err);
      if (!retryable || attempt >= DOWNLOAD_MAX_ATTEMPTS) {
        break;
      }

      const delayMs = DOWNLOAD_RETRY_DELAY_MS * attempt;
      console.warn(`Claude CLI download attempt ${attempt}/${DOWNLOAD_MAX_ATTEMPTS} failed: ${err.message}. Retrying in ${delayMs}ms...`);
      if (onStatus) {
        onStatus({
          status: 'retrying',
          attempt: attempt + 1,
          maxAttempts: DOWNLOAD_MAX_ATTEMPTS,
          message: err.message
        });
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastErr;
}

/**
 * Compute SHA256 hash of a file
 */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Save version info to version.json
 */
function saveVersionInfo(version) {
  const versionFile = getVersionFilePath();
  fs.writeFileSync(versionFile, JSON.stringify({
    version,
    downloadedAt: new Date().toISOString()
  }));
  invalidateStatusCache();
}

/**
 * Accept a pending checksum mismatch and keep the downloaded binary
 */
function acceptChecksumMismatch() {
  if (!pendingChecksumSkip) {
    throw new Error('No pending checksum mismatch to accept');
  }
  const { destPath, version } = pendingChecksumSkip;
  pendingChecksumSkip = null;
  if (!fs.existsSync(destPath)) {
    throw new Error('Downloaded binary no longer exists');
  }
  saveVersionInfo(version);
  console.log('Checksum mismatch accepted by user, saved version:', version);
  return destPath;
}

/**
 * Download the Claude CLI binary with progress
 * Flow: fetch /latest -> fetch manifest -> download binary -> verify checksum -> save
 */
async function downloadClaudeBinary(onProgress) {
  // Check for 32-bit Windows (matches official install.ps1)
  if (process.platform === 'win32' && process.arch === 'ia32') {
    throw new Error('Claude Code does not support 32-bit Windows. Please use a 64-bit version of Windows.');
  }

  // Check git-bash requirement on Windows before downloading
  if (process.platform === 'win32' && !isGitBashAvailable()) {
    throw new Error('GIT_BASH_REQUIRED');
  }

  const platformKey = getPlatformKey();
  if (!platformKey) {
    throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  }

  if (onProgress) onProgress({ percent: 0, status: 'downloading' });

  // 1. Get latest version
  const version = await getLatestVersion();
  console.log('Latest Claude CLI version:', version);

  // 2. Fetch manifest and get checksum (required, matches official install.ps1)
  const gcsBase = await discoverGcsBaseUrl();
  const manifestUrl = `${gcsBase}/${version}/manifest.json`;
  const manifestText = await fetchText(manifestUrl);
  const manifest = JSON.parse(manifestText);
  const expectedHash = manifest.platforms?.[platformKey]?.checksum;
  if (!expectedHash) {
    throw new Error(`Platform ${platformKey} not found in manifest`);
  }

  // 3. Download binary
  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const binaryUrl = `${gcsBase}/${version}/${platformKey}/${binaryName}`;
  const destPath = getClaudeBinaryPath();

  console.log('Downloading Claude CLI from:', binaryUrl);
  await downloadToFileWithRetry(
    binaryUrl,
    destPath,
    (percent) => {
      if (onProgress) onProgress({ percent: Math.round(percent * 0.9), status: 'downloading' });
    },
    (statusUpdate) => {
      if (onProgress) onProgress(statusUpdate);
    }
  );

  // 4. Verify checksum (mandatory, matches official install.ps1)
  if (onProgress) onProgress({ percent: 90, status: 'verifying' });
  const actualHash = await hashFile(destPath);
  if (actualHash !== expectedHash) {
    // Keep binary on disk so user can choose to continue anyway
    pendingChecksumSkip = { destPath, version };
    throw new Error('CHECKSUM_MISMATCH');
  }
  console.log('Claude CLI checksum verified');

  // 5. Save version info
  saveVersionInfo(version);

  if (onProgress) onProgress({ percent: 100, status: 'complete' });
  console.log('Claude CLI downloaded successfully:', version);
  return destPath;
}

/**
 * Check for updates and download if a newer version is available
 */
async function updateClaudeBinary() {
  try {
    const latestVersion = await getLatestVersion();
    const installedVersion = getInstalledVersion();

    if (installedVersion === latestVersion && isClaudeInstalled()) {
      console.log('Claude CLI is up to date:', installedVersion);
      return false;
    }

    console.log(`Claude CLI update available: ${installedVersion || 'none'} -> ${latestVersion}`);
    await downloadClaudeBinary();
    return true;
  } catch (err) {
    console.error('Failed to update Claude CLI:', err.message);
    return false;
  }
}

function saveApiKey(apiKey) {
  // Save to userData/claude/api-key
  const claudeDir = getClaudeDir();
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  fs.writeFileSync(path.join(claudeDir, 'api-key'), apiKey, 'utf8');
  invalidateStatusCache();

  // Also write to ~/.claude.json for the Claude CLI to pick up
  const home = require('os').homedir();
  const claudeJsonPath = path.join(home, '.claude.json');
  try {
    let config = {};
    if (fs.existsSync(claudeJsonPath)) {
      config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    }
    config.apiKey = apiKey;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing ~/.claude.json:', err.message);
  }
}

/**
 * Get saved API key if any
 */
function getSavedApiKey() {
  try {
    const keyPath = path.join(getClaudeDir(), 'api-key');
    if (fs.existsSync(keyPath)) {
      return fs.readFileSync(keyPath, 'utf8').trim();
    }
  } catch (err) {
    console.log('Error reading saved API key:', err.message);
  }
  return null;
}

/**
 * Get the status of the managed Claude CLI
 */
function getStatus() {
  const cached = getCachedStatus();
  if (cached) {
    return cached;
  }

  let installed = isClaudeInstalled();
  const version = getInstalledVersion();
  let needsGitBash = false;

  // On Windows, Claude CLI requires git-bash
  if (installed && process.platform === 'win32' && !isGitBashAvailable()) {
    console.log('Claude binary exists but git-bash is not installed');
    installed = false;
    needsGitBash = true;
  }

  const hasApiKey = !!getSavedApiKey();

  // Check if authenticated via ~/.claude credentials
  let authenticated = hasApiKey;
  if (!authenticated) {
    const home = require('os').homedir();
    const credPaths = [
      path.join(home, '.claude', '.credentials.json'),
      path.join(home, '.claude', 'credentials.json'),
    ];
    for (const p of credPaths) {
      if (fs.existsSync(p)) {
        authenticated = true;
        break;
      }
    }
  }

  if (!authenticated && installed && isManagedAuthRecentlyVerified(version)) {
    authenticated = true;
  }

  // If still not authenticated and binary is installed, actually test the binary
  let testOutput = null;
  if (!authenticated && installed) {
    const binaryPath = getClaudeBinaryPath();
    console.log('Credential files not found, testing managed binary auth:', binaryPath);
    try {
      const { execSync } = require('child_process');
      const result = execSync(`"${binaryPath}" -p "Reply with just OK" --max-turns 1`, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
      });
      console.log('Managed binary auth test passed:', result.trim());
      authenticated = true;
      writeManagedAuthVerification(version);
    } catch (err) {
      const stderr = (err.stderr || '').toString();
      const stdout = (err.stdout || '').toString();
      testOutput = (stderr + '\n' + stdout).trim() || err.message || '';
      console.log('Managed binary auth test failed:', testOutput);
      clearManagedAuthVerification();
    }
  }

  return setCachedStatus({ installed, version, authenticated, needsGitBash, testOutput });
}

module.exports = {
  init,
  getClaudeBinaryPath,
  getLatestVersion,
  getInstalledVersion,
  downloadClaudeBinary,
  acceptChecksumMismatch,
  updateClaudeBinary,
  isClaudeInstalled,
  saveApiKey,
  getSavedApiKey,
  getStatus
};
