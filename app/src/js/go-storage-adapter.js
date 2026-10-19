import { DEFAULT_LOCAL_SERVER_BASE, wsUrlToHttpBase } from './core/urls.js';
import { electronAPI } from './core/platform.js';
import { localApiFetch } from './local-api-auth.js';

const STORAGE_API_PREFIX = '/storage/v1';
const STORAGE_REQUEST_TIMEOUT_MS = 30000;

function getElectronApi(explicitApi) {
  return explicitApi || electronAPI();
}

async function resolveHttpBase(explicitApi, getWsUrl) {
  const explicitWsUrl = typeof getWsUrl === 'function' ? await getWsUrl() : '';
  if (explicitWsUrl) return wsUrlToHttpBase(explicitWsUrl);

  const api = getElectronApi(explicitApi);
  if (api?.getWsUrl) {
    try {
      const wsUrl = await api.getWsUrl();
      if (wsUrl) return wsUrlToHttpBase(wsUrl);
    } catch (_) {
      // Fall through to the normal local server.
    }
  }
  return DEFAULT_LOCAL_SERVER_BASE;
}

async function postStorage(path, payload, options) {
  const httpBase = await resolveHttpBase(options.electronApi, options.getWsUrl);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), options.timeoutMs ?? STORAGE_REQUEST_TIMEOUT_MS)
    : null;
  try {
    const response = await localApiFetch(`${httpBase}${STORAGE_API_PREFIX}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {})
    }, {
      fetchImpl: options.fetchImpl,
      electronApi: getElectronApi(options.electronApi)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      // httpStatus lets callers tell "this endpoint does not exist in this Go
      // build" (404) apart from "storage is broken", so a missing optional
      // route never condemns the whole storage layer.
      return {
        ...(body || {
          success: false,
          error: `Storage request failed (${response.status})`,
          code: 'STORAGE_REQUEST_FAILED'
        }),
        httpStatus: response.status
      };
    }
    return body
      ? { ...body, httpStatus: response.status }
      : { success: false, error: 'Empty storage response', code: 'STORAGE_REQUEST_FAILED', httpStatus: response.status };
  } catch (err) {
    return {
      success: false,
      error: err?.name === 'AbortError' ? 'Storage request timed out' : (err?.message || String(err)),
      code: 'STORAGE_UNAVAILABLE'
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function createGoStorageAdapter(options = {}) {
  const adapterOptions = {
    electronApi: options.electronApi || null,
    getWsUrl: options.getWsUrl || null,
    fetchImpl: options.fetchImpl || ((...args) => fetch(...args)),
    timeoutMs: options.timeoutMs ?? STORAGE_REQUEST_TIMEOUT_MS
  };
  return {
    load(target) {
      return postStorage('/load', target, adapterOptions);
    },
    commit(target) {
      return postStorage('/commit', target, adapterOptions);
    },
    recover(target) {
      return postStorage('/recover', target, adapterOptions);
    },
    listBackups(target) {
      return postStorage('/list-backups', target, adapterOptions);
    },
    delete(target) {
      return postStorage('/delete', target, adapterOptions);
    },
    sweep(target = {}) {
      return postStorage('/sweep', target, adapterOptions);
    }
  };
}
