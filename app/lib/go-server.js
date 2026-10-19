/**
 * Go server management module
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const config = require('./config');

// Configuration
const GO_BINARY_BASE_URL = config.releasesUrl;
const GO_BINARY_URLS = {
  'win32-x64': `${GO_BINARY_BASE_URL}/ropilot-infra-win32-x64.exe`,
  'darwin-x64': `${GO_BINARY_BASE_URL}/ropilot-infra-darwin-x64`,
  'darwin-arm64': `${GO_BINARY_BASE_URL}/ropilot-infra-darwin-arm64`,
  'linux-x64': `${GO_BINARY_BASE_URL}/ropilot-infra-linux-x64`,
};

let goServer = null;
let goServerPort = 8765;
let userDataPath = null;
let appDirname = null;
let isPackaged = false;
let isTestMode = false;
let resourcesPath = null;
let lastStartError = '';
let goServerReady = false;
let goServerDesired = false;
let unexpectedRestartTimer = null;
let unexpectedRestartInFlight = null;
let unexpectedRestartAttempt = 0;
const intentionallyStoppedProcesses = new WeakSet();

const MAC_CPU_TYPES = {
  x64: 0x01000007,
  arm64: 0x0100000c,
};
const UNEXPECTED_RESTART_DELAYS_MS = [250, 1000, 3000];
const BINARY_PROBE_TIMEOUT_MS = 10_000;
const BINARY_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

function isRedirectStatus(statusCode) {
  return statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308;
}

function setRequestTimeout(request, timeoutMs, message) {
  request.setTimeout(timeoutMs, () => {
    request.destroy(new Error(message));
  });
  return request;
}

/**
 * Initialize the module with app paths
 */
function init(config) {
  userDataPath = config.userDataPath;
  appDirname = config.dirname;
  isPackaged = config.isPackaged;
  isTestMode = !!config.isTest;
  resourcesPath = config.resourcesPath;
  if (config.port) goServerPort = config.port;
}

/**
 * Get the path to the cached Go binary
 */
function getCachedBinaryPath() {
  const cacheDir = path.join(userDataPath, 'bin');
  return path.join(cacheDir, getPlatformBinaryName());
}

function ensureCacheDir() {
  if (!userDataPath) return null;
  const cacheDir = path.join(userDataPath, 'bin');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

function getPlatformBinaryName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return 'ropilot-infra.exe';
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'ropilot-infra-arm64' : 'ropilot-infra-amd64';
  }
  return 'ropilot-infra';
}

/**
 * Get the URL for the current platform's Go binary
 */
function getGoBinaryUrl() {
  const platform = process.platform;
  const arch = process.arch;
  const key = `${platform}-${arch}`;
  return GO_BINARY_URLS[key] || null;
}

function uniquePathList(paths) {
  const seen = new Set();
  return paths.filter((candidate) => {
    if (!candidate || seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

function getBundledBinaryCandidates(binaryName = getPlatformBinaryName()) {
  return uniquePathList([
    resourcesPath ? path.join(resourcesPath, 'bin', binaryName) : null,
    appDirname ? path.resolve(appDirname, '..', 'bin', binaryName) : null,
    process.execPath ? path.join(path.dirname(process.execPath), 'resources', 'bin', binaryName) : null,
  ]);
}

function filesMatch(left, right) {
  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return leftStat.size === rightStat.size && fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch (_) {
    return false;
  }
}

function replaceFileFromBundled(source, destination) {
  if (filesMatch(source, destination)) {
    return false;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.native-update-${process.pid}`;
  fs.rmSync(temporary, { force: true });
  try {
    fs.copyFileSync(source, temporary);
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw err;
  }
  return true;
}

function syncBundledWindowsHelperLauncher() {
  if (!isPackaged || process.platform !== 'win32' || !userDataPath) {
    return;
  }

  const launcherName = 'ropilot-infra-helper-launcher.exe';
  const bundledPath = getBundledBinaryCandidates(launcherName).find(candidate => fs.existsSync(candidate));
  if (!bundledPath) {
    return;
  }

  const cacheDir = ensureCacheDir();
  const destinations = [
    path.join(cacheDir, launcherName),
    path.join(cacheDir, 'startup', launcherName),
  ];
  for (const destination of destinations) {
    try {
      if (replaceFileFromBundled(bundledPath, destination)) {
        console.log('Refreshed native helper launcher from bundled binary:', bundledPath, '->', destination);
      }
    } catch (err) {
      console.warn('Failed to refresh native helper launcher:', destination, err.message);
    }
  }
}

function seedCachedBinaryFromBundled(options = {}) {
  if (!isPackaged) return null;
  syncBundledWindowsHelperLauncher();
  const { force = false } = options;

  const cachedPath = getCachedBinaryPath();
  if (!force && fs.existsSync(cachedPath)) {
    return cachedPath;
  }

  ensureCacheDir();

  for (const bundledPath of getBundledBinaryCandidates()) {
    if (!fs.existsSync(bundledPath)) {
      continue;
    }

    // The .etag names the remote build the cache holds. Once these bytes are
    // replaced it is a lie, and updateGoBinary would report "up to date"
    // forever, pinning the user to the installer's old helper (2026-10-05:
    // GPT 6 Luna turns arrived as gpt-5.6-sol and were billed). Drop it
    // before copying so a crash mid-seed can't leave it behind; a failure
    // here must not block startup, so it only warns.
    try {
      fs.rmSync(`${cachedPath}.etag`, { force: true });
    } catch (err) {
      console.warn('Failed to clear cached Go binary etag:', err.message);
    }

    try {
      if (force && fs.existsSync(cachedPath)) {
        fs.rmSync(cachedPath, { force: true });
      }
      fs.copyFileSync(bundledPath, cachedPath);
      if (process.platform !== 'win32') {
        fs.chmodSync(cachedPath, 0o755);
      }
      console.log('Seeded cached Go binary from bundled binary:', bundledPath, '->', cachedPath);
      return cachedPath;
    } catch (err) {
      console.warn('Failed to seed cached Go binary from bundled path:', bundledPath, err.message);
    }
  }

  return null;
}

function killManagedMCPSidecars() {
  const targetBinary = getCachedBinaryPath();
  if (!targetBinary) return;

  if (process.platform === 'win32') {
    try {
      execSync('taskkill /F /T /IM ropilot-infra.exe', { stdio: 'ignore' });
      console.log('Killed ropilot-infra MCP sidecars via taskkill');
    } catch (_) {
      // Ignore if no matching processes remain.
    }
    return;
  }

  try {
    const escaped = targetBinary.replace(/(["\\$`])/g, '\\$1');
    execSync(`pkill -f "^${escaped}( |$).*\\bmcp\\b"`, { stdio: 'ignore', shell: '/bin/sh' });
    console.log('Killed managed ropilot-infra MCP sidecars');
  } catch (err) {
    // Ignore "no matching process" style failures.
  }
}

function killAllManagedGoProcesses() {
  const targetBinary = getCachedBinaryPath();
  if (!targetBinary) return;

  if (process.platform === 'win32') {
    try {
      execSync('taskkill /F /T /IM ropilot-infra.exe', { stdio: 'ignore' });
      console.log('Killed all ropilot-infra.exe processes via taskkill');
    } catch (_) {
      // Ignore if no matching processes remain.
    }
    return;
  }

  try {
    const escaped = targetBinary.replace(/(["\\$`])/g, '\\$1');
    execSync(`pkill -f "^${escaped}( |$)"`, { stdio: 'ignore', shell: '/bin/sh' });
    console.log('Killed all managed ropilot-infra processes');
  } catch (err) {
    // Ignore "no matching process" style failures.
  }
}

function isLockedBinaryError(err) {
  const msg = String(err && err.message || err || '').toLowerCase();
  return msg.includes('eperm') ||
    msg.includes('eexist') ||
    msg.includes('ebusy') ||
    msg.includes('access is denied') ||
    msg.includes('resource busy') ||
    msg.includes('being used by another process') ||
    msg.includes('operation not permitted');
}

function replaceFileWindowsSafe(tempPath, destPath) {
  try {
    if (fs.existsSync(destPath)) {
      fs.rmSync(destPath, { force: true });
    }
  } catch (err) {
    throw err;
  }
  fs.renameSync(tempPath, destPath);
}

/**
 * Download file with progress
 */
function downloadFile(url, destPath, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many redirects downloading Go binary'));
  }
  return new Promise((resolve, reject) => {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = destPath + '.tmp';
    const file = fs.createWriteStream(tempPath);

    const cleanupAndDo = (fn) => {
      file.close(() => {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
        fn();
      });
    };

    const request = https.get(url, (response) => {
      // Handle redirects
      if (isRedirectStatus(response.statusCode)) {
        cleanupAndDo(() => {
          const redirectUrl = new URL(response.headers.location, url).toString();
          downloadFile(redirectUrl, destPath, redirectCount + 1).then(resolve).catch(reject);
        });
        return;
      }

      if (response.statusCode !== 200) {
        cleanupAndDo(() => reject(new Error(`HTTP ${response.statusCode}`)));
        return;
      }

      // Reject HTML responses (e.g. Cloudflare Access sign-in pages)
      const contentType = response.headers['content-type'] || '';
      if (contentType.includes('text/html')) {
        cleanupAndDo(() => reject(new Error('Received HTML instead of binary — possible Cloudflare Access or error page')));
        return;
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          try {
            // Move temp file to final destination. Windows is stricter about
            // replacing an existing .exe in-place, so remove the old file first.
            if (process.platform === 'win32') {
              replaceFileWindowsSafe(tempPath, destPath);
            } else {
              fs.renameSync(tempPath, destPath);
            }
            // Make executable on Unix
            if (process.platform !== 'win32') {
              fs.chmodSync(destPath, 0o755);
            }
            resolve(destPath);
          } catch (err) {
            reject(err);
          }
        });
      });
    });

    request.on('error', (err) => {
      cleanupAndDo(() => reject(err));
    });
    setRequestTimeout(request, BINARY_DOWNLOAD_IDLE_TIMEOUT_MS, 'Go binary download timed out');

    file.on('error', (err) => {
      cleanupAndDo(() => reject(err));
    });
  });
}

async function downloadCachedBinary(url, cachedPath) {
  try {
    await downloadFile(url, cachedPath);
  } catch (err) {
    if (!isLockedBinaryError(err)) {
      throw err;
    }

    console.log('Go binary appears locked, killing managed ropilot-infra processes and retrying update');
    killAllManagedGoProcesses();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await downloadFile(url, cachedPath);
  }
}

/**
 * Check for Go binary updates and download if needed
 */
async function updateGoBinary() {
  if (!isPackaged) {
    console.log('[GO-UPDATER] Skipping remote binary update (development — use desktop/bin build)');
    return null;
  }
  if (isTestMode) {
    console.log('[GO-UPDATER] Skipping remote binary update (--test — local desktop/bin build preferred, never clobbered)');
    return null;
  }

  const url = getGoBinaryUrl();
  if (!url) {
    console.log('No Go binary URL for this platform');
    return null;
  }

  const cachedPath = getCachedBinaryPath();
  console.log('[GO-UPDATER] retry-on-lock build active');

  // First launch of packaged apps may not have created userData/bin yet.
  // Seed from the bundled install so startup still has a local binary even
  // if the network probe fails before an update download can begin.
  ensureCacheDir();
  seedCachedBinaryFromBundled();

  // Best-effort stale sidecar cleanup so the cached binary can be replaced.
  killManagedMCPSidecars();

  try {
    // Some environments allow GET downloads but fail HEAD probes. If that
    // happens on first launch, fall back to a direct download instead of
    // treating the binary as missing and bailing out.
    let remoteInfo;
    try {
      remoteInfo = await new Promise((resolve, reject) => {
        const req = https.request(url, { method: 'HEAD' }, (res) => {
          if (isRedirectStatus(res.statusCode)) {
            // Follow redirect for HEAD
            const redirectUrl = new URL(res.headers.location, url).toString();
            const redirectReq = https.request(redirectUrl, { method: 'HEAD' }, (res2) => {
              resolve({
                size: parseInt(res2.headers['content-length'] || '0', 10),
                etag: res2.headers['etag'] || '',
              });
            });
            redirectReq.on('error', reject);
            setRequestTimeout(redirectReq, BINARY_PROBE_TIMEOUT_MS, 'Go binary redirect probe timed out');
            redirectReq.end();
          } else {
            resolve({
              size: parseInt(res.headers['content-length'] || '0', 10),
              etag: res.headers['etag'] || '',
            });
          }
        });
        req.on('error', reject);
        setRequestTimeout(req, BINARY_PROBE_TIMEOUT_MS, 'Go binary probe timed out');
        req.end();
      });
    } catch (headErr) {
      console.warn('Failed to probe Go binary with HEAD:', headErr.message);

      if (fs.existsSync(cachedPath)) {
        console.log('Using cached Go binary after failed HEAD probe');
        return cachedPath;
      }

      console.log('No cached Go binary available after failed HEAD probe; attempting direct download');
      await downloadCachedBinary(url, cachedPath);
      return cachedPath;
    }

    // Check if we need to download
    let needsDownload = true;
    const etagPath = cachedPath + '.etag';

    if (fs.existsSync(cachedPath) && fs.existsSync(etagPath)) {
      const localEtag = fs.readFileSync(etagPath, 'utf8').trim();
      if (localEtag === remoteInfo.etag && remoteInfo.etag) {
        console.log('Go binary is up to date');
        needsDownload = false;
      }
    }

    if (needsDownload) {
      console.log('Downloading Go binary update from:', url);
      await downloadCachedBinary(url, cachedPath);

      // Save etag for future checks
      if (remoteInfo.etag) {
        fs.writeFileSync(etagPath, remoteInfo.etag);
      }
      console.log('Go binary updated successfully');
    }

    return cachedPath;
  } catch (err) {
    console.error('Failed to update Go binary:', err.message);
    // Return cached path if it exists, otherwise null
    return fs.existsSync(cachedPath) ? cachedPath : null;
  }
}

/**
 * Find the Go binary for current platform
 * Priority:
 *   - Packaged: cached/updated binary, then bundled binary
 *   - Development: local dev build paths, then cached binary fallback
 */
function getBinaryCandidates() {
  const platform = process.platform;
  const binaryName = getPlatformBinaryName();

  const cachedPath = getCachedBinaryPath();
  const possiblePaths = [];

  if (isPackaged && !isTestMode) {
    seedCachedBinaryFromBundled();
    // Packaged app: prefer cached auto-updated binary, then bundled fallback.
    possiblePaths.push(cachedPath);
    possiblePaths.push(...getBundledBinaryCandidates(binaryName));
  } else {
    // Development mode: prefer local built binaries first to avoid stale
    // %APPDATA% cache masking freshly rebuilt server binaries.
    possiblePaths.push(
      // Build script output: desktop/bin/{platform}/
      path.join(appDirname, 'bin', platform, binaryName),
      // Legacy: Windows binary in root
      path.join(appDirname, '..', binaryName),
      path.join(appDirname, '..', 'ropilot-infra.exe'),
      // Legacy: macOS/Linux in bin folder
      path.join(appDirname, '..', 'bin', binaryName),
      // Cached binary (remote auto-updated) as final fallback
      cachedPath,
    );
  }

  return uniquePathList(possiblePaths);
}

function findGoBinary() {
  const possiblePaths = getBinaryCandidates();

  console.log(`Looking for Go binary (packaged: ${isPackaged}):`, possiblePaths);

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      console.log('Found Go binary at:', p);
      return p;
    }
  }

  console.error('Go binary not found in any of:', possiblePaths);
  return null;
}

function ensureBinaryIsExecutable(binaryPath) {
  if (!binaryPath || process.platform === 'win32') return;

  try {
    const stat = fs.statSync(binaryPath);
    if ((stat.mode & 0o111) !== 0) {
      return;
    }
    fs.chmodSync(binaryPath, stat.mode | 0o755);
    console.log('Restored execute permissions on Go binary:', binaryPath);
  } catch (err) {
    console.warn('Failed to verify Go binary permissions:', err.message);
  }
}

function validateMacBinaryArchitecture(binaryPath, arch = process.arch) {
  if (process.platform !== 'darwin') return { valid: true };

  const expectedCPU = MAC_CPU_TYPES[arch];
  if (!expectedCPU) {
    return { valid: false, error: `Unsupported macOS architecture: ${arch}` };
  }

  try {
    const fd = fs.openSync(binaryPath, 'r');
    try {
      const header = Buffer.alloc(8);
      const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
      if (bytesRead !== header.length) {
        return { valid: false, error: 'Binary is too small to contain a Mach-O header' };
      }

      const magic = header.readUInt32LE(0);
      if (magic !== 0xfeedfacf) {
        return { valid: false, error: 'Binary is not a 64-bit Mach-O executable' };
      }

      const actualCPU = header.readUInt32LE(4);
      if (actualCPU !== expectedCPU) {
        return {
          valid: false,
          error: `Binary architecture mismatch: expected ${arch}, Mach-O CPU type 0x${actualCPU.toString(16)}`,
        };
      }
      return { valid: true };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { valid: false, error: err.message || String(err) };
  }
}

function clearGoServerIfCurrent(serverProcess) {
  if (goServer !== serverProcess) return false;
  goServer = null;
  return true;
}

function attachGoServerLifecycle(serverProcess) {
  goServer = serverProcess;

  serverProcess.on('error', (err) => {
    if (goServer === serverProcess) {
      lastStartError = err.message || String(err);
    }
    console.error('Failed to start Go server:', err);
  });

  serverProcess.on('close', (code, signal) => {
    const wasCurrent = clearGoServerIfCurrent(serverProcess);
    const intentional = intentionallyStoppedProcesses.has(serverProcess);
    if (wasCurrent && !intentional && code !== 0) {
      lastStartError = `Go server exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
    }
    console.log(`Go server exited with code ${code}${signal ? ` signal ${signal}` : ''}`);

    if (wasCurrent && !intentional && goServerDesired && goServerReady) {
      goServerReady = false;
      scheduleUnexpectedRestart();
    }
  });
}

function getLastStartError() {
  return lastStartError;
}

function spawnGoServer(binary) {
  const macValidation = validateMacBinaryArchitecture(binary);
  if (!macValidation.valid) {
    lastStartError = `Invalid macOS backend binary ${binary}: ${macValidation.error}`;
    console.error(lastStartError);
    return null;
  }

  ensureBinaryIsExecutable(binary);
  console.log('Starting Go server:', binary);

  const env = {
    ...process.env,
    PORT: String(goServerPort),
    ROPILOT_EDGE_URL: config.edgeUrl,
    ROPILOT_USERDATA: userDataPath
  };

  // If user authenticated via API key, pass it to the Go server
  const apiKeyPath = path.join(userDataPath, 'claude', 'api-key');
  if (fs.existsSync(apiKeyPath)) {
    try {
      env.ANTHROPIC_API_KEY = fs.readFileSync(apiKeyPath, 'utf8').trim();
    } catch (e) {}
  }

  const isWin = process.platform === 'win32';
  // On Windows with shell mode, paths with spaces need to be quoted
  const binaryPath = isWin ? `"${binary}"` : binary;
  const serverProcess = spawn(binaryPath, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWin,  // Use shell on Windows to avoid spawn UNKNOWN errors
    windowsHide: true
  });

  goServerDesired = true;
  goServerReady = false;
  attachGoServerLifecycle(serverProcess);

  serverProcess.stdout.on('data', (data) => {
    console.log(`[Go] ${data.toString().trim()}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[Go Error] ${data.toString().trim()}`);
  });

  return serverProcess;
}

/**
 * Start the Go WebSocket server
 */
function startGoServer() {
  lastStartError = '';
  const binary = findGoBinary();

  if (!binary) {
    if (isPackaged) {
      const seededPath = seedCachedBinaryFromBundled({ force: true });
      if (seededPath && fs.existsSync(seededPath)) {
        console.log('Retrying Go binary lookup after force-seeding bundled binary');
        return spawnGoServer(seededPath);
      }
    }

    lastStartError = `Go binary not found for ${process.platform}-${process.arch}`;
    console.error(lastStartError);
    return null;
  }

  try {
    return spawnGoServer(binary);
  } catch (err) {
    lastStartError = err.message || String(err);
    console.error('Error spawning Go server:', err);
    return null;
  }
}

function waitForProcessClose(serverProcess, gracefulTimeoutMs = 6000, forcedTimeoutMs = 1000) {
  if (!serverProcess || serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(abandonTimer);
      resolve();
    };
    let abandonTimer = null;
    const forceTimer = setTimeout(() => {
      try { serverProcess.kill('SIGKILL'); } catch (_) {}
      abandonTimer = setTimeout(finish, forcedTimeoutMs);
    }, gracefulTimeoutMs);
    serverProcess.once('close', finish);
  });
}

async function stopGoServerForRecovery() {
  const serverProcess = goServer;
  if (!serverProcess) return;

  intentionallyStoppedProcesses.add(serverProcess);
  const closePromise = waitForProcessClose(serverProcess);
  try {
    if (process.platform === 'win32' && serverProcess.pid) {
      execSync(`taskkill /F /T /PID ${serverProcess.pid}`, { stdio: 'ignore' });
    } else {
      serverProcess.kill('SIGTERM');
    }
  } catch (_) {
    // The process may already have exited.
  }
  await closePromise;
  clearGoServerIfCurrent(serverProcess);
}

function bundledRecoveryBinary() {
  if (!isPackaged) return null;
  const seededPath = seedCachedBinaryFromBundled({ force: true });
  if (!seededPath) return null;

  const validation = validateMacBinaryArchitecture(seededPath);
  if (!validation.valid) {
    lastStartError = `Bundled macOS backend is invalid: ${validation.error}`;
    console.error(lastStartError);
    return null;
  }
  return seededPath;
}

async function recoverGoServerStartup(options = {}) {
  const { preferBundled = false } = options;
  console.warn('Attempting Go server startup recovery');
  await stopGoServerForRecovery();

  if (preferBundled) {
    const fallback = bundledRecoveryBinary();
    if (fallback) {
      console.warn('Starting known-good bundled Go binary after cached binary failed readiness');
      return spawnGoServer(fallback);
    }
  }

  const binary = findGoBinary();
  if (!binary) {
    lastStartError = `Go binary not found for ${process.platform}-${process.arch}`;
    console.error(lastStartError);
    return null;
  }

  return spawnGoServer(binary);
}

function requestHealth(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https://') ? https : http;
    const req = mod.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`health status ${res.statusCode}`));
          return;
        }
        try {
          const data = body ? JSON.parse(body) : {};
          resolve(data);
        } catch {
          resolve({});
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('health request timeout'));
    });
    req.on('error', reject);
  });
}

function isReadyHealthResponse(data) {
  return !!data && data.status === 'healthy' && data.ready === true;
}

function computeBackoffDelay(baseMs, maxMs, attempt) {
  const noJitter = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 100);
  return noJitter + jitter;
}

async function waitForServerReady(options = {}) {
  const {
    maxAttempts = 12,
    baseDelayMs = 150,
    maxDelayMs = 1500,
    restartAttempts = 2,
  } = options;
  const healthUrl = `http://127.0.0.1:${goServerPort}/health`;

  for (let restartAttempt = 0; restartAttempt <= restartAttempts; restartAttempt++) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const health = await requestHealth(healthUrl);
        if (!isReadyHealthResponse(health)) {
          throw new Error('health response did not report ready');
        }
        goServerReady = true;
        unexpectedRestartAttempt = 0;
        return true;
      } catch (err) {
        const shouldRecover = !goServer || attempt === maxAttempts;
        if (!shouldRecover) {
          const delayMs = computeBackoffDelay(baseDelayMs, maxDelayMs, attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        if (restartAttempt === restartAttempts) {
          break;
        }

        console.warn(
          `Go server failed to become ready (attempt ${attempt}/${maxAttempts}, recovery ${restartAttempt + 1}/${restartAttempts}):`,
          lastStartError || err.message
        );

        const restarted = await recoverGoServerStartup({
          preferBundled: restartAttempt > 0,
        });
        if (!restarted) {
          break;
        }
        break;
      }
    }
  }

  goServerReady = false;
  return false;
}

function scheduleUnexpectedRestart() {
  if (!goServerDesired || unexpectedRestartTimer || unexpectedRestartInFlight) return;

  const delayIndex = Math.min(unexpectedRestartAttempt, UNEXPECTED_RESTART_DELAYS_MS.length - 1);
  const delayMs = UNEXPECTED_RESTART_DELAYS_MS[delayIndex];
  unexpectedRestartAttempt += 1;
  console.warn(`[GO-WATCHDOG] Backend exited after readiness; recovering in ${delayMs}ms`);

  unexpectedRestartTimer = setTimeout(() => {
    unexpectedRestartTimer = null;
    unexpectedRestartInFlight = (async () => {
      const healthUrl = `http://127.0.0.1:${goServerPort}/health`;
      try {
        const health = await requestHealth(healthUrl, 750);
        if (isReadyHealthResponse(health)) {
          goServerReady = true;
          unexpectedRestartAttempt = 0;
          return;
        }
      } catch (_) {}

      const restarted = await recoverGoServerStartup({
        preferBundled: unexpectedRestartAttempt > 1,
      });
      if (restarted && await waitForServerReady({ restartAttempts: 0 })) {
        console.log('[GO-WATCHDOG] Backend recovered');
        return;
      }

      if (goServerDesired) scheduleUnexpectedRestart();
    })().catch((err) => {
      lastStartError = err.message || String(err);
      console.error('[GO-WATCHDOG] Backend recovery failed:', err);
      if (goServerDesired) scheduleUnexpectedRestart();
    }).finally(() => {
      unexpectedRestartInFlight = null;
      if (goServerDesired && !goServerReady) scheduleUnexpectedRestart();
    });
  }, delayMs);
}

/**
 * Kill the Go server
 */
function killGoServer() {
  goServerDesired = false;
  goServerReady = false;
  unexpectedRestartAttempt = 0;
  if (unexpectedRestartTimer) {
    clearTimeout(unexpectedRestartTimer);
    unexpectedRestartTimer = null;
  }
  if (goServer) {
    const serverProcess = goServer;
    intentionallyStoppedProcesses.add(serverProcess);
    const pid = serverProcess.pid;
    console.log('Killing Go server PID:', pid);

    if (process.platform === 'win32' && pid) {
      // On Windows with shell: true, we need to kill the entire process tree
      // /T kills child processes, /F forces termination
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } catch (e) {
        // Ignore errors - process may already be dead
      }
    } else {
      // Unix: graceful kill
      serverProcess.kill('SIGTERM');
    }
    clearGoServerIfCurrent(serverProcess);
  }

  killManagedMCPSidecars();
}

/**
 * Get the WebSocket URL
 */
function getWsUrl() {
  return `ws://localhost:${goServerPort}/ws`;
}

/**
 * Get the server port
 */
function getPort() {
  return goServerPort;
}

module.exports = {
  init,
  getCachedBinaryPath,
  getGoBinaryUrl,
  updateGoBinary,
  findGoBinary,
  getLastStartError,
  startGoServer,
  waitForServerReady,
  killGoServer,
  killManagedMCPSidecars,
  killAllManagedGoProcesses,
  getWsUrl,
  getPort,
  __test__: {
    computeBackoffDelay,
    getBinaryCandidates,
    getBundledBinaryCandidates,
    seedCachedBinaryFromBundled,
    validateMacBinaryArchitecture,
    isReadyHealthResponse,
    attachGoServerLifecycle,
    clearGoServerIfCurrent,
    waitForProcessClose,
    isRedirectStatus,
    setRequestTimeout,
    getManagedProcess: () => goServer,
    resetManagedProcess: () => {
      goServer = null;
      goServerReady = false;
      goServerDesired = false;
    },
  }
};
