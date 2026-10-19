import { wsUrlToHttpBase } from './core/urls.js';
import { electronAPI } from './core/platform.js';
import { localApiFetch } from './local-api-auth.js';

function getMessage(value, fallback = 'Unknown error') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value.message === 'string' && value.message.trim()) return value.message.trim();
  if (typeof value.error === 'string' && value.error.trim()) return value.error.trim();
  return String(value);
}

async function getGoHttpBase(app = {}) {
  const wsUrl = app.wsUrl || await electronAPI()?.getWsUrl?.();
  return wsUrlToHttpBase(wsUrl);
}

async function postGoSetup(path, app = {}) {
  const httpBase = await getGoHttpBase(app);
  const response = await localApiFetch(`${httpBase}${path}`, {
    method: 'POST',
    cache: 'no-store'
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    payload = {};
  }
  if (!response.ok) {
    return {
      ...payload,
      success: false,
      error: payload.error || `Request failed (${response.status})`
    };
  }
  return payload;
}

export async function installPluginWithGoFallback(app = {}) {
  let electronError = '';
  try {
    const result = await electronAPI()?.installPlugin?.();
    if (result?.success) {
      return { ...result, installer: 'electron' };
    }
    electronError = getMessage(result, 'Electron installer returned an unsuccessful result');
  } catch (err) {
    electronError = getMessage(err);
  }

  console.warn('[plugin] Electron plugin install failed; retrying through Go fallback:', electronError);

  let goError = '';
  try {
    const result = await postGoSetup('/setup/install-plugin', app);
    if (result?.success) {
      return { ...result, installer: 'go-fallback', electronError };
    }
    goError = getMessage(result, 'Go fallback installer returned an unsuccessful result');
  } catch (err) {
    goError = getMessage(err);
  }

  return {
    success: false,
    installer: 'failed',
    electronError,
    goError,
    error: `Electron install failed: ${electronError}. Go fallback failed: ${goError}`
  };
}
