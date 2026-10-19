import { electronAPI as resolveElectronAPI } from './core/platform.js';

export const LOCAL_API_TOKEN_HEADER = 'X-Ropilot-Local-Token';
export const LOCAL_API_TOKEN_FILE = 'local-api-token-v1';
export const LOCAL_API_PROTOCOL = 'ropilot.v1';
export const LOCAL_API_AUTH_PROTOCOL_PREFIX = 'ropilot.auth.';

let cachedToken = '';
let tokenReadPromise = null;
let lastMissAt = 0;
const capabilityCache = new Map();

function isValidToken(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim());
}

function isLocalAPIURL(value) {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch (_) {
    return false;
  }
}

function tokenPath(userDataPath) {
  const base = String(userDataPath || '').replace(/[\\/]+$/, '');
  if (!base) return '';
  const separator = base.includes('\\') ? '\\' : '/';
  return `${base}${separator}${LOCAL_API_TOKEN_FILE}`;
}

async function readInstalledToken(explicitAPI) {
  const api = explicitAPI || resolveElectronAPI();
  if (!api?.getUserDataPath || !api?.readFile) return '';

  const userDataPath = await api.getUserDataPath();
  const path = tokenPath(userDataPath);
  if (!path) return '';
  const result = await api.readFile(path);
  const token = result?.success ? String(result.content || '').trim() : '';
  return isValidToken(token) ? token : '';
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(''), timeoutMs)),
  ]);
}

function websocketHealthURL(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else return '';
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

async function serverSupportsLocalAuth(url, options = {}) {
  if (typeof options.capabilityProbe === 'function') {
    return options.capabilityProbe(url);
  }
  const healthURL = websocketHealthURL(url);
  if (!healthURL) return false;
  const origin = new URL(healthURL).origin;
  const cached = capabilityCache.get(origin);
  if (cached && Date.now() - cached.checkedAt < 1000) {
    return cached.supported;
  }

  const fetchImpl = options.capabilityFetchImpl || ((...args) => fetch(...args));
  try {
    const response = await withTimeout(fetchImpl(healthURL, { method: 'GET', cache: 'no-store' }), options.timeoutMs ?? 500);
    if (!response?.ok) throw new Error('capability probe failed');
    const payload = await withTimeout(response.json(), options.timeoutMs ?? 500);
    const supported = Number(payload?.local_auth_version) >= 1;
    capabilityCache.set(origin, { supported, checkedAt: Date.now() });
    return supported;
  } catch (_) {
    capabilityCache.set(origin, { supported: false, checkedAt: Date.now() });
    return false;
  }
}

export async function getLocalAPIToken(options = {}) {
  if (cachedToken) return cachedToken;
  if (Date.now() - lastMissAt < 1000) return '';

  if (!tokenReadPromise) {
    tokenReadPromise = readInstalledToken(options.electronApi)
      .then((token) => {
        if (token) cachedToken = token;
        else lastMissAt = Date.now();
        return token;
      })
      .catch(() => {
        lastMissAt = Date.now();
        return '';
      })
      .finally(() => {
        tokenReadPromise = null;
      });
  }

  return withTimeout(tokenReadPromise, options.timeoutMs ?? 500);
}

function headersWithToken(headers, token) {
  if (typeof Headers === 'function') {
    const merged = new Headers(headers || undefined);
    merged.set(LOCAL_API_TOKEN_HEADER, token);
    return merged;
  }
  if (Array.isArray(headers)) {
    return [...headers, [LOCAL_API_TOKEN_HEADER, token]];
  }
  return { ...(headers || {}), [LOCAL_API_TOKEN_HEADER]: token };
}

export async function localApiFetch(input, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
  if (!isLocalAPIURL(url)) return fetchImpl(input, init);

  const token = await getLocalAPIToken(options);
  if (!token) return fetchImpl(input, init);
  return fetchImpl(input, { ...init, headers: headersWithToken(init.headers, token) });
}

export async function getLocalAPIWebSocketProtocols(url, options = {}) {
  if (!isLocalAPIURL(url)) return [];
  if (!await serverSupportsLocalAuth(url, options)) return [];
  const token = await getLocalAPIToken(options);
  if (!token) return [];
  return [LOCAL_API_PROTOCOL, `${LOCAL_API_AUTH_PROTOCOL_PREFIX}${token}`];
}

export async function createLocalAPIWebSocket(url, options = {}) {
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const protocols = await getLocalAPIWebSocketProtocols(url, options);
  return protocols.length > 0 ? new WebSocketImpl(url, protocols) : new WebSocketImpl(url);
}

export function clearLocalAPIAuthCacheForTests() {
  cachedToken = '';
  tokenReadPromise = null;
  lastMissAt = 0;
  capabilityCache.clear();
}

export const __test__ = {
  isLocalAPIURL,
  isValidToken,
  tokenPath,
  websocketHealthURL,
};
