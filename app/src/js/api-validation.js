import { serviceOrigin } from './core/connection-origins.js';
// API Key Validation

let validationTimeout = null;
let apiKeyValidatedState = false;
let onValidationChangeCallback = null;
let edgeUrl = 'https://ropilot.ai/edge';
const API_KEY_VALIDATION_TIMEOUT_MS = 8000;

const PROD_SITE_URL = 'https://ropilot.ai';
const TEST_SITE_URL = 'https://test.ropilot.ai';
const PROD_EDGE_URL = `${PROD_SITE_URL}/edge`;
const TEST_EDGE_URL = `${TEST_SITE_URL}/edge`;

export function setEdgeUrl(url) {
  edgeUrl = url;
}

export function resolveSiteUrlForApiKey(key, fallbackSiteUrl = '') {
  const trimmed = (key || '').trim();
  if (trimmed.startsWith('ropilot_test_')) {
    return serviceOrigin('test');
  }
  if (trimmed.startsWith('ropilot_')) {
    return serviceOrigin('prod');
  }
  return (fallbackSiteUrl || '').trim().replace(/\/$/, '') || PROD_SITE_URL;
}

export function resolveEdgeUrlForApiKey(key, fallbackEdgeUrl = edgeUrl) {
  const trimmed = (key || '').trim();
  if (trimmed.startsWith('ropilot_test_')) {
    return `${serviceOrigin('test')}/edge`;
  }
  if (trimmed.startsWith('ropilot_')) {
    return `${serviceOrigin('prod')}/edge`;
  }
  return (fallbackEdgeUrl || edgeUrl || PROD_EDGE_URL).trim().replace(/\/$/, '');
}

// Check if the current API key is validated
export function isApiKeyValidated() {
  return apiKeyValidatedState;
}

// Set callback for validation state changes
export function onValidationChange(callback) {
  onValidationChangeCallback = callback;
}

// Update validation state and notify
function setValidationState(valid) {
  const changed = apiKeyValidatedState !== valid;
  apiKeyValidatedState = valid;
  if (changed && onValidationChangeCallback) {
    onValidationChangeCallback(valid);
  }
}

export async function validateApiKey(key) {
  if (!key || key.trim() === '') {
    return { valid: true, empty: true };
  }

  console.log('[API Key Validation] Validating key:', key.substring(0, 6) + '...');

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS)
    : null;
  try {
    const validationEdgeUrl = resolveEdgeUrlForApiKey(key);
    const response = await fetch(`${validationEdgeUrl}/settings`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`
      },
      signal: controller?.signal,
    });

    console.log('[API Key Validation] Response status:', response.status);

    if (response.status === 401 || response.status === 403) {
      console.log('[API Key Validation] Invalid key (401/403)');
      return { valid: false, error: 'Invalid Key' };
    }

    if (response.ok) {
      console.log('[API Key Validation] Valid key');
      return { valid: true };
    }

    // Any other non-OK status means invalid
    console.log('[API Key Validation] Invalid key (status:', response.status, ')');
    return { valid: false, error: 'Invalid Key' };
  } catch (err) {
    console.warn('[API Key Validation] Network error:', err);
    return { valid: true, uncertain: true };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function validateApiKeyInput(inputEl, errorElId, { allowUncertain = false } = {}) {
  const key = inputEl.value.trim();
  console.log('[API Key Validation] Input changed:', inputEl.id, 'key length:', key.length);

  if (validationTimeout) {
    clearTimeout(validationTimeout);
  }

  if (!key) {
    clearApiKeyValidation(inputEl.id, errorElId);
    return;
  }

  // Show validating state
  inputEl.classList.remove('input-invalid', 'input-valid');
  inputEl.classList.add('input-validating');
  const errorEl = document.getElementById(errorElId);
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }

  // Debounce validation (500ms after typing stops)
  validationTimeout = setTimeout(async () => {
    console.log('[API Key Validation] Debounce fired, calling validateApiKey');
    const result = await validateApiKey(key);
    console.log('[API Key Validation] Result:', result);

    // Make sure the input still has the same value
    if (inputEl.value.trim() !== key) return;

    inputEl.classList.remove('input-validating');

    if (!result.valid) {
      console.log('[API Key Validation] Marking input as invalid');
      inputEl.classList.add('input-invalid');
      inputEl.classList.remove('input-valid');
      setValidationState(false);
      if (errorEl) {
        errorEl.textContent = result.error || 'Invalid Key';
        errorEl.classList.remove('hidden');
      }
    } else if (!result.empty && !result.uncertain) {
      console.log('[API Key Validation] Marking input as valid');
      inputEl.classList.add('input-valid');
      inputEl.classList.remove('input-invalid');
      setValidationState(true);
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
      }
    } else if (
      result.valid
      && result.uncertain
      && allowUncertain
      && /^ropilot_(?:test_)?[A-Za-z0-9_-]{8,}$/.test(key)
    ) {
      // Match startup behavior: keep the manual fallback usable during a
      // temporary validation outage. Normal authenticated requests will
      // still reject an invalid key once connectivity returns.
      inputEl.classList.add('input-valid');
      inputEl.classList.remove('input-invalid');
      setValidationState(true);
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
      }
    } else if (result.valid && result.uncertain) {
      inputEl.classList.add('input-invalid');
      inputEl.classList.remove('input-valid');
      setValidationState(false);
      if (errorEl) {
        errorEl.textContent = 'Could not validate key. Check your connection and try again.';
        errorEl.classList.remove('hidden');
      }
    } else if (result.empty) {
      setValidationState(false);
    }
  }, 500);
}

export function clearApiKeyValidation(inputId, errorElId) {
  const inputEl = document.getElementById(inputId);
  const errorEl = document.getElementById(errorElId);
  if (inputEl) {
    inputEl.classList.remove('input-invalid', 'input-valid', 'input-validating');
  }
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }
}

// Validate API key at startup (doesn't need input element)
export async function validateApiKeyAtStartup(key) {
  if (!key || key.trim() === '') {
    console.log('[API Key Validation] No key at startup');
    setValidationState(false);
    return false;
  }

  console.log('[API Key Validation] Validating key at startup:', key.substring(0, 6) + '...');
  const result = await validateApiKey(key);

  if (result.valid && !result.empty && !result.uncertain) {
    console.log('[API Key Validation] Startup validation succeeded');
    setValidationState(true);
    return true;
  } else if (!result.valid) {
    console.log('[API Key Validation] Startup validation failed');
    setValidationState(false);
    return false;
  } else {
    // Network error (uncertain) - allow usage but don't confirm validated
    console.log('[API Key Validation] Startup validation uncertain (network error)');
    setValidationState(true);  // Be lenient for offline usage
    return true;
  }
}

export function setupApiKeyValidation() {
  const apiKeyInput = document.getElementById('input-api-key');
  const folderKeyInput = document.getElementById('input-folder-api-key');
  const projectKeyInput = document.getElementById('input-project-api-key');

  if (apiKeyInput) {
    apiKeyInput.addEventListener('input', () => {
      validateApiKeyInput(apiKeyInput, 'api-key-error');
    });
  }

  if (folderKeyInput) {
    folderKeyInput.addEventListener('input', () => {
      validateApiKeyInput(folderKeyInput, 'folder-api-key-error');
    });
  }

  if (projectKeyInput) {
    projectKeyInput.addEventListener('input', () => {
      validateApiKeyInput(projectKeyInput, 'project-api-key-error');
    });
  }
}
