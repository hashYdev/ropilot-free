// @ts-check
// Shared URL resolution for the local Go server.
//
// Two variants exist on purpose — they replaced three independent copies,
// and the two behaviors differ:
//  - wsUrlToHttpBase keeps everything but a trailing "/ws" and falls back to
//    the default local server when no WS URL is known (used for HTTP calls
//    that must always have somewhere to go).
//  - wsUrlToHttpOrigin strips the entire path/query/hash and returns '' when
//    the WS URL is missing or malformed (used for building preview-image
//    URLs, where a wrong-origin guess is worse than no URL).

export const DEFAULT_LOCAL_SERVER_BASE = 'http://localhost:8765';

/**
 * ws(s):// WebSocket URL → http(s):// base with any trailing "/ws" removed.
 * @param {unknown} wsUrl
 * @param {string} [fallback]
 * @returns {string}
 */
export function wsUrlToHttpBase(wsUrl, fallback = DEFAULT_LOCAL_SERVER_BASE) {
  if (typeof wsUrl !== 'string' || wsUrl.trim() === '') return fallback;
  return wsUrl
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/ws$/, '');
}

/**
 * Normalized site URL from the runtime config: trimmed, trailing slashes
 * removed, fallback when unset/blank. (Distinct from api-validation.js's
 * resolveSiteUrlForApiKey, which picks test vs prod by API-key prefix.)
 * @param {{siteUrl?: unknown}|null|undefined} config
 * @param {string} [fallback]
 * @returns {string}
 */
export function siteUrlFromConfig(config, fallback = 'https://ropilot.ai') {
  const raw = typeof config?.siteUrl === 'string' ? config.siteUrl.trim() : '';
  return raw ? raw.replace(/\/+$/, '') : fallback;
}

/**
 * ws(s):// WebSocket URL → bare http(s) origin (no path/query/hash),
 * without a trailing slash. Returns '' for missing or malformed input.
 * @param {unknown} wsUrl
 * @returns {string}
 */
export function wsUrlToHttpOrigin(wsUrl) {
  if (typeof wsUrl !== 'string' || wsUrl.trim() === '') return '';
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}
