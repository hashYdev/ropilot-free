import { wsUrlToHttpBase, DEFAULT_LOCAL_SERVER_BASE } from './core/urls.js';
import { electronAPI } from './core/platform.js';
import { localApiFetch } from './local-api-auth.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json'
};

function getElectronApi(explicitApi) {
  return explicitApi || electronAPI();
}

async function resolveHttpBase(explicitApi, getWsUrl) {
  const explicitWsUrl = typeof getWsUrl === 'function' ? await getWsUrl() : '';
  if (explicitWsUrl) {
    return wsUrlToHttpBase(explicitWsUrl);
  }

  const electronAPI = getElectronApi(explicitApi);
  if (electronAPI?.getWsUrl) {
    try {
      const wsUrl = await electronAPI.getWsUrl();
      if (wsUrl) {
        return wsUrlToHttpBase(wsUrl);
      }
    } catch (_) {
      // Fall through to localhost.
    }
  }

  return DEFAULT_LOCAL_SERVER_BASE;
}

async function postJson(url, payload, fetchImpl, electronApi, defaultCode) {
  try {
    const response = await localApiFetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(payload)
    }, { fetchImpl, electronApi });
    const rawBody = await response.text();
    let parsedBody = null;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch (_) {
        return {
          success: false,
          error: 'Invalid chat sync response',
          code: defaultCode
        };
      }
    }

    if (!response.ok) {
      return {
        success: false,
        error: parsedBody?.error || `Chat sync request failed (${response.status})`,
        code: parsedBody?.code || defaultCode
      };
    }

    return parsedBody || { success: false, error: 'Empty chat sync response', code: defaultCode };
  } catch (err) {
    return {
      success: false,
      error: err?.message || String(err),
      code: defaultCode
    };
  }
}

export function createElectronChatSyncFileAdapter(options = {}) {
  const explicitApi = options.electronApi || null;
  const getWsUrl = options.getWsUrl || null;
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));

  return {
    async resolveFiles(descriptor) {
      const httpBase = await resolveHttpBase(explicitApi, getWsUrl);
      return postJson(`${httpBase}/chat-sync/resolve`, descriptor, fetchImpl, getElectronApi(explicitApi), 'SYNC_FILE_RESOLVE_FAILED');
    },

    async readFile(filePath) {
      const httpBase = await resolveHttpBase(explicitApi, getWsUrl);
      return postJson(`${httpBase}/chat-sync/read`, { filePath }, fetchImpl, getElectronApi(explicitApi), 'SYNC_FILE_READ_FAILED');
    }
  };
}
