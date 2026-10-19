/**
 * Codex CLI binary management module
 * Downloads, updates, and manages the Codex CLI binary + login flow
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const os = require('os');

const MAX_REDIRECTS = 5;
const DOWNLOAD_ACTIVITY_TIMEOUT_MS = 120000;
const DOWNLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1500;

const RELEASE_API_URL = 'https://api.github.com/repos/openai/codex/releases/latest';

let userDataPath = null;
let cachedRelease = null;

function init(config) {
  userDataPath = config.userDataPath;
}

function getCodexDir() {
  return path.join(userDataPath, 'codex');
}

function getCodexBinaryPath() {
  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  return path.join(getCodexDir(), binaryName);
}

function getVersionFilePath() {
  return path.join(getCodexDir(), 'version.json');
}

function getPlatformAssetName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    if (arch === 'arm64') return 'codex-aarch64-pc-windows-msvc.exe';
    return 'codex-x86_64-pc-windows-msvc.exe';
  }

  if (platform === 'darwin') {
    if (arch === 'arm64') return 'codex-aarch64-apple-darwin.tar.gz';
    return 'codex-x86_64-apple-darwin.tar.gz';
  }

  if (platform === 'linux') {
    if (arch === 'arm64') return 'codex-aarch64-unknown-linux-musl.tar.gz';
    return 'codex-x86_64-unknown-linux-musl.tar.gz';
  }

  return null;
}

function httpRequestJson(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount >= MAX_REDIRECTS) {
      reject(new Error(`Too many redirects fetching ${url}`));
      return;
    }

    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'ropilot-desktop',
        'Accept': 'application/vnd.github+json'
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) {
          reject(new Error(`Redirect without location header from ${url}`));
          return;
        }
        res.resume();
        httpRequestJson(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }

      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(new Error(`Invalid JSON from ${url}: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
  });
}

async function getLatestRelease() {
  if (cachedRelease) return cachedRelease;
  const release = await httpRequestJson(RELEASE_API_URL);
  cachedRelease = release;
  return release;
}

function getInstalledVersion() {
  try {
    const versionFile = getVersionFilePath();
    if (fs.existsSync(versionFile)) {
      const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      return data.version || null;
    }
  } catch (err) {
    console.log('Error reading Codex version file:', err.message);
  }
  return null;
}

async function getLatestVersion() {
  const release = await getLatestRelease();
  return release?.tag_name || null;
}

function isCodexInstalled() {
  return fs.existsSync(getCodexBinaryPath());
}

function decodeBase64UrlJson(segment) {
  if (typeof segment !== 'string' || segment.length === 0) return null;
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  return decodeBase64UrlJson(parts[1]);
}

function normalizeCodexPlanRaw(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function getCodexPlanDisplayName(raw) {
  switch (normalizeCodexPlanRaw(raw)) {
    case 'free':
      return 'Free';
    case 'go':
      return 'Go';
    case 'plus':
      return 'Plus';
    case 'pro':
      return 'Pro';
    case 'prolite':
      return 'Pro Lite';
    case 'team':
      return 'Team';
    case 'self_serve_business_usage_based':
      return 'Self Serve Business Usage Based';
    case 'business':
      return 'Business';
    case 'enterprise_cbp_usage_based':
      return 'Enterprise CBP Usage Based';
    case 'enterprise':
    case 'hc':
      return 'Enterprise';
    case 'education':
    case 'edu':
      return 'Edu';
    default:
      return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }
}

function getCodexHomeCandidates() {
  const candidates = [];
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    candidates.push(process.env.CODEX_HOME.trim());
  }
  candidates.push(path.join(os.homedir(), '.codex'));
  if (process.env.USERPROFILE && process.env.USERPROFILE.trim()) {
    candidates.push(path.join(process.env.USERPROFILE.trim(), '.codex'));
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

function readCodexAccountInfo() {
  for (const codexHome of getCodexHomeCandidates()) {
    const authPath = path.join(codexHome, 'auth.json');
    if (!fs.existsSync(authPath)) continue;

    try {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      const tokens = auth && typeof auth === 'object' ? auth.tokens : null;
      if (!tokens || typeof tokens !== 'object') continue;

      const idPayload = decodeJwtPayload(tokens.id_token);
      const accessPayload = decodeJwtPayload(tokens.access_token);
      const authClaims = idPayload?.['https://api.openai.com/auth']
        || accessPayload?.['https://api.openai.com/auth']
        || {};
      const profileClaims = idPayload?.['https://api.openai.com/profile']
        || accessPayload?.['https://api.openai.com/profile']
        || {};
      const planRaw = normalizeCodexPlanRaw(authClaims.chatgpt_plan_type);
      const email = profileClaims.email || idPayload?.email || accessPayload?.email || null;
      const accountId = tokens.account_id || authClaims.chatgpt_account_id || null;

      return {
        accountPlanRaw: planRaw || null,
        accountPlan: getCodexPlanDisplayName(planRaw),
        accountEmail: email,
        accountId,
        authPath,
        lastRefresh: auth.last_refresh || null
      };
    } catch (err) {
      console.warn('Failed to read Codex auth account info:', err.message);
    }
  }

  return {
    accountPlanRaw: null,
    accountPlan: null,
    accountEmail: null,
    accountId: null,
    authPath: null,
    lastRefresh: null
  };
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
    const file = redirectCount === 0 ? fs.createWriteStream(tempPath) : null;

    const cleanup = () => {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
    };

    const mod = url.startsWith('http://') ? http : https;
    const request = mod.get(url, {
      headers: {
        'User-Agent': 'ropilot-desktop',
        'Accept': 'application/octet-stream'
      }
    }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
        response.resume();
        if (file) file.close();
        downloadToFile(response.headers.location, destPath, onProgress, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        if (file) file.close();
        cleanup();
        reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
        return;
      }

      const writeStream = file || fs.createWriteStream(tempPath);
      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;

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
      console.warn(`Codex CLI download attempt ${attempt}/${DOWNLOAD_MAX_ATTEMPTS} failed: ${err.message}. Retrying in ${delayMs}ms...`);
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

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// The Go helper treats the runtime as complete only when version.json lists
// BOTH the main binary asset and the code-mode host sidecar in runtimeAssets
// (server/codex_upgrade_auto.go codexInstalledRuntimeComplete). Writing only
// {version, asset} made every Electron update look incomplete, so the helper
// launched Codex with code mode disabled and GPT-6 tool calls failed
// ("code-mode host is disabled") until a background repair ran.
function saveVersionInfo(version, assetName, runtimeAssets) {
  const versionFile = getVersionFilePath();
  const info = {
    version,
    asset: assetName,
    downloadedAt: new Date().toISOString()
  };
  if (Array.isArray(runtimeAssets) && runtimeAssets.length > 0) {
    info.runtimeAssets = runtimeAssets;
  }
  const tempFile = `${versionFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(info));
  fs.renameSync(tempFile, versionFile);
}

function getCodeModeHostAssetName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    if (arch === 'arm64') return 'codex-code-mode-host-aarch64-pc-windows-msvc.exe';
    return 'codex-code-mode-host-x86_64-pc-windows-msvc.exe';
  }

  if (platform === 'darwin') {
    if (arch === 'arm64') return 'codex-code-mode-host-aarch64-apple-darwin.tar.gz';
    return 'codex-code-mode-host-x86_64-apple-darwin.tar.gz';
  }

  if (platform === 'linux') {
    if (arch === 'arm64') return 'codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz';
    return 'codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz';
  }

  return null;
}

function getCodeModeHostPath() {
  const binaryName = process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host';
  return path.join(getCodexDir(), binaryName);
}

function resolveReleaseAsset(release) {
  const targetName = getPlatformAssetName();
  if (!targetName) {
    throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  }

  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((a) => a.name === targetName);
  if (!asset) {
    throw new Error(`Codex release asset not found for ${targetName}`);
  }

  return asset;
}

function extractTarArchive(archivePath, expectedBinaryName, finalPath = getCodexBinaryPath()) {
  const outputDir = getCodexDir();
  execFileSync('tar', ['-xzf', archivePath, '-C', outputDir]);

  const expectedExtractedPath = path.join(outputDir, expectedBinaryName);
  let extractedPath = expectedExtractedPath;

  if (!fs.existsSync(extractedPath)) {
    const isHost = expectedBinaryName.startsWith('codex-code-mode-host');
    const entries = fs.readdirSync(outputDir, { withFileTypes: true });
    const candidate = entries.find((entry) => {
      if (!entry.isFile()) return false;
      if (entry.name === path.basename(getCodexBinaryPath())) return false;
      if (entry.name === path.basename(getCodeModeHostPath())) return false;
      if (entry.name.endsWith('.tar.gz') || entry.name.endsWith('.json') || entry.name.endsWith('.tmp')) return false;
      return isHost ? entry.name.startsWith('codex-code-mode-host') : (entry.name.startsWith('codex-') && !entry.name.startsWith('codex-code-mode-host'));
    });
    if (!candidate) {
      throw new Error('Downloaded archive did not contain expected codex binary');
    }
    extractedPath = path.join(outputDir, candidate.name);
  }

  try {
    fs.rmSync(finalPath, { force: true });
  } catch (_) {}
  fs.renameSync(extractedPath, finalPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(finalPath, 0o755);
  }
}

// Download, verify and publish one release asset to finalPath.
async function installReleaseAsset(asset, finalPath, onProgress, progressBase, progressSpan) {
  const codexDir = getCodexDir();
  const isArchive = asset.name.endsWith('.tar.gz');
  // Downloading straight to finalPath (the downloader stages it at
  // "<path>.tmp") keeps the temp path the Go helper watches as its "Electron
  // update in progress" guard: codex.exe.tmp on Windows, <asset>.tar.gz.tmp
  // elsewhere (server/setup_install_codex.go codexLegacyUpdateTempPath).
  const downloadPath = isArchive
    ? path.join(codexDir, asset.name)
    : finalPath;

  await downloadToFileWithRetry(
    asset.browser_download_url,
    downloadPath,
    (percent) => {
      if (onProgress) onProgress({ percent: Math.round(progressBase + percent * progressSpan), status: 'downloading' });
    },
    (statusUpdate) => {
      if (onProgress) onProgress(statusUpdate);
    }
  );

  const expectedDigest = String(asset.digest || '').trim();
  if (expectedDigest.startsWith('sha256:')) {
    const expectedHash = expectedDigest.replace(/^sha256:/, '').trim().toLowerCase();
    const actualHash = (await hashFile(downloadPath)).toLowerCase();
    if (expectedHash && actualHash !== expectedHash) {
      // Only drop a downloaded archive; a non-archive asset already sits at
      // its final path, and deleting it could remove the working codex.exe.
      if (isArchive) { try { fs.unlinkSync(downloadPath); } catch (_) {} }
      throw new Error('Codex checksum verification failed');
    }
  }

  if (isArchive) {
    extractTarArchive(downloadPath, asset.name.replace(/\.tar\.gz$/, ''), finalPath);
    try { fs.unlinkSync(downloadPath); } catch (_) {}
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(finalPath, 0o755);
  }
}

async function downloadCodexBinary(onProgress) {
  const release = await getLatestRelease();
  const version = release.tag_name;
  const asset = resolveReleaseAsset(release);
  const hostAssetName = getCodeModeHostAssetName();
  const hostAsset = hostAssetName
    ? (Array.isArray(release?.assets) ? release.assets : []).find((a) => a.name === hostAssetName)
    : null;

  if (onProgress) onProgress({ percent: 0, status: 'downloading' });

  const codexDir = getCodexDir();
  if (!fs.existsSync(codexDir)) {
    fs.mkdirSync(codexDir, { recursive: true });
  }

  // Main binary, then the code-mode host sidecar GPT-6 models require. The
  // sidecar is published first under its own name, so a failed sidecar
  // download leaves the previous (complete) runtime untouched.
  if (hostAsset) {
    await installReleaseAsset(hostAsset, getCodeModeHostPath(), onProgress, 0, 0.3);
  }
  await installReleaseAsset(asset, getCodexBinaryPath(), onProgress, hostAsset ? 30 : 0, hostAsset ? 0.6 : 0.9);

  if (onProgress) onProgress({ percent: 94, status: 'verifying' });

  const runtimeAssets = hostAsset ? [asset.name, hostAsset.name] : [asset.name];
  saveVersionInfo(version, asset.name, runtimeAssets);
  if (!hostAsset) {
    console.log(`Codex release ${version} has no ${hostAssetName || 'code-mode host'} asset; the helper will repair the runtime.`);
  }

  if (onProgress) onProgress({ percent: 100, status: 'complete' });
  return getCodexBinaryPath();
}

async function updateCodexBinary() {
  try {
    const latestVersion = await getLatestVersion();
    const installedVersion = getInstalledVersion();

    if (installedVersion === latestVersion && isCodexInstalled()) {
      console.log('Codex CLI is up to date:', installedVersion);
      return false;
    }

    console.log(`Codex CLI update available: ${installedVersion || 'none'} -> ${latestVersion}`);
    await downloadCodexBinary();
    return true;
  } catch (err) {
    console.error('Failed to update Codex CLI:', err.message);
    return false;
  }
}

function getStatus() {
  const installed = isCodexInstalled();
  const version = getInstalledVersion();
  let authenticated = false;
  let testOutput = null;
  let accountInfo = readCodexAccountInfo();

  if (installed) {
    const binaryPath = getCodexBinaryPath();
    try {
      execFileSync(binaryPath, ['login', 'status'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000,
        cwd: path.dirname(binaryPath)
      });
      authenticated = true;
    } catch (err) {
      const stderr = (err.stderr || '').toString();
      const stdout = (err.stdout || '').toString();
      testOutput = (stderr + '\n' + stdout).trim() || err.message || '';
    }
  }

  if (!authenticated) {
    accountInfo = {
      accountPlanRaw: null,
      accountPlan: null,
      accountEmail: null,
      accountId: null,
      authPath: accountInfo.authPath,
      lastRefresh: null
    };
  }

  return { installed, version, authenticated, testOutput, ...accountInfo };
}

module.exports = {
  init,
  getCodexBinaryPath,
  getLatestVersion,
  getInstalledVersion,
  downloadCodexBinary,
  updateCodexBinary,
  isCodexInstalled,
  getStatus,
  readCodexAccountInfo,
  decodeJwtPayload,
  getCodexPlanDisplayName
};
