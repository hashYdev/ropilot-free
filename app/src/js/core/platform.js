// @ts-check
// Single seam between the renderer and the Electron preload bridge.
//
// In the Electron app, preload.js exposes window.electronAPI via
// contextBridge; in the web build (Cloudflare Pages) it is undefined and
// every capability behind it is unavailable. Code should go through these
// helpers instead of touching window.electronAPI directly so the
// Electron/web split stays greppable and a web shim could be injected here
// later without touching call sites.
//
// This module wraps the preload contract — it must never reshape it.

/**
 * @returns {boolean} true when running inside the Electron app.
 */
export function isElectron() {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

/**
 * @returns {any|null} the preload bridge, or null in the web build.
 */
export function electronAPI() {
  return (typeof window !== 'undefined' && window.electronAPI) || null;
}

/**
 * Subscribe to a preload event channel (e.g. 'onWindowFocus') when it
 * exists. No-ops in the web build or when the method is missing.
 * @param {string} method - subscription method name on the bridge
 * @param {...any} args - handler(s) or options forwarded to the method
 * @returns {boolean} true when the subscription was made.
 */
export function onElectron(method, ...args) {
  const api = electronAPI();
  if (api && typeof api[method] === 'function') {
    api[method](...args);
    return true;
  }
  return false;
}
