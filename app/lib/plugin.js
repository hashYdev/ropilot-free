/**
 * Roblox plugin management module
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { app } = require('electron');
const config = require('./config');

const PLUGIN_SITE_URL = config.isTest ? 'https://ropilot.ai' : config.siteUrl;
const PLUGIN_VERSION_URL = `${PLUGIN_SITE_URL}/plugin/version`;
const PLUGIN_DOWNLOAD_URL = `${PLUGIN_SITE_URL}/plugin/StudioPlugin.lua`;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_MAX_ATTEMPTS = 3;
const REQUEST_RETRY_DELAY_MS = 1000;
const PLUGIN_IDENTIFIER_SETTING = 'Ropilot_Identifier';
const PLUGIN_BOOTSTRAP_STATE_FILE = 'ropilot-plugin-bootstrap.json';

function getBootstrapStatePath() {
  return path.join(app.getPath('userData'), PLUGIN_BOOTSTRAP_STATE_FILE);
}

function readBootstrapApiKey() {
  try {
    const raw = JSON.parse(fs.readFileSync(getBootstrapStatePath(), 'utf8'));
    return typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '';
  } catch (_) {
    return '';
  }
}

function escapeLuaString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function stripInjectedPluginBootstrap(source) {
  return source.replace(
    /(?:if not plugin:GetSetting\("Ropilot_Identifier"\) then )?plugin:SetSetting\("Ropilot_Identifier", "(?:[^"\\]|\\.)*"\)(?: end)?\s*/g,
    ''
  );
}

function injectInitialPluginKey(source, apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return source;

  const bootstrap = `if not plugin:GetSetting("${PLUGIN_IDENTIFIER_SETTING}") then plugin:SetSetting("${PLUGIN_IDENTIFIER_SETTING}", "${escapeLuaString(key)}") end `;
  if (source.includes(`plugin:SetSetting("${PLUGIN_IDENTIFIER_SETTING}", `) || source.includes(`if not plugin:GetSetting("${PLUGIN_IDENTIFIER_SETTING}") then plugin:SetSetting("${PLUGIN_IDENTIFIER_SETTING}", `)) {
    return source.replace(
      /(?:if not plugin:GetSetting\("Ropilot_Identifier"\) then )?plugin:SetSetting\("Ropilot_Identifier", "(?:[^"\\]|\\.)*"\)(?: end)?\s*/,
      bootstrap
    );
  }

  const commentEnd = source.startsWith('--[[') ? source.indexOf(']]') : -1;
  if (commentEnd >= 0) {
    return `${source.slice(0, commentEnd + 2)}${bootstrap}${source.slice(commentEnd + 2)}`;
  }

  return `${bootstrap}${source}`;
}

function computePluginHash(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16);
}

function computeComparablePluginHash(source) {
  return computePluginHash(stripInjectedPluginBootstrap(source));
}

function extractVersionInfo(versionInfo) {
  if (!versionInfo || typeof versionInfo !== 'object') {
    return { version: null, hash: null };
  }

  const version = typeof versionInfo.version === 'string' ? versionInfo.version : null;
  const hash = typeof versionInfo.hash === 'string' ? versionInfo.hash : version;
  return { version, hash };
}

function getHttpModule(url) {
  return url.startsWith('http://') ? http : https;
}

function formatNetworkError(err) {
  const messages = [];
  let current = err;
  let depth = 0;

  while (current && depth < 4) {
    const message = typeof current?.message === 'string' ? current.message.trim() : '';
    if (message && !messages.includes(message)) {
      messages.push(message);
    }
    current = current.cause;
    depth += 1;
  }

  return messages.join(' - ') || 'Unknown network error';
}

function isRetryableRequestError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return false;

  return (
    msg.includes('fetch failed') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('eai_again') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    /http 5\d\d/.test(msg)
  );
}

function httpRequest(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount >= MAX_REDIRECTS) {
      reject(new Error(`Too many redirects fetching ${url}`));
      return;
    }

    const req = getHttpModule(url).get(url, {
      headers: {
        'User-Agent': 'ropilot-desktop',
        'Accept': '*/*'
      }
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) {
          reject(new Error(`Redirect without location header from ${url}`));
          return;
        }
        res.resume();
        httpRequest(new URL(redirectUrl, url).toString(), redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${statusCode} fetching ${url}`));
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve(body);
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

async function httpRequestWithRetry(url) {
  let lastError = null;

  for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await httpRequest(url);
    } catch (err) {
      lastError = err;
      if (attempt === REQUEST_MAX_ATTEMPTS || !isRetryableRequestError(err)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, REQUEST_RETRY_DELAY_MS));
    }
  }

  throw lastError;
}

async function fetchJson(url) {
  const text = await httpRequestWithRetry(url);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON from ${url}: ${err.message}`);
  }
}

async function fetchText(url) {
  return httpRequestWithRetry(url);
}

function resolvePluginDownloadUrl(versionInfo) {
  const raw = typeof versionInfo?.download_url === 'string' ? versionInfo.download_url.trim() : '';
  if (!raw) {
    return PLUGIN_DOWNLOAD_URL;
  }

  try {
    return new URL(raw, PLUGIN_SITE_URL).toString();
  } catch (_) {
    return PLUGIN_DOWNLOAD_URL;
  }
}

/**
 * Get the Roblox plugins folder path
 */
function getPluginsFolder() {
  const platform = process.platform;

  if (platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Roblox', 'Plugins');
  } else if (platform === 'darwin') {
    return path.join(os.homedir(), 'Documents', 'Roblox', 'Plugins');
  }
  return null;
}

/**
 * Install the Ropilot Studio plugin
 */
async function installPlugin() {
  try {
    // Fetch version info
    const versionInfo = await fetchJson(PLUGIN_VERSION_URL);
    const { version: latestVersion, hash: expectedHash } = extractVersionInfo(versionInfo);

    // Download plugin
    const pluginSource = await fetchText(resolvePluginDownloadUrl(versionInfo));
    const downloadedHash = computeComparablePluginHash(pluginSource);

    if (expectedHash && expectedHash !== downloadedHash) {
      throw new Error(`Downloaded plugin hash mismatch (expected ${expectedHash}, got ${downloadedHash})`);
    }

    const customizedPluginSource = injectInitialPluginKey(pluginSource, readBootstrapApiKey());
    const customizedHash = computePluginHash(customizedPluginSource);

    // Get plugins folder
    const pluginsFolder = getPluginsFolder();
    if (!pluginsFolder) {
      throw new Error('Could not determine Roblox plugins folder for this platform');
    }

    // Create folder if needed
    fs.mkdirSync(pluginsFolder, { recursive: true });

    // Write plugin file
    const pluginPath = path.join(pluginsFolder, 'RopilotPlugin.lua');
    fs.writeFileSync(pluginPath, customizedPluginSource);

    // Verify written file matches downloaded source.
    const installedSource = fs.readFileSync(pluginPath, 'utf-8');
    const installedHash = computePluginHash(installedSource);
    if (installedHash !== customizedHash) {
      throw new Error(`Installed plugin hash mismatch (expected ${customizedHash}, got ${installedHash})`);
    }

    const resolvedVersion = latestVersion || downloadedHash;
    console.log(`Plugin ${resolvedVersion} installed to ${pluginPath}`);
    return { success: true, version: resolvedVersion, hash: downloadedHash, path: pluginPath };
  } catch (err) {
    console.error('Plugin install failed:', err);
    return { success: false, error: formatNetworkError(err) };
  }
}

/**
 * Get the plugin installation status
 */
async function getPluginStatus() {
  try {
    const pluginsFolder = getPluginsFolder();
    if (!pluginsFolder) {
      return { installed: false };
    }

    const pluginPath = path.join(pluginsFolder, 'RopilotPlugin.lua');
    if (!fs.existsSync(pluginPath)) {
      return { installed: false };
    }

    // Read local plugin and compute exact content hash
    const localPlugin = fs.readFileSync(pluginPath, 'utf-8');
    const localHash = computeComparablePluginHash(localPlugin);

    // Check latest version
    try {
      const versionInfo = await fetchJson(PLUGIN_VERSION_URL);
      const { version: latestVersionRaw, hash: latestHash } = extractVersionInfo(versionInfo);
      const latestVersion = latestVersionRaw || latestHash;
      return {
        installed: true,
        localHash,
        latestHash: latestHash || null,
        localVersion: localHash,
        latestVersion: latestVersion || null,
        updateAvailable: latestHash ? (localHash !== latestHash) : false
      };
    } catch (e) {
      // Offline - just return local info
    }

    return { installed: true, localHash, localVersion: localHash };
  } catch (err) {
    console.error('Failed to get plugin status:', err);
    return { installed: false, error: err.message };
  }
}

module.exports = {
  getPluginsFolder,
  installPlugin,
  getPluginStatus
};
