// Setup Flow - handles Claude CLI installation check, auth, and plugin setup onboarding
import {
  validateApiKeyInput,
  clearApiKeyValidation,
  validateApiKeyAtStartup,
  resolveSiteUrlForApiKey,
} from './api-validation.js';
import { installPluginWithGoFallback } from './plugin-install-fallback.js';
import { persistPluginBootstrapKey } from './plugin-bootstrap.js';
import { electronAPI } from './core/platform.js';
import * as storage from './core/storage.js';
import { localApiFetch } from './local-api-auth.js';

const CODEX_UPDATE_TIMEOUT_MS = (8 * 60 * 1000) + (30 * 1000);
const CODEX_UPDATE_STATUS_INTERVAL_MS = 5000;
const ROPILOT_LOGIN_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const ROPILOT_LOGIN_OPEN_TIMEOUT_MS = 15 * 1000;

export class SetupFlow {
  constructor(app) {
    this.app = app;
    this._setupApiKeyBound = false;
    this._providerInstallInProgress = false;
    this._providerInstallError = null;
    this._authPollInterval = null;
    this._advancedInputPollTimer = null;
    this._advancedInputConnected = false;
    this._ropilotLoginPollTimer = null;
    this._ropilotLoginPollTimeoutTimer = null;
    this._ropilotLoginPollGeneration = 0;
    this._ropilotLoginPollInFlightGeneration = null;
    this._ropilotLoginState = null;
    this._ropilotLoginUrl = null;
    this._ropilotLoginPollTimeoutMs = ROPILOT_LOGIN_POLL_TIMEOUT_MS;
    this._ropilotLoginOpenTimeoutMs = ROPILOT_LOGIN_OPEN_TIMEOUT_MS;
    this._ropilotLoginOpenGeneration = 0;
    this._gitBashPollTimer = null;
    this._gitBashAutoRetryInstall = false;
    this._selectedSetupProvider = this._loadStoredSetupProvider();
    this._freeOfferAvailability = null;
    this._freeOfferAvailabilityPromise = null;
    this._lastInstallProgressByProvider = new Map();
    this._installTerminalWaiters = new Map();
    this._progressOnlyCompletionByProvider = new Map();
    this._backgroundCodexInstallPromise = null;
    this._codexUpdateInFlightPromise = null;
    this._codexLegacyUpdateInFlightPromise = null;
    this._postInstallStatusTimeoutMs = 4000;
    this._codexUpdateTimeoutMs = CODEX_UPDATE_TIMEOUT_MS;
    this._freeOfferFetchTimeoutMs = 5000;
    this._freeOfferAccountRefreshTimeoutMs = 3000;
    this._freeOfferClaimSuccessContext = null;

    // Wire up IPC event listeners
    this._bindInstallListeners();
    this._bindInstallProviderPicker();
    this._bindAuthProviderPicker();
  }

  _loadStoredSetupProvider() {
    const stored = storage.getRaw(storage.KEYS.setupProvider);
    return stored ? this.app.normalizeModelProvider(stored) : 'codex';
  }

  _persistSelectedSetupProvider(provider) {
    storage.set(storage.KEYS.setupProvider, provider);
  }

  // =========================================================
  // IPC Event Listeners
  // =========================================================

  _bindInstallListeners() {
    const api = electronAPI();
    if (!api.onClaudeInstallProgress) return;
    api.onClaudeInstallProgress((progress) => {
      this._handleInstallProgress(progress, 'claude');
    });
    api.onCodexInstallProgress?.((progress) => {
      this._handleInstallProgress(progress, 'codex');
    });
  }

  _bindInstallProviderPicker() {
    const claudeBtn = document.getElementById('btn-install-provider-claude');
    const codexBtn = document.getElementById('btn-install-provider-codex');
    if (claudeBtn) {
      claudeBtn.onclick = () => {
        if (this._providerInstallInProgress) return;
        this.showInstallScreen('claude');
      };
    }
    if (codexBtn) {
      codexBtn.onclick = () => {
        if (this._providerInstallInProgress) return;
        this.showInstallScreen('codex');
      };
    }

    const switchAccountBtn = document.getElementById('btn-codex-switch-account-install');
    if (switchAccountBtn) {
      switchAccountBtn.onclick = () => {
        this.switchCodexAccountFromInstall();
      };
    }
  }

  _bindAuthProviderPicker() {
    const claudeBtn = document.getElementById('btn-auth-provider-claude');
    const codexBtn = document.getElementById('btn-auth-provider-codex');

    if (claudeBtn) {
      claudeBtn.onclick = () => {
        this.openProviderLogin('claude');
      };
    }

    if (codexBtn) {
      codexBtn.onclick = () => {
        this.openProviderLogin('codex');
      };
    }

    const switchAccountBtn = document.getElementById('btn-codex-switch-account');
    if (switchAccountBtn) {
      switchAccountBtn.onclick = () => {
        this.switchCodexAccount();
      };
    }
  }

  getSelectedProvider() {
    return this.app.normalizeModelProvider(this._selectedSetupProvider || 'codex');
  }

  setSelectedProvider(provider) {
    this._selectedSetupProvider = this.app.normalizeModelProvider(provider);
    this._persistSelectedSetupProvider(this._selectedSetupProvider);
    return this._selectedSetupProvider;
  }

  getProviderLabel(provider = this.getSelectedProvider()) {
    return provider === 'codex' ? 'ChatGPT Codex' : 'Claude';
  }

  getProviderAssetPath(provider = this.getSelectedProvider()) {
    return provider === 'codex' ? '../assets/codex.png' : '../assets/claude.png';
  }

  markProviderNoticeAcknowledged() {
    storage.set(storage.KEYS.providerAcknowledged, '1');
    storage.set(storage.KEYS.anthropicAcknowledged, '1');
  }

  hasAcknowledgedProviderNotice() {
    this.markProviderNoticeAcknowledged();
    return true;
  }

  _setInstallButtonMode(mode = 'install', provider = this.getSelectedProvider()) {
    const btnText = document.getElementById('btn-install-provider-text');
    const icon = document.getElementById('btn-install-provider-icon');
    if (!btnText || !icon) return;

    if (mode === 'next') {
      btnText.textContent = 'Next';
      icon.innerHTML = `
        <line x1="5" y1="12" x2="19" y2="12"></line>
        <polyline points="12 5 19 12 12 19"></polyline>
      `;
      return;
    }

    if (mode === 'retry') {
      btnText.textContent = 'Retry';
      icon.innerHTML = `
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      `;
      return;
    }

    if (mode === 'installing') {
      btnText.textContent = provider === 'codex' ? 'Installing Codex CLI' : 'Installing Claude Code';
      icon.innerHTML = `
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      `;
      return;
    }

    btnText.textContent = provider === 'codex' ? 'Install Codex CLI' : 'Install Claude Code';
    icon.innerHTML = `
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    `;
  }

  _setInstallButtonLoading(provider = this.getSelectedProvider(), loading = false) {
    const btn = document.getElementById('btn-install-claude');
    const btnText = btn?.querySelector('.btn-text');
    const btnSpinner = btn?.querySelector('.btn-spinner');
    if (!btn) return;

    btn.classList.toggle('is-loading', loading);
    btn.disabled = loading;
    if (loading) {
      btn.setAttribute('aria-busy', 'true');
      btn.setAttribute('aria-label', provider === 'codex' ? 'Installing Codex CLI' : 'Installing Claude Code');
      this._setInstallButtonMode('installing', provider);
    } else {
      btn.removeAttribute('aria-busy');
      btn.removeAttribute('aria-label');
    }
    if (btnText) btnText.classList.toggle('hidden', loading);
    if (btnSpinner) btnSpinner.classList.toggle('hidden', !loading);
  }

  syncAuthScreenUI(provider = this.getSelectedProvider()) {
    const normalized = this.setSelectedProvider(provider);
    const label = document.getElementById('auth-provider-label');
    const subtitle = document.getElementById('auth-provider-subtitle');
    const claudeBtn = document.getElementById('btn-auth-provider-claude');
    const codexBtn = document.getElementById('btn-auth-provider-codex');
    const recheckText = document.getElementById('btn-recheck-auth-text');
    const backLink = document.getElementById('btn-back-to-install-from-auth');
    const status = document.getElementById('auth-recheck-status');
    const headerIcon = document.getElementById('auth-provider-header-icon');
    const headerIconFrame = headerIcon?.closest('.setup-icon-brand');

    if (subtitle) {
      subtitle.textContent = `Sign in to ${this.getProviderLabel(normalized)} to finish provider setup. If its CLI is missing, we'll send you back to install.`;
    }

    if (headerIcon) {
      const isCodex = normalized === 'codex';
      headerIcon.src = this.getProviderAssetPath(normalized);
      headerIcon.alt = isCodex ? 'ChatGPT Codex' : 'Claude';
      headerIcon.classList.toggle('codex', isCodex);
      headerIcon.classList.toggle('claude', !isCodex);
    }
    if (headerIconFrame) {
      headerIconFrame.classList.toggle('codex', normalized === 'codex');
      headerIconFrame.classList.toggle('claude', normalized === 'claude');
    }

    const setActiveState = (button, active) => {
      if (!button) return;
      button.classList.toggle('auth-option-recommended', active);
      button.classList.toggle('hidden', !active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    };

    setActiveState(claudeBtn, normalized === 'claude');
    setActiveState(codexBtn, normalized === 'codex');

    if (label) {
      label.textContent = 'Selected provider';
    }

    if (recheckText) {
      recheckText.textContent = normalized === 'codex'
        ? "I don't have a ChatGPT account"
        : `I've Logged In to ${this.getProviderLabel(normalized)} — Check Again`;
    }

    if (status) {
      status.classList.add('hidden');
      status.textContent = '';
      status.innerHTML = '';
    }
    this._setAuthBusy(false);

    if (backLink) {
      backLink.textContent = 'Need to install or switch providers? Go back';
    }

    this.refreshCodexLinkedAccountRow(normalized);
  }

  // The Codex CLI reuses its cached ChatGPT credentials, so "Log in with
  // ChatGPT Codex" silently re-links the same account. When one is already
  // linked, name it and offer a sign-out path so a different account can
  // be connected.
  async refreshCodexLinkedAccountRow(provider = this.getSelectedProvider()) {
    const row = document.getElementById('codex-linked-account');
    if (!row) return;
    if (provider !== 'codex') {
      row.classList.add('hidden');
      return;
    }

    const requestId = (this._codexLinkedAccountRequestId || 0) + 1;
    this._codexLinkedAccountRequestId = requestId;
    let status = null;
    try {
      status = await this.getGoSetup('/setup/codex-account/status');
    } catch (_) {
      status = null; // Go server unreachable or an old binary — keep the row hidden
    }
    if (this._codexLinkedAccountRequestId !== requestId) return;
    if (this.getSelectedProvider() !== 'codex' || status?.success !== true || status.found !== true) {
      row.classList.add('hidden');
      return;
    }

    this._renderLinkedAccountText(
      document.getElementById('codex-linked-account-text'),
      status.account_email,
      status.account_plan,
    );
    row.classList.remove('hidden');
  }

  // Account values come from auth.json JWT claims — build with DOM nodes,
  // never markup.
  _renderLinkedAccountText(textEl, email, plan) {
    if (!textEl) return;
    const account = String(email || '').trim() || 'ChatGPT account linked';
    const planText = String(plan || '').trim();
    textEl.textContent = '';
    const emailEl = document.createElement('span');
    emailEl.className = 'auth-linked-account-email';
    emailEl.textContent = account;
    textEl.appendChild(emailEl);
    if (planText) {
      textEl.appendChild(document.createTextNode(` · ChatGPT ${planText}`));
    }
  }

  async switchCodexAccount() {
    const statusEl = document.getElementById('auth-recheck-status');
    if (statusEl) {
      statusEl.textContent = 'Signing out of the linked ChatGPT account...';
      statusEl.classList.remove('hidden');
    }
    this._setAuthBusy(true);

    let result;
    try {
      result = await this.postGoSetup('/setup/codex-logout');
    } catch (err) {
      result = { success: false, error: err.message || 'Could not sign out.' };
    }

    if (!result?.success) {
      this._setAuthBusy(false);
      if (statusEl) {
        const endpointMissing = /Request failed \(40[45]\)/.test(String(result?.error || ''));
        statusEl.textContent = endpointMissing
          ? 'Signing out needs an updated Ropilot runtime. Restart the app to update, then try again.'
          : 'Failed to sign out: ' + (result?.error || 'Unknown error');
      }
      return;
    }

    document.getElementById('codex-linked-account')?.classList.add('hidden');
    // Straight into a fresh browser login — the point of signing out is
    // linking a different account.
    await this.openCodexBrowserLogin();
  }

  async getProviderStatus(provider) {
    const api = electronAPI();
    if (provider === 'codex') {
      return api.getCodexCliStatus?.();
    }
    return api.getClaudeCliStatus?.();
  }

  isClaudeActionsProvider(provider = this.getSelectedProvider()) {
    return provider === 'claude'
      && this.app.isUseRopilotCreditsEnabled?.() !== true
      && this.app.useRopilotCredits !== true;
  }

  getClaudeAuthProbePayload() {
    return {
      api_key: this.app.getEffectiveApiKey?.() || this.app.apiKey || '',
      claude_api_proxy_enabled: this.app.isClaudeAPIProxyEnabled?.() !== false,
    };
  }

  async probeClaudeAuthForActionsMode(statusEl = null) {
    if (statusEl) {
      statusEl.textContent = 'Checking Claude login...';
      statusEl.classList.remove('hidden');
    }
    try {
      return await this.postGoSetup('/setup/claude-auth/check', this.getClaudeAuthProbePayload());
    } catch (err) {
      return {
        success: false,
        installed: true,
        authenticated: false,
        error: err?.message || 'Claude login check failed.',
      };
    }
  }

  // True when the auth probe shows the Claude CLI itself is missing or cannot
  // execute (as opposed to merely not being logged in). Conservative: network
  // errors, probe timeouts, and old Go binaries (404) all return false.
  _claudeCliProbeIndicatesBroken(probe) {
    if (!probe || probe.timed_out) return false;
    if (probe.success === true || probe.authenticated === true) return false;
    if (probe.installed === false) return true;
    const text = `${probe.error || ''} ${probe.output || ''}`;
    // NTSTATUS exits (0xC…) mean the CLI binary crashes at launch — corrupted
    // install; "crashing on launch" is the Go server's classified message.
    return /not a valid (win32 )?application|cannot find the (file|path)|file does not exist|no such file or directory|is not recognized as an internal|exec format error|executable file not found|%1 is not|exit status 0xc0[0-9a-f]{5,10}|crashing on launch/i.test(text);
  }

  // Reinstall the managed Claude CLI through the Go server (downloads from
  // the official release bucket, verifies the manifest checksum, swaps the
  // binary, and re-runs `--version`). Falls back to the Electron installer
  // on old Go binaries without the endpoint.
  async reinstallClaudeCliViaGo({ onProgress, timeoutMs } = {}) {
    const requestedTimeoutMs = Number(timeoutMs);
    const deadlineMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : 0;
    const startedAt = Date.now();
    const abortController = typeof AbortController === 'function' ? new AbortController() : null;
    let active = true;
    let timedOut = false;
    let backendProgress = {};
    const reportProgress = () => {
      if (active && typeof onProgress === 'function') {
        onProgress({
          ...backendProgress,
          elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
        });
      }
    };
    reportProgress();
    const progressTimer = setInterval(reportProgress, 1000);

    const timeoutResult = {
      success: false,
      timedOut: true,
      error: 'Claude Code reinstall timed out. The updater stopped waiting; please try again.',
    };
    let timeoutId;
    const deadlinePromise = deadlineMs > 0
      ? new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          abortController?.abort();
          resolve(timeoutResult);
        }, deadlineMs);
      })
      : null;

    const runReinstall = async () => {
      let goResult = null;
      try {
        goResult = await this.postGoSetup(
          '/setup/reinstall-claude',
          undefined,
          {
            signal: abortController?.signal,
            onProgress: (update) => {
              backendProgress = update && typeof update === 'object' ? update : {};
              reportProgress();
            },
          },
        );
      } catch (err) {
        if (timedOut) return timeoutResult;
        goResult = { success: false, error: err?.message || 'Claude Code reinstall failed' };
      }
      if (timedOut) return timeoutResult;
      if (goResult?.success) return goResult;

      if (/Request failed \(40[45]\)/.test(goResult?.error || '')) {
        let shellResult = null;
        try {
          shellResult = await electronAPI().installClaudeCli?.();
        } catch (err) {
          if (timedOut) return timeoutResult;
          shellResult = { success: false, error: err?.message || 'Claude Code reinstall failed' };
        }
        if (timedOut) return timeoutResult;
        if (shellResult?.success) return shellResult;
        return { success: false, error: shellResult?.error || goResult?.error || 'Claude Code reinstall failed' };
      }
      return goResult || { success: false, error: 'Claude Code reinstall failed' };
    };

    try {
      return deadlinePromise
        ? await Promise.race([runReinstall(), deadlinePromise])
        : await runReinstall();
    } finally {
      active = false;
      clearTimeout(timeoutId);
      clearInterval(progressTimer);
    }
  }

  formatClaudeReinstallProgress(update = {}) {
    const elapsed = Math.max(0, Number(update.elapsedSeconds) || 0);
    const downloaded = Math.max(0, Number(update.bytes_downloaded) || 0);
    const total = Math.max(0, Number(update.total_bytes) || 0);
    const formatMB = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

    switch (update.stage) {
      case 'resolving_release':
        return 'Checking the latest Claude Code release...';
      case 'fetching_manifest':
        return `Verifying Claude Code ${update.version || 'release'} metadata...`;
      case 'downloading': {
        if (total > 0) {
          const percent = Math.min(100, Math.floor((downloaded / total) * 100));
          return `Downloading Claude Code... ${formatMB(downloaded)} / ${formatMB(total)} (${percent}%)`;
        }
        if (downloaded > 0) {
          return `Downloading Claude Code... ${formatMB(downloaded)} received`;
        }
        return 'Starting the Claude Code download...';
      }
      case 'retrying_download':
        return `Connection interrupted. Retrying Claude Code download (${update.attempt || 2}/${update.max_attempts || 3})...`;
      case 'installing':
        return 'Download complete. Installing and verifying Claude Code...';
      default:
        return `Downloading and verifying Claude Code... ${elapsed}s elapsed`;
    }
  }

  renderClaudeInstallProgress(update, progressFill, progressText) {
    if (progressText) {
      progressText.textContent = this.formatClaudeReinstallProgress(update);
    }
    if (!progressFill) return;

    let percent = 5;
    if (update?.stage === 'fetching_manifest') percent = 10;
    else if (update?.stage === 'retrying_download') percent = 15;
    else if (update?.stage === 'downloading') {
      const downloaded = Math.max(0, Number(update.bytes_downloaded) || 0);
      const total = Math.max(0, Number(update.total_bytes) || 0);
      percent = total > 0 ? 15 + (downloaded / total) * 80 : 15;
    } else if (update?.stage === 'installing') percent = 97;
    progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }

  // "Claude Code broken or crashing? Reinstall it" on the AI Providers screen.
  async reinstallClaudeCliFromAuthScreen() {
    if (this._claudeReinstallInFlight) return;
    const link = document.getElementById('btn-reinstall-claude');
    const statusEl = document.getElementById('auth-recheck-status');
    this._claudeReinstallInFlight = true;
    if (link) link.textContent = 'Reinstalling Claude Code...';
    if (statusEl) {
      statusEl.textContent = 'Downloading the latest official Claude Code build and verifying it...';
      statusEl.classList.remove('hidden');
    }
    try {
      const result = await this.reinstallClaudeCliViaGo({
        onProgress: (update) => {
          if (statusEl) {
            statusEl.textContent = this.formatClaudeReinstallProgress(update);
          }
        },
      });
      if (statusEl) {
        statusEl.textContent = result?.success
          ? `Claude Code reinstalled and verified${result.version ? ` (${result.version})` : ''}. Sign in with Claude, then check again.`
          : (result?.error || 'Claude Code reinstall failed.');
      }
    } finally {
      this._claudeReinstallInFlight = false;
      if (link) link.textContent = 'Claude Code broken or crashing? Reinstall it';
    }
  }

  async _reinstallClaudeCliInline(statusEl) {
    if (statusEl) {
      statusEl.textContent = 'Claude Code is missing or broken — reinstalling...';
      statusEl.classList.remove('hidden');
    }
    const result = await this.reinstallClaudeCliViaGo({
      onProgress: (update) => {
        if (statusEl) statusEl.textContent = this.formatClaudeReinstallProgress(update);
      },
    });
    if (result?.success) {
      if (statusEl) statusEl.textContent = 'Claude Code reinstalled.';
      return true;
    }
    if (statusEl) {
      statusEl.textContent = 'Could not reinstall Claude Code ('
        + (result?.error || 'unknown error')
        + '). Go back and reinstall it from the provider screen.';
    }
    return false;
  }

  getClaudeAuthProbeError(result) {
    const message = typeof result?.error === 'string' ? result.error.trim() : '';
    if (message) return message;
    if (result?.timed_out) {
      return 'Claude login check timed out. Please sign in again from the AI Providers Screen.';
    }
    return 'Claude login is not valid yet. Please sign in again from the AI Providers Screen.';
  }

  async getVerifiedProviderAuthStatus(provider, cliStatus, statusEl = null) {
    if (!this.isClaudeActionsProvider(provider) || !cliStatus?.installed) {
      return cliStatus;
    }

    const probe = await this.probeClaudeAuthForActionsMode(statusEl);
    return {
      ...cliStatus,
      ...probe,
      installed: probe?.installed !== false,
      authenticated: probe?.authenticated === true,
      authProbe: probe,
    };
  }

  showProviderAuthFailure(provider, authStatus, statusEl = null) {
    const el = statusEl || document.getElementById('auth-recheck-status');
    if (!el) return;
    el.textContent = provider === 'claude'
      ? this.getClaudeAuthProbeError(authStatus?.authProbe || authStatus)
      : (authStatus?.error || 'Not authenticated yet. Please log in first.');
    el.classList.remove('hidden');
  }

  applyInstallScreenCopy(provider) {
    const title = document.getElementById('setup-install-title');
    const subtitle = document.getElementById('setup-install-subtitle');
    const helpLink = document.getElementById('btn-back-to-install-from-auth');

    if (title) title.textContent = 'Choose your AI provider';
    if (provider === 'codex') {
      if (subtitle) subtitle.textContent = 'Codex selected. Install the Codex CLI to continue.';
      if (helpLink) helpLink.textContent = 'Need to reinstall Codex? Go back to install';
    } else {
      if (subtitle) subtitle.textContent = 'Claude selected. Install Claude Code to continue.';
      if (helpLink) helpLink.textContent = 'Need to reinstall Claude? Go back to install';
    }
  }

  hasAdvancedInputPreference() {
    return !!storage.getRaw(storage.KEYS.advancedInputSetupSeen);
  }

  getAdvancedInputPreference() {
    return storage.getRaw(storage.KEYS.advancedInputSetupSeen) || '';
  }

  isAdvancedInputCompleted() {
    const preference = this.getAdvancedInputPreference();
    return preference === 'completed' || preference === 'auto_enabled';
  }

  hasCompletedPluginSetup() {
    return !!storage.getRaw(storage.KEYS.pluginSetupSeen);
  }

  shouldShowPluginSetup() {
    return storage.getRaw(storage.KEYS.onboardingComplete) !== '1' && !this.hasCompletedPluginSetup();
  }

  async routeAfterProviderReady() {
    // Login is the first onboarding step now, so the API key should always be
    // present by the time we get here. If it isn't (state corruption, manual
    // logout, etc.), kick back to the splash rather than dropping the user
    // into a half-configured state.
    if (!this.app.apiKey) {
      this.showLoginSplash();
      return;
    }

    if (this.isFreeOfferOnboardingPending() && this.shouldShowPluginSetup()) {
      this.showPluginSetup();
      return;
    }

    if (this.isFreeOfferOnboardingPending()) {
      this.showFreeOfferClaimSetup();
      return;
    }

    if (this.shouldShowPluginSetup()) {
      this.showPluginSetup();
      return;
    }

    if (!this.hasAdvancedInputPreference()) {
      await this.showAdvancedInputSetup();
      return;
    }

    this.showWelcome();
  }

  async installCodexCliViaShellOrGo() {
    let shellResult = null;
    try {
      shellResult = await electronAPI().installCodexCli();
    } catch (err) {
      shellResult = { success: false, error: err?.message || 'Codex CLI install failed' };
    }
    if (shellResult?.success) return shellResult;

    // The shell installer resolves the release through the unauthenticated
    // GitHub API, which rate-limits by IP (HTTP 403 on shared networks). The
    // Go server's installer falls back to a pinned direct-download release,
    // so retry there before surfacing the failure.
    let goResult = null;
    try {
      goResult = await this.postGoSetup('/setup/install-codex');
    } catch (err) {
      goResult = { success: false, error: err?.message || 'Codex runtime install failed' };
    }
    if (goResult?.success) return goResult;
    if (/Request failed \(40[45]\)/.test(goResult?.error || '')) {
      // Old Go binary without the endpoint — the shell error is the real one.
      return shellResult;
    }
    return {
      success: false,
      error: goResult?.error || shellResult?.error || 'Codex CLI install failed'
    };
  }

  async updateCodexCliViaGoOrShell(options = {}) {
    if (this._codexUpdateInFlightPromise) {
      return this._codexUpdateInFlightPromise;
    }
    if (this._codexLegacyUpdateInFlightPromise) {
      return {
        success: false,
        inProgress: true,
        error: 'The compatibility updater is still running. Restart Ropilot Studio before retrying if it does not finish.',
      };
    }
    const updatePromise = this._runCodexCliUpdateViaGoOrShell(options);
    this._codexUpdateInFlightPromise = updatePromise;
    try {
      return await updatePromise;
    } finally {
      if (this._codexUpdateInFlightPromise === updatePromise) {
        this._codexUpdateInFlightPromise = null;
      }
    }
  }

  async _runCodexCliUpdateViaGoOrShell(options = {}) {
    const requestedTimeoutMs = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : this._codexUpdateTimeoutMs;
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    const startedAt = Date.now();
    const abortController = typeof AbortController === 'function' ? new AbortController() : null;
    let active = true;
    let timedOut = false;
    let compatibilityInProgress = false;
    let phase = 'Downloading and verifying the latest Codex CLI...';

    const emitStatus = (phaseName, message) => {
      if (!active || !onStatus) return;
      try {
        onStatus({
          phase: phaseName,
          message,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          timeoutMs,
        });
      } catch (_) {
        // Status rendering must never interrupt the updater.
      }
    };

    const timeoutResult = {
      success: false,
      timedOut: true,
      error: 'Codex CLI update timed out. The updater stopped waiting; please try again.',
    };

    let timeoutId;
    const deadlinePromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        if (compatibilityInProgress) {
          timeoutResult.error = 'The compatibility updater did not finish in time and may still be running. Restart Ropilot Studio before retrying.';
        }
        emitStatus('timeout', timeoutResult.error);
        abortController?.abort();
        resolve(timeoutResult);
      }, timeoutMs);
    });
    const statusIntervalId = setInterval(() => {
      emitStatus('downloading', phase);
    }, Math.min(CODEX_UPDATE_STATUS_INTERVAL_MS, Math.max(1, timeoutMs)));

    const runUpdate = async () => {
      emitStatus('connecting', 'Contacting the local Codex updater...');
      let goResult = null;
      try {
        goResult = await this.postGoSetup(
          '/setup/install-codex?force=1',
          undefined,
          { signal: abortController?.signal },
        );
      } catch (err) {
        if (timedOut) return timeoutResult;
        goResult = { success: false, error: err?.message || 'Codex runtime update failed' };
      }
      if (timedOut) return timeoutResult;
      if (goResult?.success) {
        emitStatus('verifying', 'Verifying the installed Codex CLI...');
        return goResult;
      }

      const goStatus = Number(goResult?.httpStatus ?? goResult?.status);
      const exactLegacyError = /^Request failed \((404|405)\)$/.test(String(goResult?.error || ''));
      const isMissingGoEndpoint = goStatus === 404 || goStatus === 405 || exactLegacyError;
      if (!isMissingGoEndpoint) {
        emitStatus('error', goResult?.error || 'Codex runtime update failed');
        return goResult || { success: false, error: 'Codex runtime update failed' };
      }

      // Only old Go binaries without the endpoint use the Electron updater.
      // Modern backend failures are authoritative and must not start a second writer.
      phase = 'Using the compatibility updater for this older Ropilot backend...';
      emitStatus('compatibility', phase);
      let shellResult = null;
      compatibilityInProgress = true;
      const legacyUpdatePromise = Promise.resolve().then(() => electronAPI()?.installCodexCli?.());
      this._codexLegacyUpdateInFlightPromise = legacyUpdatePromise;
      try {
        shellResult = await legacyUpdatePromise;
      } catch (err) {
        if (timedOut) return timeoutResult;
        shellResult = { success: false, error: err?.message || 'Codex CLI update failed' };
      } finally {
        compatibilityInProgress = false;
        if (this._codexLegacyUpdateInFlightPromise === legacyUpdatePromise) {
          this._codexLegacyUpdateInFlightPromise = null;
        }
      }
      if (timedOut) return timeoutResult;
      if (shellResult?.success) {
        emitStatus('verifying', 'Verifying the installed Codex CLI...');
        return shellResult;
      }
      return {
        success: false,
        error: shellResult?.error || goResult?.error || 'Codex CLI update failed'
      };
    };

    try {
      return await Promise.race([runUpdate(), deadlinePromise]);
    } finally {
      active = false;
      clearTimeout(timeoutId);
      clearInterval(statusIntervalId);
    }
  }

  startCodexCliBackgroundInstall(source = 'setup') {
    if (this._backgroundCodexInstallPromise) {
      return this._backgroundCodexInstallPromise;
    }
    const api = electronAPI();
    if (!api?.installCodexCli || !api?.getCodexCliStatus) {
      console.warn('[setup] Codex background install is unavailable in this build.');
      return null;
    }

    this._lastInstallProgressByProvider.delete('codex');
    this._backgroundCodexInstallPromise = (async () => {
      try {
        const before = await this._withTimeout(
          this.getProviderStatus('codex'),
          this._postInstallStatusTimeoutMs,
          null,
        );
        if (before?.installed) {
          return { success: true, alreadyInstalled: true, status: before };
        }

        console.log(`[setup] Installing Codex CLI in background (${source})`);
        const result = await this._awaitProviderInstallResult(
          this.installCodexCliViaShellOrGo(),
          'codex',
        );
        if (!result?.success) {
          console.warn('[setup] Background Codex CLI install failed:', result?.error || 'unknown error');
          return result || { success: false, error: 'Unknown Codex CLI install error' };
        }

        const after = await this._withTimeout(
          this.getProviderStatus('codex'),
          this._postInstallStatusTimeoutMs,
          null,
        );
        this.app.refreshModelOptions?.();
        return { ...result, status: after };
      } catch (err) {
        console.warn('[setup] Background Codex CLI install failed:', err?.message || err);
        return { success: false, error: err?.message || 'Background Codex CLI install failed' };
      } finally {
        this._backgroundCodexInstallPromise = null;
      }
    })();

    return this._backgroundCodexInstallPromise;
  }

  getCodexCliBackgroundInstallPromise() {
    return this._backgroundCodexInstallPromise;
  }

  async routeWithFreeOfferSkipChatGptLogin(statusEl = null, options = {}) {
    if (this.getSelectedProvider() !== 'codex') {
      return false;
    }

    let offer = this._freeOfferAvailability;
    if (!offer) {
      try {
        offer = await this.prefetchFreeOfferAvailability();
      } catch {
        return false;
      }
    }

    if (!offer?.can_claim) {
      if (await this.canContinueAfterAlreadyClaimedFreeOffer(offer?.reason, statusEl)) {
        if (options.installCodexInBackground) {
          this.startCodexCliBackgroundInstall('free_offer_already_claimed');
        }
        await this.continueAfterFreeOfferClaimUnavailable(offer.reason, statusEl);
        return true;
      }
      if (this.isFreeOfferAlreadyClaimedReason(offer?.reason)) {
        this.showFreeOfferAlreadyClaimedAuthRequired(offer.reason, statusEl);
      }
      return false;
    }

    if (offer.skip_chatgpt_login !== true) {
      return false;
    }

    this.markFreeOfferOnboardingPending(offer);
    if (options.installCodexInBackground) {
      this.startCodexCliBackgroundInstall('free_offer_skip_chatgpt_login');
    }
    if (statusEl) {
      statusEl.textContent = 'Free starter offer available. Skipping ChatGPT login.';
      statusEl.classList.remove('hidden', 'is-error');
    }
    this._hideAllSetupScreens();
    await this.routeAfterProviderReady();
    return true;
  }

  accountPayloadManagedMode(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const providerMode = typeof payload.ai_provider_mode === 'string'
      ? payload.ai_provider_mode.trim()
      : '';
    const accountCredits = payload.account_credits && typeof payload.account_credits === 'object'
      ? payload.account_credits
      : null;
    const accountBalanceType = typeof accountCredits?.balance_type === 'string'
      ? accountCredits.balance_type.trim()
      : '';
    if (typeof payload.use_managed_ai_credits === 'boolean') {
      return payload.use_managed_ai_credits;
    }
    if (providerMode) {
      if (providerMode === 'managed' || providerMode === 'managed_ai_credits') return true;
      if (providerMode === 'bring_your_own') return false;
    }
    if (accountBalanceType) return accountBalanceType === 'managed_ai_credits';
    return null;
  }

  accountPayloadUsesManagedCredits(payload) {
    return this.accountPayloadManagedMode(payload) === true;
  }

  isManagedCreditsModeEnabled() {
    return this.accountPayloadUsesManagedCredits(this.app.latestAccountBalancePayload);
  }

  hasAuthoritativeBringYourOwnAccountState() {
    return this.accountPayloadManagedMode(this.app.latestAccountBalancePayload) === false;
  }

  hasLocalManagedCreditsContinuationProof() {
    const locallySelected = this.app.useRopilotCredits === true
      || storage.getBool(storage.KEYS.useRopilotCredits);
    if (!locallySelected) return false;

    const completedManagedSetup = storage.getRaw(storage.KEYS.onboardingComplete) === '1'
      || storage.getRaw(storage.KEYS.freeOfferClaimed) === '1'
      || !!storage.getRaw(storage.KEYS.freeOfferClaimUnavailableReason);
    if (!completedManagedSetup) return false;

    const currentBalance = this.app.accountCreditsBalance;
    if (currentBalance?.type && currentBalance.type !== 'managed_ai_credits') {
      return false;
    }

    return true;
  }

  async refreshAuthoritativeManagedCreditsState(options = {}) {
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(0, Number(options.timeoutMs))
      : this._freeOfferAccountRefreshTimeoutMs;
    try {
      await this.app.settings?.loadFromEdge?.({
        timeoutMs,
        refreshManagedCredits: false,
      });
    } catch (err) {
      console.warn('Failed to refresh account state for managed credits setup routing:', err);
    }
    return this.isManagedCreditsModeEnabled();
  }

  async shouldBypassProviderAuthForManagedCredits(provider = this.getSelectedProvider()) {
    if (this.app.normalizeModelProvider(provider) !== 'codex') return false;
    const hadLocalManagedCreditsProof = this.hasLocalManagedCreditsContinuationProof();
    const isManaged = await this.refreshAuthoritativeManagedCreditsState({
      timeoutMs: hadLocalManagedCreditsProof ? 1200 : this._freeOfferAccountRefreshTimeoutMs,
    });
    if (isManaged) return true;
    if (this.hasAuthoritativeBringYourOwnAccountState()) return false;
    return hadLocalManagedCreditsProof;
  }

  shouldCheckFreeOfferBeforeManagedCreditsBypass(provider = this.getSelectedProvider()) {
    return this.app.normalizeModelProvider(provider) === 'codex'
      && storage.getRaw(storage.KEYS.onboardingComplete) !== '1';
  }

  shouldAllowUnavailableProviderShell() {
    return !!this.app.apiKey
      && storage.getRaw(storage.KEYS.onboardingComplete) === '1'
      && !this.isFreeOfferOnboardingPending();
  }

  async _withTimeout(promise, timeoutMs, timeoutValue) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(timeoutValue), Math.max(0, timeoutMs || 0))),
    ]);
  }

  // =========================================================
  // Main Entry Point - checkClaudeInstallation
  // =========================================================

  async checkClaudeInstallation(showProgress = false) {
    const welcomeScreen = document.getElementById('welcome-screen');
    const sidebar = document.getElementById('sidebar');
    const provider = this.getSelectedProvider();

    // The old provider intro screen is no longer a setup step.
    this.markProviderNoticeAcknowledged();

    // Login is the first action in the new onboarding. If we don't have a
    // Ropilot API key yet, show the splash login screen and stop here. The
    // splash's "Log In" button drives `startRopilotLoginSetup`, which on
    // success calls `applySetupApiKey` → `continueAfterApiKeySetup`, and that
    // re-enters this method to continue with provider install/auth.
    if (!this.app.apiKey) {
      this._hideAllSetupScreens();
      this.showLoginSplash();
      return;
    }

    // Use managed binary approach - check selected provider CLI status
    if (electronAPI().getClaudeCliStatus) {
      const status = await this.getProviderStatus(provider);
      console.log(`${provider} CLI managed status:`, status);

      if (status.installed && status.authenticated) {
        const verifiedStatus = await this.getVerifiedProviderAuthStatus(provider, status);
        if (!verifiedStatus.authenticated) {
          this.app.claudeInstalled = false;
          this.app.refreshModelOptions?.();
          this._hideAllSetupScreens();
          this.showAuthOptions(provider);
          this.showProviderAuthFailure(provider, verifiedStatus);
          return verifiedStatus;
        }
        // Fully ready - skip to plugin setup
        this.app.claudeInstalled = true;
        this.app.refreshModelOptions?.();
        this._hideAllSetupScreens();
        this.routeAfterProviderReady();
        return verifiedStatus;
      }

      if (status.installed && !status.authenticated) {
        // Binary exists but not logged in
        this.app.claudeInstalled = false;
        this.app.refreshModelOptions?.();
        let checkedFreeOfferBeforeBypass = false;
        if (this.shouldCheckFreeOfferBeforeManagedCreditsBypass(provider)) {
          checkedFreeOfferBeforeBypass = true;
          if (await this.routeWithFreeOfferSkipChatGptLogin()) {
            return status;
          }
        }
        if (await this.shouldBypassProviderAuthForManagedCredits(provider)) {
          this._hideAllSetupScreens();
          await this.routeAfterProviderReady();
          return status;
        }
        if (this.shouldAllowUnavailableProviderShell()) {
          this._hideAllSetupScreens();
          await this.routeAfterProviderReady();
          return status;
        }
        if (!checkedFreeOfferBeforeBypass && await this.routeWithFreeOfferSkipChatGptLogin()) {
          return status;
        }
        this._hideAllSetupScreens();
        this.showAuthOptions();
        return status;
      }

      // Not installed - show install screen for selected provider, unless
      // managed Ropilot Credits can use hosted AI while the local Codex
      // runtime downloads in the background.
      this.app.claudeInstalled = false;
      this.app.refreshModelOptions?.();
      let checkedFreeOfferBeforeBypass = false;
      if (provider === 'codex') {
        if (this.shouldCheckFreeOfferBeforeManagedCreditsBypass(provider)) {
          checkedFreeOfferBeforeBypass = true;
          if (await this.routeWithFreeOfferSkipChatGptLogin(null, { installCodexInBackground: true })) {
            return status;
          }
        }
        if (await this.shouldBypassProviderAuthForManagedCredits(provider)) {
          this.startCodexCliBackgroundInstall('managed_credits_missing_codex_cli');
          this._hideAllSetupScreens();
          await this.routeAfterProviderReady();
          return status;
        }
      }
      if (this.shouldAllowUnavailableProviderShell()) {
        this._hideAllSetupScreens();
        await this.routeAfterProviderReady();
        return status;
      }
      if (provider === 'codex' && !checkedFreeOfferBeforeBypass && await this.routeWithFreeOfferSkipChatGptLogin(null, { installCodexInBackground: true })) {
        return status;
      }
      this._hideAllSetupScreens();
      this.showInstallScreen(provider);
      return status;
    }

    // Legacy fallback - only used if managed CLI IPC is not available
    return this._legacyCheckClaudeInstallation(showProgress);
  }

  // =========================================================
  // Install Screen
  // =========================================================

  showInstallScreen(provider = this.getSelectedProvider()) {
    const sidebar = document.getElementById('sidebar');
    const selectedProvider = this.setSelectedProvider(provider);
    this._hideAllSetupScreens();
    document.getElementById('setup-install-screen').classList.remove('hidden');
    sidebar.style.opacity = '0.5';
    sidebar.style.pointerEvents = 'none';
    this.applyInstallScreenCopy(selectedProvider);
    this._syncInstallScreenUI(selectedProvider);
    this._updateInstallStepAction(selectedProvider);
  }

  _syncInstallScreenUI(provider = this.getSelectedProvider()) {
    const btn = document.getElementById('btn-install-claude');
    const btnText = btn?.querySelector('.btn-text');
    const btnSpinner = btn?.querySelector('.btn-spinner');
    const providerClaudeBtn = document.getElementById('btn-install-provider-claude');
    const providerCodexBtn = document.getElementById('btn-install-provider-codex');
    const progressBar = document.getElementById('install-progress-bar');
    const progressFill = document.getElementById('install-progress-fill');
    const progressText = document.getElementById('install-progress-text');
    const gitBashNotice = document.getElementById('git-bash-required');
    const checksumNotice = document.getElementById('checksum-mismatch');

    this._setInstallButtonLoading(provider, this._providerInstallInProgress);
    if (providerClaudeBtn) {
      const active = provider === 'claude';
      providerClaudeBtn.classList.toggle('active', active);
      providerClaudeBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (providerCodexBtn) {
      const active = provider === 'codex';
      providerCodexBtn.classList.toggle('active', active);
      providerCodexBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    // If we are not actively installing and there is no visible error state,
    // restore the default install screen UI.
    if (!this._providerInstallInProgress) {
      this._setInstallButtonMode('install', provider);
      const activeError = this._providerInstallError && this._providerInstallError.provider === provider
        ? this._providerInstallError
        : null;
      if (!activeError) {
        if (progressBar) progressBar.classList.add('hidden');
        if (progressFill) progressFill.style.width = '0%';
        if (progressText) {
          progressText.classList.add('hidden');
          progressText.textContent = 'Downloading...';
        }
        if (gitBashNotice) gitBashNotice.classList.add('hidden');
        if (checksumNotice) checksumNotice.classList.add('hidden');
      } else if (activeError.type === 'generic' && progressText) {
        progressBar?.classList.remove('hidden');
        progressText.classList.remove('hidden');
        progressText.textContent = activeError.message || 'Install failed';
      }
    }
  }

  async _updateInstallStepAction(provider = this.getSelectedProvider()) {
    if (this._providerInstallInProgress) return;

    const status = await this.getProviderStatus(provider);
    // Provider may have changed while awaiting IPC.
    if (provider !== this.getSelectedProvider()) return;

    const subtitle = document.getElementById('setup-install-subtitle');
    const gitBashNotice = document.getElementById('git-bash-required');
    this._syncInstallLinkedAccountRow(provider, status);

    if (status?.installed) {
      this._setInstallButtonMode('next', provider);
      if (subtitle) subtitle.textContent = provider === 'codex'
        ? (status.authenticated
          ? 'Codex selected. Already signed in — Next takes you straight in.'
          : 'Codex selected. CLI is installed — continue to sign in.')
        : 'Claude selected. CLI is installed — continue to sign in.';
      if (gitBashNotice) gitBashNotice.classList.add('hidden');
      return;
    }

    this._setInstallButtonMode('install', provider);
    if (subtitle) subtitle.textContent = provider === 'codex'
      ? 'Codex selected. Install the Codex CLI to continue.'
      : 'Claude selected. Install Claude Code to continue.';
  }

  // Codex signs back in with its cached ChatGPT credentials, so an
  // already-authenticated CLI skips the login screen entirely. This row on
  // the provider screen is the only reachable place to unlink the account.
  _syncInstallLinkedAccountRow(provider, status) {
    const row = document.getElementById('install-linked-account');
    if (!row) return;
    const linked = provider === 'codex' && status?.installed === true && status?.authenticated === true;
    if (!linked) {
      row.classList.add('hidden');
      return;
    }
    this._renderLinkedAccountText(
      document.getElementById('install-linked-account-text'),
      status.accountEmail,
      status.accountPlan,
    );
    row.classList.remove('hidden');
  }

  async switchCodexAccountFromInstall() {
    if (this._providerInstallInProgress) return;
    const progressText = document.getElementById('install-progress-text');
    const showProgress = (message) => {
      if (!progressText) return;
      progressText.textContent = message;
      progressText.classList.remove('hidden');
    };
    showProgress('Signing out of the linked ChatGPT account...');

    let result;
    try {
      result = await this.postGoSetup('/setup/codex-logout');
    } catch (err) {
      result = { success: false, error: err.message || 'Could not sign out.' };
    }

    if (!result?.success) {
      const endpointMissing = /Request failed \(40[45]\)/.test(String(result?.error || ''));
      showProgress(endpointMissing
        ? 'Signing out needs an updated Ropilot runtime. Restart the app to update, then try again.'
        : 'Failed to sign out: ' + (result?.error || 'Unknown error'));
      return;
    }

    if (progressText) progressText.classList.add('hidden');
    document.getElementById('install-linked-account')?.classList.add('hidden');
    this.app.claudeInstalled = false;
    this.app.refreshModelOptions?.();
    // Signed out — go straight into a fresh browser sign-in.
    this.showAuthOptions('codex');
    await this.openCodexBrowserLogin();
  }

  async installProviderCli() {
    if (this._providerInstallInProgress) return;
    const provider = this.getSelectedProvider();
    this._providerInstallError = null;
    this._providerInstallInProgress = true;
    this._lastInstallProgressByProvider.delete(provider);

    const btn = document.getElementById('btn-install-claude');
    const btnText = btn.querySelector('.btn-text');
    const btnSpinner = btn.querySelector('.btn-spinner');
    const progressBar = document.getElementById('install-progress-bar');
    const progressFill = document.getElementById('install-progress-fill');
    const progressText = document.getElementById('install-progress-text');

    // Show loading state
    this._setInstallButtonLoading(provider, true);
    progressBar.classList.remove('hidden');
    progressText.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Checking install...';

    let completedSuccessfully = false;
    try {
      const currentStatus = await this._withTimeout(
        this.getProviderStatus(provider),
        this._postInstallStatusTimeoutMs,
        { installed: false, authenticated: false, timedOut: true },
      );
      if (currentStatus?.installed) {
        const verifiedStatus = await this.getVerifiedProviderAuthStatus(provider, currentStatus, progressText);
        await this._continueAfterProviderInstall(provider, !!verifiedStatus.authenticated, progressText, verifiedStatus);
        completedSuccessfully = true;
        return;
      }

      progressText.textContent = 'Downloading...';
      if (provider === 'codex') {
        this.prefetchFreeOfferAvailability().catch(() => undefined);
      }

      if (provider === 'claude') {
        await this._prepareClaudeCodeInstall(progressFill, progressText);
      }
      const installPromise = provider === 'codex'
        ? this.installCodexCliViaShellOrGo()
        : this.reinstallClaudeCliViaGo({
          onProgress: (update) => this.renderClaudeInstallProgress(update, progressFill, progressText),
        });
      const result = await this._awaitProviderInstallResult(installPromise, provider);
      if (result.success) {
        progressFill.style.width = '100%';
        progressText.textContent = 'Installed successfully!';
        const status = await this._withTimeout(
          this.getProviderStatus(provider),
          this._postInstallStatusTimeoutMs,
          { installed: true, authenticated: false, timedOut: true },
        );
        console.log(`Post-install ${provider} CLI status:`, status);
        const verifiedStatus = await this.getVerifiedProviderAuthStatus(provider, status, progressText);
        if (verifiedStatus.authenticated) {
          // Already authenticated (e.g. ~/.claude/.credentials.json exists from global CLI)
          // Skip auth screen and go to plugin setup or welcome
          this.app.claudeInstalled = true;
          this.app.refreshModelOptions?.();
          await this._continueAfterProviderInstall(provider, true, progressText, verifiedStatus);
        } else {
          // Not authenticated - show auth screen
          this.app.refreshModelOptions?.();
          await this._continueAfterProviderInstall(provider, false, progressText, verifiedStatus);
        }
        completedSuccessfully = true;
      } else {
        const error = result.error || 'Unknown error';
        this._handleInstallError(provider, error, { btn, btnText, btnSpinner, progressBar, progressText });
      }
    } catch (err) {
      const msg = err.message || '';
      this._handleInstallError(provider, msg, { btn, btnText, btnSpinner, progressBar, progressText });
    } finally {
      this._providerInstallInProgress = false;
      this._setInstallButtonLoading(provider, false);
      if (!completedSuccessfully) {
        this._syncInstallScreenUI(provider);
        this._updateInstallStepAction(provider);
      }
      this.app.refreshModelOptions?.();
    }
  }

  async _delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

	  async _continueAfterProviderInstall(provider, authenticated, progressText, authStatus = null) {
    await this._delay(800);
    if (provider !== this.getSelectedProvider()) return;

    if (authenticated) {
      this._hideAllSetupScreens();
      await this.routeAfterProviderReady();
      return;
    }

    const skippedAuth = await this._withTimeout(
      this.routeWithFreeOfferSkipChatGptLogin(progressText),
      this._freeOfferFetchTimeoutMs + 500,
      false,
    );
	    if (!skippedAuth) {
	      this.showAuthOptions(provider);
	      if (authStatus) {
	        this.showProviderAuthFailure(provider, authStatus);
	      }
	    }
	  }

  // Backward-compatible alias
  installClaudeCli() {
    return this.installProviderCli();
  }

  async _prepareClaudeCodeInstall(progressFill, progressText) {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + 15 * 60 * 1000;
    let lastError = '';

    while (Date.now() < deadline) {
      const result = await this.postGoSetup('/setup/prepare-claude-code');
      if (result?.ready || result?.success) {
        progressFill.style.width = '15%';
        progressText.textContent = 'Downloading Claude Code...';
        return;
      }

      if (result?.error) {
        lastError = result.error;
        break;
      }

      progressFill.style.width = '12%';
      progressText.textContent = result?.preparing
        ? 'Preparing Claude Code...'
        : 'Starting Claude Code setup...';
      await delay(2500);
    }

    throw new Error(lastError || 'Claude Code setup preparation timed out');
  }

  _handleInstallError(provider, error, { btn, btnText, btnSpinner, progressBar, progressText }) {
    if (provider === 'claude' && error.includes('GIT_BASH_REQUIRED')) {
      this._providerInstallError = {
        provider,
        type: 'generic',
        message: 'Install failed: Claude Code setup preparation did not finish. Please retry.'
      };
      progressBar.classList.remove('hidden');
      progressText.classList.remove('hidden');
      progressText.textContent = this._providerInstallError.message;
    } else if (provider === 'claude' && error.includes('CHECKSUM_MISMATCH')) {
      this._providerInstallError = { provider, type: 'checksum' };
      progressBar.classList.add('hidden');
      progressText.classList.add('hidden');
      this._showChecksumMismatch();
    } else {
      this._providerInstallError = { provider, type: 'generic', message: 'Install failed: ' + error };
      progressBar.classList.remove('hidden');
      progressText.classList.remove('hidden');
      progressText.textContent = 'Install failed: ' + error;
    }
    btnText.classList.remove('hidden');
    btnSpinner.classList.add('hidden');
    btn.disabled = false;
  }

  _setInstallProgress(percent, text) {
    const progressBar = document.getElementById('install-progress-bar');
    const progressFill = document.getElementById('install-progress-fill');
    const progressText = document.getElementById('install-progress-text');
    if (progressBar) progressBar.classList.remove('hidden');
    if (progressText) {
      progressText.classList.remove('hidden');
      progressText.textContent = text;
    }
    if (progressFill && Number.isFinite(percent)) {
      progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
  }

  _showGitBashRequired(options = {}) {
    const container = document.getElementById('git-bash-required');
    if (container) container.classList.add('hidden');
    const downloadLink = document.getElementById('btn-download-gitbash');
    if (downloadLink) downloadLink.classList.add('hidden');
    this._setInstallProgress(8, 'Preparing Claude Code...');
    this._setGitBashRequiredCopy({
      title: 'Preparing Claude Code',
      message: 'Ropilot is preparing Claude Code for this machine.',
      status: 'This can take a minute on a fresh machine.'
    });
    this._setInstallButtonMode('retry');
    this._startGitBashSetupPolling(!!options.autoRetry);
  }

  _setGitBashRequiredCopy({ title, message, status }) {
    const container = document.getElementById('git-bash-required');
    if (container) container.classList.add('hidden');
    const titleEl = document.getElementById('git-bash-required-title');
    const messageEl = document.getElementById('git-bash-required-message');
    const statusEl = document.getElementById('git-bash-required-status');
    if (titleEl && title) titleEl.textContent = title;
    if (messageEl && message) messageEl.textContent = message;
    if (statusEl && status) statusEl.textContent = status;
    this._setInstallProgress(12, status || message || title || 'Preparing Claude Code...');
  }

  _startGitBashSetupPolling(autoRetryInstall = false) {
    this._gitBashAutoRetryInstall = this._gitBashAutoRetryInstall || autoRetryInstall;
    if (this._gitBashPollTimer) return;

    this._pollGitBashSetupStatus();
    this._gitBashPollTimer = setInterval(() => {
      this._pollGitBashSetupStatus();
    }, 2500);
  }

  _stopGitBashSetupPolling() {
    if (this._gitBashPollTimer) {
      clearInterval(this._gitBashPollTimer);
      this._gitBashPollTimer = null;
    }
  }

  async _pollGitBashSetupStatus() {
    if (this.getSelectedProvider() !== 'claude') {
      this._stopGitBashSetupPolling();
      return;
    }

    let result;
    try {
      result = await this.postGoSetup('/setup/ensure-git-bash');
    } catch (err) {
      this._showGitBashManualFallback(err.message || 'Could not start automatic Git install.');
      return;
    }

    if (result?.available || result?.supported === false) {
      this._stopGitBashSetupPolling();
      const notice = document.getElementById('git-bash-required');
      if (notice) notice.classList.add('hidden');
      this._providerInstallError = null;
      const shouldRetry = this._gitBashAutoRetryInstall;
      this._gitBashAutoRetryInstall = false;
      this._syncInstallScreenUI('claude');
      this._updateInstallStepAction('claude');
      if (shouldRetry) {
        setTimeout(() => this.installProviderCli(), 250);
      }
      return;
    }

    if (result?.installing) {
      this._setGitBashRequiredCopy({
        title: 'Preparing Claude Code',
        message: 'Ropilot is preparing Claude Code for this machine.',
        status: result.started_at
          ? 'Downloading and preparing dependencies...'
          : 'Starting setup...'
      });
      return;
    }

    if (result?.error) {
      this._showGitBashManualFallback(result.error);
      return;
    }

    this._setGitBashRequiredCopy({
      title: 'Preparing Claude Code',
      message: 'Ropilot is preparing Claude Code for this machine.',
      status: 'Waiting for the local server to start installation...'
    });
  }

  _showGitBashManualFallback(reason) {
    this._stopGitBashSetupPolling();
    this._gitBashAutoRetryInstall = false;
    this._providerInstallError = { provider: 'claude', type: 'git-bash' };
    this._setGitBashRequiredCopy({
      title: 'Claude Code Setup Failed',
      message: 'Claude Code setup preparation did not finish. Please click Retry.',
      status: reason ? `Setup failed: ${reason}` : 'Setup did not complete.'
    });
    this._setInstallProgress(12, reason ? `Setup failed: ${reason}` : 'Setup did not complete.');
    const downloadLink = document.getElementById('btn-download-gitbash');
    if (downloadLink) downloadLink.classList.add('hidden');
    this._setInstallButtonMode('retry');
  }

  _showChecksumMismatch() {
    const container = document.getElementById('checksum-mismatch');
    if (container) container.classList.remove('hidden');

    const btnContinue = document.getElementById('btn-checksum-continue');
    const btnRetry = document.getElementById('btn-checksum-retry');

    if (btnContinue) {
      btnContinue.onclick = async () => {
        container.classList.add('hidden');
        const api = electronAPI();
        const result = await api.acceptChecksumMismatch();
        if (result.success) {
	          // Proceed same as successful install
	          const status = await api.getClaudeCliStatus();
	          this.app.claudeInstalled = true;
	          const verifiedStatus = await this.getVerifiedProviderAuthStatus('claude', status);
	          if (verifiedStatus.authenticated) {
	            this._hideAllSetupScreens();
	            this.routeAfterProviderReady();
	          } else {
	            this.showAuthOptions('claude');
	            this.showProviderAuthFailure('claude', verifiedStatus);
	          }
        } else {
          const progressText = document.getElementById('install-progress-text');
          if (progressText) {
            progressText.classList.remove('hidden');
            progressText.textContent = 'Failed: ' + (result.error || 'Unknown error');
          }
        }
      };
    }

    if (btnRetry) {
      btnRetry.onclick = () => {
        container.classList.add('hidden');
        this.installProviderCli();
      };
    }
  }

  _awaitProviderInstallResult(installPromise, provider) {
    const terminalProgressPromise = new Promise((resolve) => {
      const settleFromProgress = (progress) => {
        const delayMs = progress.status === 'complete' ? 800 : 0;
        return setTimeout(() => {
          if (progress.status === 'complete') {
            resolve({ success: true, viaProgressEvent: true });
          } else {
            resolve({ success: false, error: progress.message || 'Download failed' });
          }
        }, delayMs);
      };

      const lastProgress = this._lastInstallProgressByProvider.get(provider);
      if (lastProgress?.status === 'complete' || lastProgress?.status === 'error') {
        const timer = settleFromProgress(lastProgress);
        this._installTerminalWaiters.set(provider, () => clearTimeout(timer));
        return;
      }

      this._installTerminalWaiters.set(provider, (progress) => settleFromProgress(progress));
    });

    return Promise.race([installPromise, terminalProgressPromise])
      .finally(() => {
        const waiter = this._installTerminalWaiters.get(provider);
        if (waiter) {
          waiter({ status: 'cancelled' });
          this._installTerminalWaiters.delete(provider);
        }
      });
  }

  _isInstallScreenVisibleForProvider(provider) {
    const installScreen = document.getElementById('setup-install-screen');
    return !!installScreen
      && !installScreen.classList.contains('hidden')
      && provider === this.getSelectedProvider();
  }

  _completeProviderInstallFromProgress(provider, progressText) {
    const existing = this._progressOnlyCompletionByProvider.get(provider);
    if (existing) return existing;

    const completion = (async () => {
      await this._delay(800);
      if (!this._isInstallScreenVisibleForProvider(provider)) return;

      const status = await this._withTimeout(
        this.getProviderStatus(provider),
        this._postInstallStatusTimeoutMs,
        { installed: true, authenticated: false, timedOut: true },
      );
      const verifiedStatus = await this.getVerifiedProviderAuthStatus(provider, status, progressText);
      this.app.refreshModelOptions?.();
      await this._continueAfterProviderInstall(provider, !!verifiedStatus.authenticated, progressText, verifiedStatus);
    })()
      .catch((err) => {
        if (!this._isInstallScreenVisibleForProvider(provider)) return;
        const btn = document.getElementById('btn-install-claude');
        this._handleInstallError(provider, err?.message || 'Install completion failed', {
          btn,
          btnText: btn?.querySelector('.btn-text'),
          btnSpinner: btn?.querySelector('.btn-spinner'),
          progressBar: document.getElementById('install-progress-bar'),
          progressText,
        });
      })
      .finally(() => {
        this._progressOnlyCompletionByProvider.delete(provider);
        this._providerInstallInProgress = false;
        if (this._isInstallScreenVisibleForProvider(provider)) {
          this._setInstallButtonLoading(provider, false);
          this._updateInstallStepAction(provider);
        }
      });

    this._progressOnlyCompletionByProvider.set(provider, completion);
    return completion;
  }

  _handleInstallProgress(progress, provider = null) {
    const ownsVisibleInstallScreen = provider && this._isInstallScreenVisibleForProvider(provider);
    const activeProgressStatuses = new Set(['downloading', 'retrying', 'verifying', 'validating']);
    let consumedByInstallWaiter = false;

    if (provider) {
      this._lastInstallProgressByProvider.set(provider, progress);
      if (progress?.status === 'complete' || progress?.status === 'error') {
        const waiter = this._installTerminalWaiters.get(provider);
        if (waiter) {
          this._installTerminalWaiters.delete(provider);
          waiter(progress);
          consumedByInstallWaiter = true;
        }
      }
    }

    const progressFill = document.getElementById('install-progress-fill');
    const progressText = document.getElementById('install-progress-text');
    if (!progressFill || !progressText) return;

    if (ownsVisibleInstallScreen && activeProgressStatuses.has(progress.status)) {
      this._providerInstallError = null;
      this._providerInstallInProgress = true;
      this._setInstallButtonLoading(provider, true);
      document.getElementById('install-progress-bar')?.classList.remove('hidden');
      progressText.classList.remove('hidden');
    }

    // Keep the current bar position on error/retry events to avoid confusing 0% resets
    if (progress.percent !== undefined && progress.status !== 'error' && progress.status !== 'retrying') {
      progressFill.style.width = progress.percent + '%';
    }

    if (progress.status === 'downloading') {
      progressText.textContent = `Downloading... ${Math.round(progress.percent || 0)}%`;
    } else if (progress.status === 'retrying') {
      const attempt = progress.attempt || '?';
      const maxAttempts = progress.maxAttempts || '?';
      progressText.textContent = `Network issue, retrying (${attempt}/${maxAttempts})...`;
    } else if (progress.status === 'verifying') {
      progressText.textContent = 'Verifying...';
    } else if (progress.status === 'validating') {
      progressText.textContent = 'Validating...';
    } else if (progress.status === 'complete') {
      progressText.textContent = 'Installed successfully!';
      if (ownsVisibleInstallScreen && !consumedByInstallWaiter) {
        this._providerInstallInProgress = true;
        this._setInstallButtonLoading(provider, true);
        this._completeProviderInstallFromProgress(provider, progressText);
      }
    } else if (progress.status === 'error') {
      progressText.textContent = 'Error: ' + (progress.message || 'Download failed');
      if (ownsVisibleInstallScreen && !consumedByInstallWaiter) {
        this._providerInstallInProgress = false;
        const btn = document.getElementById('btn-install-claude');
        this._handleInstallError(provider, progress.message || 'Download failed', {
          btn,
          btnText: btn?.querySelector('.btn-text'),
          btnSpinner: btn?.querySelector('.btn-spinner'),
          progressBar: document.getElementById('install-progress-bar'),
          progressText,
        });
      }
    }
  }

  // =========================================================
  // Auth Options Screen
  // =========================================================

  showAuthOptions(provider = this.getSelectedProvider()) {
    const sidebar = document.getElementById('sidebar');
    const selectedProvider = this.setSelectedProvider(provider);
    this.syncAuthScreenUI(selectedProvider);
    this._hideAllSetupScreens();
    document.getElementById('setup-auth-screen').classList.remove('hidden');
    sidebar.style.opacity = '0.5';
    sidebar.style.pointerEvents = 'none';
  }

  // =========================================================
  // Terminal Login
  // =========================================================

  async openProviderLogin(provider) {
    const selectedProvider = this.setSelectedProvider(provider);
    this.syncAuthScreenUI(selectedProvider);
    const status = await this.getProviderStatus(selectedProvider);
    if (!status?.installed) {
      const statusEl = document.getElementById('auth-recheck-status');
      if (statusEl) {
        statusEl.textContent = `${this.getProviderLabel(selectedProvider)} CLI is not installed yet. Redirecting to install...`;
        statusEl.classList.remove('hidden');
      }
      setTimeout(() => {
        this.showInstallScreen(selectedProvider);
      }, 500);
      return;
    }
    if (selectedProvider === 'codex') {
      await this.openCodexBrowserLogin();
      return;
    }
    await this.openLoginTerminal(selectedProvider);
  }

  async openCodexBrowserLogin() {
    const status = document.getElementById('auth-recheck-status');
    if (status) {
      status.textContent = 'Opening OpenAI sign-in...';
      status.classList.remove('hidden');
    }
    this._setAuthBusy(true);

    let result;
    try {
      result = await this.postGoSetup('/setup/start-codex-login?restart=1');
    } catch (err) {
      result = { success: false, error: err.message || 'Could not start Codex login.' };
    }

    if (!result?.success) {
      this._setAuthBusy(false);
      if (status) {
        status.textContent = 'Failed to open OpenAI sign-in: ' + (result?.error || 'Unknown error');
      }
      return;
    }

    if (status) {
      status.textContent = result.already_running
        ? 'OpenAI sign-in is already open. Complete login in your browser...'
        : 'OpenAI sign-in opened. Complete login in your browser...';
    }
    this._setAuthBusy(true);

    this._startAuthPolling('codex');
  }

  async openLoginTerminal(provider = this.getSelectedProvider(), isRetry = false) {
    const providerLabel = provider === 'codex' ? 'Codex' : 'Claude';
    const status = document.getElementById('auth-recheck-status');
    if (status) {
      status.textContent = 'Opening terminal...';
      status.classList.remove('hidden');
    }
    this._setAuthBusy(true);

    const api = electronAPI();
    const opener = provider === 'codex'
      ? api.openCodexLoginTerminal
      : api.openClaudeLoginTerminal;

    let result = null;
    if (provider !== 'codex') {
      // A stale or corrupted Claude CLI makes the login terminal pop a raw OS
      // error dialog ("Windows cannot find ...") while we sit on "waiting for
      // login" forever. Probe the CLI first — the Go server runs it out of
      // process — and reinstall the managed copy when it cannot execute.
      // Old Go binaries 404 the probe; that result carries no signal and we
      // proceed to the opener as before.
      if (!isRetry) {
        const probe = await this._withTimeout(
          this.probeClaudeAuthForActionsMode(status),
          12000,
          null,
        );
        if (probe && this.isClaudeActionsProvider(provider)
          && probe.success === true && probe.authenticated === true) {
          // Already logged in — no terminal needed.
          this._setAuthBusy(false);
          if (status) status.textContent = 'Claude login detected.';
          this.recheckAuth();
          return;
        }
        if (this._claudeCliProbeIndicatesBroken(probe)) {
          if (!(await this._reinstallClaudeCliInline(status))) {
            this._setAuthBusy(false);
            return;
          }
        }
        if (status) status.textContent = 'Opening terminal...';
      }

      // Prefer the Go server's opener: the shell's macOS launch never passes
      // /login to Terminal (open -a drops --args), so the login flow never
      // starts. Old Go binaries 404 here and we fall back to the shell.
      try {
        result = await this.postGoSetup('/setup/open-claude-login-terminal');
      } catch (err) {
        result = null; // Go server unreachable — use the shell opener
      }
      const endpointMissing = result && result.success !== true
        && /Request failed \(40[45]\)/.test(String(result.error || ''));
      if (endpointMissing) {
        result = null; // old Go binary — fall through to the shell opener
      } else if (result && result.success !== true) {
        if (!isRetry && /not installed/i.test(String(result.error || ''))) {
          if (await this._reinstallClaudeCliInline(status)) {
            return this.openLoginTerminal(provider, true);
          }
          this._setAuthBusy(false);
          return;
        }
        // The Go opener exists and genuinely failed — report it rather than
        // silently degrading to the shell opener (broken on macOS).
        this._setAuthBusy(false);
        if (status) status.textContent = 'Failed to open terminal: ' + (result.error || 'Unknown error');
        return;
      }
    }

    if (!result && !opener) {
      this._setAuthBusy(false);
      if (status) status.textContent = 'Login terminal is unavailable in this build.';
      return;
    }

    if (!result) {
      result = await opener();
    }
    if (!result.success) {
      if (!isRetry && provider !== 'codex' && /not installed/i.test(String(result.error || ''))) {
        if (await this._reinstallClaudeCliInline(status)) {
          return this.openLoginTerminal(provider, true);
        }
      }
      this._setAuthBusy(false);
      if (status) {
        status.textContent = 'Failed to open terminal: ' + (result.error || 'Unknown error');
      }
      return;
    }

    if (status) {
      status.textContent = this.isClaudeActionsProvider(provider)
        ? 'Claude terminal opened. Complete login, then click Check Again.'
        : `${providerLabel} terminal opened. Waiting for login...`;
    }
    if (this.isClaudeActionsProvider(provider)) {
      this._setAuthBusy(false);
      return;
    }
    this._setAuthBusy(true);

    // Poll auth status so the flow can advance as soon as login completes.
    this._startAuthPolling(provider);
  }

  _startAuthPolling(provider) {
    this._stopAuthPolling();
    this._authPollInterval = setInterval(async () => {
      const cliStatus = await this.getProviderStatus(provider);
      if (cliStatus.authenticated) {
        this._stopAuthPolling();
        this.recheckAuth();
        return;
      }

      if (provider === 'codex') {
        const loginStatus = await this.getCodexBrowserLoginStatus();
        if (loginStatus && loginStatus.success === false && !loginStatus.running) {
          const status = document.getElementById('auth-recheck-status');
          if (status) {
            status.textContent = 'OpenAI sign-in did not complete: ' + (loginStatus.error || 'Codex login exited before authentication finished.');
            status.classList.remove('hidden');
          }
          this._setAuthBusy(false);
          this._stopAuthPolling();
        }
      }
    }, 3000);
  }

  async getCodexBrowserLoginStatus() {
    try {
      return await this.getGoSetup('/setup/codex-login/status');
    } catch (_) {
      return null;
    }
  }

  _stopAuthPolling() {
    if (this._authPollInterval) {
      clearInterval(this._authPollInterval);
      this._authPollInterval = null;
    }
  }

  // Toggle the login-in-progress UI: inline spinner next to the status line
  // and a gentle pulse on the selected provider card.
  _setAuthBusy(busy) {
    const spinner = document.getElementById('auth-recheck-spinner');
    if (spinner) spinner.classList.toggle('hidden', !busy);
    const options = document.querySelector('#setup-auth-screen .auth-provider-options');
    if (options) options.classList.toggle('is-logging-in', busy);
  }

  async recheckAuth() {
    const provider = this.getSelectedProvider();
    const status = document.getElementById('auth-recheck-status');
    if (status) {
      status.textContent = 'Checking...';
      status.classList.remove('hidden');
    }
    this._setAuthBusy(true);
    const cliStatus = await this.getProviderStatus(provider);
    if (!cliStatus?.installed) {
      this._setAuthBusy(false);
      this.app.refreshModelOptions?.();
      if (status) {
        status.textContent = `${this.getProviderLabel(provider)} CLI is not installed yet. Redirecting to install...`;
      }
      setTimeout(() => {
        this.showInstallScreen(provider);
      }, 500);
      return;
    }

	    const verifiedStatus = await this.getVerifiedProviderAuthStatus(provider, cliStatus, status);
	    if (verifiedStatus.authenticated) {
	      this._setAuthBusy(false);
	      if (status) status.textContent = 'Authenticated!';
	      this.app.setModelProvider(provider);
	      this.app.claudeInstalled = true;
	      this.app.refreshModelOptions?.();
      setTimeout(() => {
        this._hideAllSetupScreens();
        this.routeAfterProviderReady();
      }, 800);
	    } else {
	      this._setAuthBusy(false);
	      this.app.refreshModelOptions?.();
	      if (status) {
	        let msg = provider === 'claude'
	          ? this.getClaudeAuthProbeError(verifiedStatus.authProbe || verifiedStatus)
	          : (verifiedStatus.error || 'Not authenticated yet. Please log in first.');
	        if (verifiedStatus.testOutput && provider !== 'claude') {
	          msg += `<details style="margin-top: 8px; cursor: pointer;"><summary style="color: #9a9aa0; font-size: 12px;">Show test output</summary><pre style="margin-top: 6px; padding: 8px; background: rgba(0,0,0,0.3); border-radius: 4px; font-size: 11px; white-space: pre-wrap; color: #d4d4d8; max-height: 200px; overflow-y: auto;">${verifiedStatus.testOutput.replace(/</g, '&lt;')}</pre></details>`;
	          status.innerHTML = msg;
	        } else {
	          status.textContent = msg;
	        }
	      }
    }
  }

  showApiKeyAuth() {
    this._hideAllSetupScreens();
    this.showLoginSplash();
  }

  // =========================================================
  // Helper: hide all setup screens
  // =========================================================

  _hideAllSetupScreens({ preserveRopilotLoginPolling = false } = {}) {
    this._stopAuthPolling();
    if (!preserveRopilotLoginPolling) this._stopRopilotLoginPolling();
    this._stopGitBashSetupPolling();
    const ids = [
      'setup-splash-screen',
      'setup-install-screen',
      'setup-auth-screen',
      'setup-screen',        // legacy
      'anthropic-notice-screen',
      'plugin-setup-screen',
      'studio-restart-setup-screen',
      'apikey-setup-screen',
      'advanced-input-setup-screen',
      'free-offer-claim-screen',
      'welcome-screen'
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    }
    document.getElementById('chat-view')?.classList.add('hidden');
    // CSS uses :has(.setup-screen:not(.hidden)) to hide the sidebar at
    // narrow widths during onboarding; mirror that as a body class so the
    // layout still collapses correctly in environments where :has() isn't
    // available yet. The class is set per show* method below.
    document.body.classList.remove('is-onboarding');
  }

  // =========================================================
  // Legacy Fallback (old checkClaude IPC)
  // =========================================================

  async _legacyCheckClaudeInstallation(showProgress = false) {
    const setupScreen = document.getElementById('setup-screen');
    const welcomeScreen = document.getElementById('welcome-screen');
    const sidebar = document.getElementById('sidebar');
    const setupStatus = document.getElementById('setup-status');
    const setupSteps = document.getElementById('setup-steps');
    const checkBtn = document.getElementById('btn-check-again');
    const btnText = checkBtn?.querySelector('.btn-text');
    const btnSpinner = checkBtn?.querySelector('.btn-spinner');

    // Show loading state if requested
    if (showProgress && checkBtn) {
      btnText?.classList.add('hidden');
      btnSpinner?.classList.remove('hidden');
      checkBtn.disabled = true;
      setupStatus?.classList.remove('hidden');
      setupSteps?.classList.add('hidden');

      this.updateStatusIcon('status-claude', 'checking', 'Checking...');
      this.updateStatusIcon('status-auth', 'checking', 'Checking...');
    }

    if (showProgress) {
      await new Promise(r => setTimeout(r, 500));
    }

    const result = await electronAPI().checkClaude();
    console.log('Claude CLI check result (legacy):', result);
    this.app.claudeInstalled = result.ready;

    if (showProgress) {
      if (result.claude.installed) {
        this.updateStatusIcon('status-claude', 'success', result.claude.version);
      } else {
        this.updateStatusIcon('status-claude', 'error', result.claude.error || 'Not found');
      }

      if (result.claude.installed) {
        if (result.claude.authenticated) {
          this.updateStatusIcon('status-auth', 'success', 'Logged in');
        } else {
          this.updateStatusIcon('status-auth', 'error', 'Run step 2');
        }
      } else {
        this.updateStatusIcon('status-auth', 'pending', '-');
      }

      const step1Tick = document.getElementById('step-1-tick');
      if (step1Tick) {
        step1Tick.classList.toggle('hidden', !result.claude.installed);
      }

      await new Promise(r => setTimeout(r, 500));
    }

    // Reset button state
    if (checkBtn) {
      btnText?.classList.remove('hidden');
      btnSpinner?.classList.add('hidden');
      checkBtn.disabled = false;
    }

    if (!this.app.claudeInstalled) {
      setupScreen.classList.remove('hidden');
      welcomeScreen.classList.add('hidden');
      sidebar.style.opacity = '0.5';
      sidebar.style.pointerEvents = 'none';

      if (showProgress) {
        setupStatus?.classList.remove('hidden');
        setupSteps?.classList.remove('hidden');
      }

      const setupTitle = document.getElementById('setup-title');
      const setupSubtitle = document.getElementById('setup-subtitle');
      const setupDebugBtn = document.getElementById('setup-debug-btn');

      if (!result.claude.installed) {
        if (setupTitle) setupTitle.textContent = 'Claude Code Required';
        if (setupSubtitle) {
          setupSubtitle.textContent = result.claude.error || 'Install Claude Code to continue';
        }

        if (result.claude.details && setupDebugBtn) {
          setupDebugBtn.classList.remove('hidden');
          document.getElementById('debug-platform').textContent = result.claude.details.platform || 'unknown';

          const pathsList = document.getElementById('debug-paths');
          pathsList.innerHTML = '';
          if (result.claude.details.pathsChecked) {
            for (const p of result.claude.details.pathsChecked) {
              const li = document.createElement('li');
              li.textContent = p;
              pathsList.appendChild(li);
            }
          }

          const hintEl = document.getElementById('debug-hint');
          if (result.claude.details.hint) {
            hintEl.textContent = result.claude.details.hint;
            hintEl.classList.remove('hidden');
          } else {
            hintEl.classList.add('hidden');
          }
        } else if (setupDebugBtn) {
          setupDebugBtn.classList.add('hidden');
        }
      } else if (setupDebugBtn) {
        setupDebugBtn.classList.add('hidden');
      }
    } else {
      setupScreen.classList.add('hidden');
      this.routeAfterProviderReady();
    }

    return result;
  }

  // =========================================================
  // Existing Onboarding Steps (plugin, Ropilot API key, welcome)
  // =========================================================

  async installPlugin() {
    const btn = document.getElementById('btn-install-plugin-setup');
    const btnText = btn.querySelector('.btn-text');
    const btnSpinner = btn.querySelector('.btn-spinner');
    const subtitle = document.getElementById('plugin-setup-subtitle');

    btnText.classList.add('hidden');
    btnSpinner.classList.remove('hidden');
    btn.disabled = true;

    try {
      await persistPluginBootstrapKey(this.app.apiKey);
      const result = await installPluginWithGoFallback(this.app);

      if (result.success) {
        const mcpResult = await this.enableStudioMCPServerFromSetup();
        storage.set(storage.KEYS.pluginSetupSeen, 'installed');
        if (mcpResult.success) {
          storage.set(storage.KEYS.advancedInputSetupSeen, 'auto_enabled');
          subtitle.innerHTML = '<span style="color: #22c55e;">Plugin installed and Studio input enabled.</span>';
        } else {
          subtitle.innerHTML = `<span style="color: #f59e0b;">Plugin installed.</span> Advanced input setup still needs attention: ${mcpResult.error || mcpResult.status || 'not enabled yet'}.`;
        }
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Installed`;
        btn.disabled = true;
        btn.classList.add('success');

        const alreadyInstalledBtn = document.getElementById('btn-plugin-already-installed');
        if (alreadyInstalledBtn) alreadyInstalledBtn.textContent = 'Next';
        setTimeout(() => this.showStudioRestartSetup(), 700);
      } else {
        subtitle.innerHTML = `<span style="color: #ef4444;">Failed: ${result.error}</span>`;
        btnText.classList.remove('hidden');
        btnSpinner.classList.add('hidden');
        btn.disabled = false;
      }
    } catch (err) {
      subtitle.innerHTML = `<span style="color: #ef4444;">Failed: ${err.message}</span>`;
      btnText.classList.remove('hidden');
      btnSpinner.classList.add('hidden');
      btn.disabled = false;
    }
  }

  async handleAuthAction() {
    if (this.getSelectedProvider() === 'codex') {
      await this.startNoChatGptAccountFlow();
      return;
    }
    await this.recheckAuth();
  }

  isFreeOfferOnboardingPending() {
    // free build: the "claim your free Ropilot Credits" branch is dead — there
    // are no credits to claim and no account to claim them from. Returning
    // false here means onboarding falls through to the provider setup, which
    // is the only thing that actually gets this build working.
    return false;
  }

  markFreeOfferOnboardingPending(offer) {
    this._freeOfferAvailability = offer || this._freeOfferAvailability;
    storage.set(storage.KEYS.freeOfferPending, '1');
    storage.set(storage.KEYS.freeOfferId, offer?.offer_id || 'desktop_no_chatgpt_account_v1');
    storage.set(storage.KEYS.freeOfferCheckedAt, new Date().toISOString());
    if (offer && typeof offer === 'object') {
      storage.setJSON(storage.KEYS.freeOfferPayload, {
        offer_id: offer.offer_id || 'desktop_no_chatgpt_account_v1',
        credits: offer.credits,
        title: offer.title,
        description: offer.description,
      });
    }
  }

  clearFreeOfferOnboardingPending() {
    storage.remove(storage.KEYS.freeOfferPending);
    storage.remove(storage.KEYS.freeOfferId);
    storage.remove(storage.KEYS.freeOfferCheckedAt);
    storage.remove(storage.KEYS.freeOfferPayload);
  }

  getFreeOfferCreditAmount(...sources) {
    const candidates = [];
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      candidates.push(
        source.credits_granted,
        source.granted_credits,
        source.credits,
        source.account_credits?.credits_granted,
      );
    }
    const stored = this.getStoredFreeOfferAvailability();
    if (stored) candidates.push(stored.credits);
    if (this._freeOfferAvailability) candidates.push(this._freeOfferAvailability.credits);

    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }

  getStoredFreeOfferAvailability() {
    const raw = storage.getRaw(storage.KEYS.freeOfferPayload);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  getOfferApiBase() {
    const key = this.app.getEffectiveApiKey?.() || this.app.apiKey || '';
    return resolveSiteUrlForApiKey(key, this.app.config?.siteUrl).replace(/\/+$/, '');
  }

  async fetchFreeOfferAvailability() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._freeOfferFetchTimeoutMs);
    try {
      const response = await fetch(`${this.getOfferApiBase()}/api/ropilot-credit-free-offer`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Offer check failed (${response.status})`);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  prefetchFreeOfferAvailability() {
    if (!this._freeOfferAvailabilityPromise) {
      this._freeOfferAvailabilityPromise = this.fetchFreeOfferAvailability()
        .then((offer) => {
          this._freeOfferAvailability = offer;
          return offer;
        })
        .finally(() => {
          this._freeOfferAvailabilityPromise = null;
        });
    }
    return this._freeOfferAvailabilityPromise;
  }

  async startNoChatGptAccountFlow() {
    // free build: this branch existed to claim a starter bundle of Ropilot
    // Credits against a Ropilot account, over GET /api/ropilot-credit-free-offer.
    // There is no offer to fetch and nothing to claim, so it names the thing that
    // actually makes this build run instead of leaving the user on a status line
    // that never resolves.
    const status = document.getElementById('auth-recheck-status');
    if (status) {
      status.textContent =
        'This build runs on your own account. Install the Claude Code or Codex CLI, '
        + 'sign in there, then come back and pick that provider.';
      status.classList.remove('hidden');
      status.classList.add('is-error');
    }
  }

	  showPluginSetup() {
	    const sidebar = document.getElementById('sidebar');
	    this._hideAllSetupScreens();
	    const title = document.getElementById('plugin-setup-title');
	    if (title) {
	      title.textContent = 'Install the Studio plugin';
	    }
	    document.getElementById('plugin-setup-screen')?.classList.remove('hidden');
	    document.getElementById('chat-view')?.classList.add('hidden');
	    document.getElementById('welcome-screen')?.classList.add('hidden');
	    sidebar.style.opacity = '0.5';
	    sidebar.style.pointerEvents = 'none';
	  }

	  async confirmPluginAlreadyInstalled() {
	    const alreadyInstalledBtn = document.getElementById('btn-plugin-already-installed');
	    const subtitle = document.getElementById('plugin-setup-subtitle');
	    if (alreadyInstalledBtn) {
	      alreadyInstalledBtn.style.pointerEvents = 'none';
	      alreadyInstalledBtn.textContent = 'Checking setup...';
	    }

	    const mcpResult = await this.enableStudioMCPServerFromSetup();
	    storage.set(storage.KEYS.pluginSetupSeen, 'already_installed');
	    if (mcpResult.success) {
	      storage.set(storage.KEYS.advancedInputSetupSeen, 'auto_enabled');
	      if (subtitle) subtitle.innerHTML = '<span style="color: #22c55e;">Studio input enabled.</span>';
	    } else if (subtitle) {
	      subtitle.innerHTML = `<span style="color: #f59e0b;">Continuing with existing plugin.</span> Advanced input setup still needs attention: ${mcpResult.error || mcpResult.status || 'not enabled yet'}.`;
	    }

	    this.showStudioRestartSetup();
	  }

	  async getGoHttpBase() {
	    const wsUrl = this.app.wsUrl || await electronAPI().getWsUrl?.();
	    return wsUrl
	      ? wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/ws$/, '')
	      : 'http://localhost:8765';
	  }

		  async postGoSetup(path, body = undefined, requestOptions = {}) {
		    const httpBase = await this.getGoHttpBase();
		    const headers = {};
		    const options = {
		      method: 'POST',
		      cache: 'no-store'
		    };
		    if (requestOptions.signal) {
		      options.signal = requestOptions.signal;
		    }
		    if (typeof requestOptions.onProgress === 'function') {
		      headers.Accept = 'text/event-stream';
		    }
		    if (body !== undefined) {
		      headers['Content-Type'] = 'application/json';
		      options.body = JSON.stringify(body);
		    }
		    if (Object.keys(headers).length > 0) {
		      options.headers = headers;
		    }
		    const response = await localApiFetch(`${httpBase}${path}`, options);
		    const contentType = response.headers?.get?.('content-type') || '';
		    if (contentType.toLowerCase().includes('text/event-stream')) {
		      return this.readGoSetupEventStream(response, requestOptions.onProgress);
		    }
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
	        httpStatus: response.status,
	        error: payload.error || `Request failed (${response.status})`
	      };
	    }
		    return payload;
		  }

		  async readGoSetupEventStream(response, onProgress) {
		    if (!response.body?.getReader) {
		      return { success: false, error: 'Claude Code reinstall started, but the local server did not provide a readable progress stream.' };
		    }

		    const reader = response.body.getReader();
		    const decoder = new TextDecoder();
		    let buffer = '';
		    let terminalResult = null;
		    const handleEvent = (eventType, data) => {
		      if (!data) return;
		      let payload = null;
		      try {
		        payload = JSON.parse(data);
		      } catch (_) {
		        payload = null;
		      }
		      if (eventType === 'progress') {
		        if (payload && typeof onProgress === 'function') onProgress(payload);
		        return;
		      }
		      if (eventType === 'result') {
		        terminalResult = payload && typeof payload === 'object'
		          ? payload
		          : { success: false, error: data };
		        return;
		      }
		      if (eventType === 'error') {
		        terminalResult = {
		          success: false,
		          error: payload?.error || data || 'Claude Code reinstall failed.',
		        };
		      }
		    };
		    const consumeEvents = (flush = false) => {
		      while (true) {
		        const boundary = buffer.indexOf('\n\n');
		        if (boundary === -1) break;
		        const rawEvent = buffer.slice(0, boundary);
		        buffer = buffer.slice(boundary + 2);
		        if (!rawEvent.trim()) continue;
		        let eventType = 'message';
		        const dataLines = [];
		        for (const line of rawEvent.split('\n')) {
		          if (line.startsWith('event:')) eventType = line.slice(6).trim();
		          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
		        }
		        handleEvent(eventType, dataLines.join('\n'));
		      }
		      if (flush && buffer.trim()) {
		        let eventType = 'message';
		        const dataLines = [];
		        for (const line of buffer.split('\n')) {
		          if (line.startsWith('event:')) eventType = line.slice(6).trim();
		          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
		        }
		        handleEvent(eventType, dataLines.join('\n'));
		        buffer = '';
		      }
		    };

		    while (true) {
		      const { done, value } = await reader.read();
		      if (done) break;
		      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
		      consumeEvents();
		    }
		    buffer += decoder.decode();
		    consumeEvents(true);

		    if (terminalResult) return terminalResult;
		    return {
		      success: false,
		      error: 'The local server connection closed before the Claude Code reinstall finished. Please try again.',
		    };
		  }

	  async getGoSetup(path) {
	    const httpBase = await this.getGoHttpBase();
	    const response = await localApiFetch(`${httpBase}${path}`, {
	      method: 'GET',
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

	  async enableStudioMCPServerFromSetup() {
	    try {
	      return await this.postGoSetup('/setup/enable-studio-mcp');
	    } catch (err) {
	      return { success: false, error: err.message || 'Failed to enable Studio input setting' };
	    }
	  }

	  async getStudioMCPServerStatusFromSetup() {
	    try {
	      return await this.getGoSetup('/setup/studio-mcp/status');
	    } catch (err) {
	      return { success: false, error: err.message || 'Failed to read Studio input setting' };
	    }
	  }

	  getRuntimePlatform() {
	    return electronAPI()?.getPlatform?.() || '';
	  }

	  showStudioRestartSetup() {
	    const sidebar = document.getElementById('sidebar');
	    this._hideAllSetupScreens();
	    document.getElementById('studio-restart-setup-screen')?.classList.remove('hidden');
	    document.getElementById('chat-view')?.classList.add('hidden');
	    document.getElementById('welcome-screen')?.classList.add('hidden');
	    sidebar.style.opacity = '0.5';
	    sidebar.style.pointerEvents = 'none';

	    const closeBtn = document.getElementById('btn-close-roblox-studio-setup');
	    const continueBtn = document.getElementById('btn-continue-studio-restart-setup');
	    const skipBtn = document.getElementById('btn-skip-studio-restart-setup');
	    const messageText = document.getElementById('studio-restart-setup-message');
	    const statusText = document.getElementById('studio-restart-setup-status');
	    const isMac = this.getRuntimePlatform() === 'darwin';
	    if (closeBtn && !this._studioRestartBound) {
	      this._studioRestartBound = true;
	      closeBtn.addEventListener('click', () => this.closeRobloxStudioFromSetup());
	    }
	    if (skipBtn && !this._studioRestartSkipBound) {
	      this._studioRestartSkipBound = true;
	      skipBtn.addEventListener('click', (e) => {
	        e.preventDefault();
	        this.continueAfterStudioRestartSetup();
	      });
	    }
	    if (continueBtn && !this._studioRestartContinueBound) {
	      this._studioRestartContinueBound = true;
	      continueBtn.addEventListener('click', () => this.continueAfterStudioRestartSetup());
	    }
	    if (messageText) {
	      messageText.textContent = isMac
	        ? 'Please restart Roblox Studio to load the Ropilot plugin.'
	        : 'Restart Roblox Studio so the Ropilot plugin, the advanced input setting and Blender model uploads load cleanly.';
	    }
	    if (closeBtn) {
	      closeBtn.classList.toggle('hidden', isMac);
	      closeBtn.disabled = isMac ? true : false;
	    }
	    if (continueBtn) {
	      continueBtn.classList.toggle('hidden', !isMac);
	      continueBtn.disabled = false;
	    }
	    if (skipBtn) {
	      skipBtn.classList.toggle('hidden', isMac);
	      skipBtn.textContent = "I'll do it later";
	    }
	    if (statusText) {
	      statusText.textContent = isMac
	        ? 'Close Roblox Studio and open it again, then continue.'
	        : 'Ropilot can close Roblox Studio for you.';
	    }
	  }

	  async closeRobloxStudioFromSetup() {
	    const closeBtn = document.getElementById('btn-close-roblox-studio-setup');
	    const statusText = document.getElementById('studio-restart-setup-status');
	    if (closeBtn) closeBtn.disabled = true;
	    if (statusText) statusText.textContent = 'Closing Roblox Studio...';
	    try {
	      const result = await this.postGoSetup('/setup/close-roblox-studio');
	      if (result.success || result.not_running) {
	        if (statusText) {
	          statusText.textContent = result.not_running
	            ? 'Roblox Studio is already closed.'
	            : 'Roblox Studio close request sent.';
	        }
	        setTimeout(() => {
	          this.continueAfterStudioRestartSetup();
	        }, 700);
	        return;
	      }
	      if (statusText) statusText.textContent = result.error || 'Could not close Roblox Studio. You can close it manually.';
	    } catch (err) {
	      if (statusText) statusText.textContent = err.message || 'Could not close Roblox Studio. You can close it manually.';
	    }
	    if (closeBtn) closeBtn.disabled = false;
	  }

	  async continueAfterStudioRestartSetup() {
	    storage.set(storage.KEYS.studioRestartPromptSeen, '1');
	    document.getElementById('studio-restart-setup-screen')?.classList.add('hidden');
      if (this.isFreeOfferOnboardingPending()) {
        if (this.app.apiKey) {
          this.showFreeOfferClaimSetup();
        } else {
          this.showApiKeySetup();
        }
        return;
      }
	    if (!this.hasAdvancedInputPreference()) {
	      await this.showAdvancedInputSetup();
	    } else {
	      this.showWelcome();
	    }
	  }

	  showAnthropicNotice() {
    const sidebar = document.getElementById('sidebar');
    document.getElementById('anthropic-notice-screen').classList.remove('hidden');
    document.getElementById('chat-view').classList.add('hidden');
    document.getElementById('welcome-screen').classList.add('hidden');
    sidebar.style.opacity = '0.5';
    sidebar.style.pointerEvents = 'none';
  }

  acknowledgeAnthropicNotice() {
    storage.set(storage.KEYS.providerAcknowledged, '1');
    storage.set(storage.KEYS.anthropicAcknowledged, '1');
    document.getElementById('anthropic-notice-screen').classList.add('hidden');
    this.checkClaudeInstallation();
  }

  // =========================================================
  // Login Splash (first onboarding screen — Cursor-style sparse layout)
  // =========================================================

  showLoginSplash() {
    const sidebar = document.getElementById('sidebar');
    const screen = document.getElementById('setup-splash-screen');
    if (!screen) {
      // Fall back to the existing Ropilot login form if the splash markup
      // is missing for any reason.
      this.showApiKeySetup();
      return;
    }
    this._hideAllSetupScreens();
    screen.classList.remove('hidden');
    document.getElementById('chat-view')?.classList.add('hidden');
    document.getElementById('welcome-screen')?.classList.add('hidden');
    if (sidebar) {
      sidebar.style.opacity = '0.5';
      sidebar.style.pointerEvents = 'none';
    }
    document.body.classList.add('is-onboarding');

    // Reset splash UI to its default idle state.
    const btn = document.getElementById('btn-splash-login');
    const btnText = btn?.querySelector('.btn-text');
    const btnSpinner = btn?.querySelector('.btn-spinner');
    if (btn) btn.disabled = false;
    btnText?.classList.remove('hidden');
    btnSpinner?.classList.add('hidden');
    const status = document.getElementById('splash-status');
    if (status) {
      status.textContent = '';
      status.classList.add('hidden');
      status.classList.remove('is-error');
    }

    if (!this._splashBound) {
      this._splashBound = true;
      btn?.addEventListener('click', () => this.startRopilotLoginSetup());
      document.getElementById('btn-splash-use-key')?.addEventListener('click', (e) => {
        e.preventDefault();
        this.showApiKeySetup();
      });
    }
  }

  showApiKeySetup() {
    const sidebar = document.getElementById('sidebar');
    const hasPendingBrowserLogin = !!(this._ropilotLoginState && this._ropilotLoginUrl);
    this._hideAllSetupScreens({ preserveRopilotLoginPolling: hasPendingBrowserLogin });
    document.getElementById('apikey-setup-screen').classList.remove('hidden');
    document.getElementById('chat-view').classList.add('hidden');
    document.getElementById('welcome-screen').classList.add('hidden');
    sidebar.style.opacity = '0.5';
    sidebar.style.pointerEvents = 'none';

    if (this._ropilotLoginState && this._ropilotLoginUrl) {
      const siteUrl = (this.app.config?.siteUrl || 'https://ropilot.ai').replace(/\/+$/, '');
      this._setRopilotLoginButtonsLoading(false);
      this._setRopilotLoginButtonText('Open browser again');
      this._setRopilotLoginStatus('Waiting for the browser to connect your account...', false);
      this._startRopilotLoginPolling(this._ropilotLoginState, siteUrl);
    } else {
      this._setRopilotLoginButtonsLoading(false);
      this._setRopilotLoginButtonText('Login with Ropilot');
      this._setRopilotLoginStatus('', false);
    }

    if (!this._setupApiKeyBound) {
      this._setupApiKeyBound = true;
      const input = document.getElementById('input-setup-api-key');
      const saveBtn = document.getElementById('btn-save-setup-api-key');
      const loginBtn = document.getElementById('btn-login-ropilot-setup');

      const observer = new MutationObserver(() => {
        saveBtn.disabled = !input.classList.contains('input-valid');
      });
      observer.observe(input, { attributes: true, attributeFilter: ['class'] });

      input.addEventListener('input', () => {
        validateApiKeyInput(input, 'setup-api-key-error', { allowUncertain: true });
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !saveBtn.disabled) {
          e.preventDefault();
          this.saveSetupApiKey();
        }
      });

      loginBtn?.addEventListener('click', () => {
        this.startRopilotLoginSetup();
      });
    }
  }

  async applySetupApiKey(key) {
    key = typeof key === 'string' ? key.trim() : '';
    if (!key) return;

    this.app.apiKey = key;
    storage.set(storage.KEYS.apiKey, key);
    persistPluginBootstrapKey(key).catch((err) => {
      console.warn('[plugin-bootstrap] Failed to persist onboarding key:', err);
    });

    const settingsInput = document.getElementById('input-api-key');
    if (settingsInput) settingsInput.value = key;

    validateApiKeyAtStartup(key);
    this.app.chatSync?.handleApiKeyChange();
    this.app.settings.loadFromEdge();

    await this.continueAfterApiKeySetup();
  }

  saveSetupApiKey() {
    const input = document.getElementById('input-setup-api-key');
    const key = input.value.trim();
    this.applySetupApiKey(key);
  }

  _collectRopilotLoginButtons() {
    // The browser-login flow can be triggered from the splash or the
    // legacy form — return both so we can keep their UI in sync.
    return ['btn-login-ropilot-setup', 'btn-splash-login']
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((btn) => ({
        btn,
        text: btn.querySelector('.btn-text'),
        spinner: btn.querySelector('.btn-spinner'),
      }));
  }

  _setRopilotLoginButtonsLoading(loading) {
    for (const { btn, text, spinner } of this._collectRopilotLoginButtons()) {
      btn.disabled = !!loading;
      text?.classList.toggle('hidden', !!loading);
      spinner?.classList.toggle('hidden', !loading);
    }
  }

  _setRopilotLoginButtonText(label) {
    for (const { text } of this._collectRopilotLoginButtons()) {
      if (text) text.textContent = label;
    }
  }

  async startRopilotLoginSetup() {
    if (!this._ropilotLoginState || !this._ropilotLoginUrl) {
      this._stopRopilotLoginPolling();
      this._ropilotLoginState = this._createRopilotLoginState();
      const siteUrl = (this.app.config?.siteUrl || 'https://ropilot.ai').replace(/\/+$/, '');
      const loginUrl = new URL('/desktop-login', siteUrl);
      loginUrl.searchParams.set('state', this._ropilotLoginState);
      this._ropilotLoginUrl = loginUrl.toString();
    }
    const loginState = this._ropilotLoginState;
    const loginUrl = this._ropilotLoginUrl;
    const openGeneration = ++this._ropilotLoginOpenGeneration;

    this._setRopilotLoginButtonsLoading(true);
    this._setRopilotLoginStatus('Opening browser login...', false);

    try {
      const siteUrl = (this.app.config?.siteUrl || 'https://ropilot.ai').replace(/\/+$/, '');
      const api = electronAPI();
      if (!api?.openExternal) {
        throw new Error('Browser login is unavailable in this build.');
      }
      await this._openRopilotLoginExternal(api, loginUrl);
      if (
        openGeneration !== this._ropilotLoginOpenGeneration
        || loginState !== this._ropilotLoginState
        || loginUrl !== this._ropilotLoginUrl
      ) return;
      this._setRopilotLoginButtonsLoading(false);
      this._setRopilotLoginButtonText('Open browser again');
      this._setRopilotLoginStatus('Waiting for the browser to connect your account...', false);
      this._startRopilotLoginPolling(loginState, siteUrl);
    } catch (err) {
      if (
        openGeneration !== this._ropilotLoginOpenGeneration
        || loginState !== this._ropilotLoginState
        || loginUrl !== this._ropilotLoginUrl
      ) return;
      this._setRopilotLoginStatus(err.message || 'Could not open Ropilot login.', true);
      this._setRopilotLoginButtonsLoading(false);
      this._setRopilotLoginButtonText('Try browser login again');
    }
  }

  async _openRopilotLoginExternal(api, loginUrl) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('Browser login did not open. Try again or paste an API key below.'));
      }, this._ropilotLoginOpenTimeoutMs);
    });
    try {
      await Promise.race([api.openExternal(loginUrl), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  _createRopilotLoginState() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  _setRopilotLoginStatus(message, isError = false) {
    // The login flow can be driven from either the splash screen or the
    // legacy "Sign in to Ropilot" form. Mirror status to whichever element
    // is present so both surfaces stay in sync.
    const targets = [
      document.getElementById('setup-login-status'),
      document.getElementById('splash-status'),
    ];
    for (const el of targets) {
      if (!el) continue;
      el.textContent = message || '';
      el.classList.toggle('is-error', !!isError);
      // The form variant uses inline color; the splash uses class-driven styling.
      el.style.color = el.id === 'setup-login-status'
        ? (isError ? '#ef4444' : '#a5b4fc')
        : '';
      el.classList.toggle('hidden', !message);
    }
  }

  _startRopilotLoginPolling(state, siteUrl) {
    const currentGeneration = this._ropilotLoginPollGeneration;
    const canResumeCurrentGeneration = (
      state === this._ropilotLoginState
      && (
        this._ropilotLoginPollTimer
        || this._ropilotLoginPollInFlightGeneration === currentGeneration
      )
    );
    if (canResumeCurrentGeneration) {
      if (!this._ropilotLoginPollTimer) {
        this._ropilotLoginPollTimer = setInterval(() => {
          this._pollRopilotLoginStatus(state, siteUrl, currentGeneration);
        }, 1000);
      }
      this._scheduleRopilotLoginPollTimeout(state, currentGeneration);
      if (this._ropilotLoginPollInFlightGeneration !== currentGeneration) {
        this._pollRopilotLoginStatus(state, siteUrl, currentGeneration);
      }
      return;
    }

    this._stopRopilotLoginPolling();
    const generation = this._ropilotLoginPollGeneration;
    this._ropilotLoginDirectPoll = false;
    this._ropilotLoginPollFailures = 0;
    this._ropilotLoginPollTimer = setInterval(() => {
      this._pollRopilotLoginStatus(state, siteUrl, generation);
    }, 1000);
    this._scheduleRopilotLoginPollTimeout(state, generation);
    this._pollRopilotLoginStatus(state, siteUrl, generation);
  }

  _scheduleRopilotLoginPollTimeout(state, generation) {
    if (this._ropilotLoginPollTimeoutTimer) {
      clearTimeout(this._ropilotLoginPollTimeoutTimer);
    }
    this._ropilotLoginPollTimeoutTimer = setTimeout(() => {
      if (generation !== this._ropilotLoginPollGeneration || state !== this._ropilotLoginState) return;
      // Stop future ticks without invalidating a request already in flight.
      // The site status is one-shot, so that response must still be accepted.
      this._pauseRopilotLoginPolling();
      this._setRopilotLoginButtonsLoading(false);
      this._setRopilotLoginButtonText('Open browser again');
      this._setRopilotLoginStatus(
        'We could not confirm the sign-in. Open the browser again or paste an API key below.',
        true,
      );
    }, this._ropilotLoginPollTimeoutMs);
  }

  _pauseRopilotLoginPolling() {
    if (this._ropilotLoginPollTimer) {
      clearInterval(this._ropilotLoginPollTimer);
      this._ropilotLoginPollTimer = null;
    }
    if (this._ropilotLoginPollTimeoutTimer) {
      clearTimeout(this._ropilotLoginPollTimeoutTimer);
      this._ropilotLoginPollTimeoutTimer = null;
    }
  }

  _stopRopilotLoginPolling() {
    this._ropilotLoginPollGeneration += 1;
    this._pauseRopilotLoginPolling();
  }

  async _pollRopilotLoginStatus(state, siteUrl, generation = this._ropilotLoginPollGeneration) {
    if (
      !state
      || state !== this._ropilotLoginState
      || generation !== this._ropilotLoginPollGeneration
      || this._ropilotLoginPollInFlightGeneration === generation
    ) return;
    this._ropilotLoginPollInFlightGeneration = generation;
    try {
      let response;
      if (this._ropilotLoginDirectPoll && siteUrl) {
        // Old Go binary without /setup/ropilot-login/status — poll the site
        // status endpoint directly (it allows the app origins via CORS).
        const statusUrl = new URL('/api/desktop-login/status', siteUrl);
        statusUrl.searchParams.set('state', state);
        response = await fetch(statusUrl.toString(), {
          method: 'GET',
          cache: 'no-store'
        });
      } else {
        const httpBase = await this.getGoHttpBase();
        const statusUrl = new URL(`${httpBase}/setup/ropilot-login/status`);
        statusUrl.searchParams.set('state', state);
        if (siteUrl) statusUrl.searchParams.set('site_url', siteUrl);
        response = await localApiFetch(statusUrl.toString(), {
          method: 'GET',
          cache: 'no-store'
        });
        if ((response.status === 404 || response.status === 405) && siteUrl) {
          this._ropilotLoginDirectPoll = true;
          const directStatusUrl = new URL('/api/desktop-login/status', siteUrl);
          directStatusUrl.searchParams.set('state', state);
          response = await fetch(directStatusUrl.toString(), {
            method: 'GET',
            cache: 'no-store'
          });
        }
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error('Login status returned an invalid response.');
      }
      if (generation !== this._ropilotLoginPollGeneration || state !== this._ropilotLoginState) return;
      if (!response.ok) {
        throw new Error(payload.error || `Login status failed (${response.status})`);
      }
      if (payload.status === 'pending') {
        this._ropilotLoginPollFailures = 0;
        return;
      }
      if (payload.status !== 'complete' || !payload.api_key) {
        throw new Error(payload.error || 'Login status returned an unexpected response.');
      }
      this._ropilotLoginPollFailures = 0;

      this._stopRopilotLoginPolling();
      this._setRopilotLoginStatus('Ropilot account connected.', false);
      this._ropilotLoginState = null;
      this._ropilotLoginUrl = null;
      await this.applySetupApiKey(payload.api_key);
    } catch (err) {
      if (generation !== this._ropilotLoginPollGeneration || state !== this._ropilotLoginState) return;
      // Tolerate transient blips — a single failed poll shouldn't kill a
      // login the user is still completing in the browser.
      this._ropilotLoginPollFailures = (this._ropilotLoginPollFailures || 0) + 1;
      if (this._ropilotLoginPollFailures < 8 && this._ropilotLoginPollTimer) return;
      this._stopRopilotLoginPolling();
      this._setRopilotLoginStatus(err.message || 'Could not finish Ropilot login.', true);
      this._setRopilotLoginButtonsLoading(false);
      this._setRopilotLoginButtonText('Try browser login again');
    } finally {
      if (this._ropilotLoginPollInFlightGeneration === generation) {
        this._ropilotLoginPollInFlightGeneration = null;
      }
    }
  }

  async continueAfterApiKeySetup() {
    this._ropilotLoginOpenGeneration += 1;
    this._stopRopilotLoginPolling();
    this._ropilotLoginState = null;
    this._ropilotLoginUrl = null;
    this._hideAllSetupScreens();
    clearApiKeyValidation('input-setup-api-key', 'setup-api-key-error');
    if (!this.app.apiKey) {
      // Shouldn't normally happen — fall back to the splash so the user can retry.
      this.showLoginSplash();
      return;
    }
    if (this.isFreeOfferOnboardingPending()) {
      this.showFreeOfferClaimSetup();
      return;
    }
    // Login is the first step in the new onboarding. Re-enter the provider
    // check so install/auth (or any remaining onboarding step) runs next.
    await this.checkClaudeInstallation();
  }

  async showAdvancedInputSetup() {
    const autoEnabled = await this.tryAutoEnableAdvancedInputSetup();
    if (autoEnabled) {
      this.showWelcome();
      return;
    }

    const sidebar = document.getElementById('sidebar');
    const video = document.getElementById('advanced-input-setup-video');
    const source = video?.querySelector('source');
    const primaryBtn = document.getElementById('btn-complete-advanced-input-setup');
    const primaryText = primaryBtn?.querySelector('.btn-text');
    const statusText = document.getElementById('advanced-input-setup-status');
    const releasesBase = this.app.config?.releasesUrl || `${this.app.config?.siteUrl || 'https://ropilot.ai'}/releases`;
    const videoUrl = `${releasesBase}/AdvancedKeyboardAndMouseInput.mp4`;

    document.getElementById('advanced-input-setup-screen')?.classList.remove('hidden');
    document.getElementById('chat-view')?.classList.add('hidden');
    document.getElementById('welcome-screen')?.classList.add('hidden');
    sidebar.style.opacity = '0.5';
    sidebar.style.pointerEvents = 'none';
    this._advancedInputConnected = false;
    if (primaryBtn) primaryBtn.disabled = true;
    if (primaryText) primaryText.textContent = 'Waiting for connection from Roblox Studio...';
    if (statusText) statusText.textContent = 'Waiting for a connection from Roblox Studio.';

    if (video && source && source.src !== videoUrl) {
      source.src = videoUrl;
      video.load();
    }

    this.startAdvancedInputStatusPolling();
  }

  async tryAutoEnableAdvancedInputSetup() {
    try {
      const status = await this.getStudioMCPServerStatusFromSetup();
      if (status?.success) {
        storage.set(storage.KEYS.advancedInputSetupSeen, 'auto_enabled');
        return true;
      }

      const result = await this.enableStudioMCPServerFromSetup();
      if (result?.success) {
        storage.set(storage.KEYS.advancedInputSetupSeen, 'auto_enabled');
        return true;
      }
    } catch (err) {
      console.warn('[setup] Advanced input auto-enable check failed:', err);
    }
    return false;
  }

  async completeAdvancedInputSetup() {
    if (!this._advancedInputConnected) {
      const ok = await this.refreshAdvancedInputStatus();
      if (!ok) {
        return;
      }
    }

    this.stopAdvancedInputStatusPolling();
    storage.set(storage.KEYS.advancedInputSetupSeen, 'completed');
    document.getElementById('advanced-input-setup-screen')?.classList.add('hidden');
    this.showWelcome();
  }

  skipAdvancedInputSetup() {
    this.stopAdvancedInputStatusPolling();
    storage.set(storage.KEYS.advancedInputSetupSeen, 'skipped');
    document.getElementById('advanced-input-setup-screen')?.classList.add('hidden');
    this.showWelcome();
  }

  showFreeOfferClaimSetup() {
    const sidebar = document.getElementById('sidebar');
    this._hideAllSetupScreens();
    document.getElementById('free-offer-claim-screen')?.classList.remove('hidden');
    document.getElementById('chat-view')?.classList.add('hidden');
    document.getElementById('welcome-screen')?.classList.add('hidden');
    sidebar.style.opacity = '0.5';
    sidebar.style.pointerEvents = 'none';

    const status = document.getElementById('free-offer-claim-status');
    const btn = document.getElementById('btn-claim-free-offer');
    const text = btn?.querySelector('.btn-text');
    const spinner = btn?.querySelector('.btn-spinner');
    this.syncFreeOfferClaimCopy(this._freeOfferAvailability || this.getStoredFreeOfferAvailability());
    this.prefetchFreeOfferAvailability()
      .then((offer) => {
        storage.setJSON(storage.KEYS.freeOfferPayload, {
          offer_id: offer?.offer_id || 'desktop_no_chatgpt_account_v1',
          credits: offer?.credits,
          title: offer?.title,
          description: offer?.description,
        });
        this.syncFreeOfferClaimCopy(offer);
        // The offer is known-unclaimable before the user clicks anything:
        // don't dangle a "Let's go!" that can only fail — arm the sign-in
        // exit immediately (and drop the pending flag so restarts stop
        // routing back into this screen).
        if (offer && offer.can_claim === false && this.isFreeOfferAlreadyClaimedReason(offer.reason)) {
          this.showFreeOfferCodexAuthRequired(offer.reason, status);
        }
      })
      .catch(() => undefined);
    if (status) {
      status.textContent = '';
      status.classList.add('hidden');
      status.classList.remove('is-error');
    }
    if (btn) {
      btn.disabled = false;
      btn.dataset.freeOfferAction = 'claim';
    }
    if (text) {
      text.textContent = "Let's go!";
      text.classList.remove('hidden');
    }
    spinner?.classList.add('hidden');
  }

  syncFreeOfferClaimCopy(offer) {
    const credits = Number.isFinite(Number(offer?.credits)) && Number(offer?.credits) > 0
      ? Number(offer.credits)
      : null;
    const title = document.getElementById('free-offer-claim-title');
    const description = document.getElementById('free-offer-claim-description');
    if (title) {
      title.textContent = offer?.title || (credits
        ? `Start free with ${credits} Ropilot credits, free on us!`
        : 'Start free with Ropilot Credits, free on us!');
    }
    if (description) {
      description.textContent = this.getFreeOfferClaimDescription(credits);
    }
  }

  getFreeOfferClaimDescription(credits) {
    if (credits === null) {
      return 'Try Ropilot Free. Prompt estimates update from the current credit offer.';
    }
    const advancedPrompts = this.formatPromptEstimate(credits * 2);
    const blazePrompts = this.formatPromptEstimate(credits * 5);
    return `Try Ropilot Free. This is roughly ${advancedPrompts} Ropilot Advanced prompts, ${blazePrompts} prompts with Ropilot Blaze.`;
  }

  formatPromptEstimate(value) {
    if (!Number.isFinite(value)) return '0';
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(1).replace(/\.0$/, '');
  }

  isFreeOfferAlreadyClaimedReason(reason) {
    return reason === 'account_already_claimed' || reason === 'ip_already_claimed';
  }

  getFreeOfferAlreadyClaimedAuthRequiredMessage(reason) {
    return reason === 'ip_already_claimed'
      ? 'This free starter offer was already claimed from this network. Please sign in with ChatGPT Codex.'
      : 'This free starter offer was already claimed, but this account is not set to Ropilot Credits yet. Please sign in with ChatGPT Codex.';
  }

  showFreeOfferAlreadyClaimedAuthRequired(reason, status) {
    if (status) {
      status.textContent = this.getFreeOfferAlreadyClaimedAuthRequiredMessage(reason);
      status.classList.remove('hidden');
      status.classList.add('is-error');
    }
    // Every render of this error must carry an exit. Some flows used to set
    // only the status text, leaving the claim CTA on "Let's go!" — a claim
    // that can never succeed, so the user was stuck with no way to sign in.
    this.armFreeOfferCodexAuthButton(reason);
  }

  armFreeOfferCodexAuthButton(reason) {
    const btn = document.getElementById('btn-claim-free-offer');
    if (!btn) return;
    const text = btn.querySelector('.btn-text');
    const spinner = btn.querySelector('.btn-spinner');
    btn.disabled = false;
    btn.dataset.freeOfferAction = 'codex-auth';
    btn.dataset.freeOfferAuthReason = reason || '';
    if (text) {
      text.textContent = 'Sign in with ChatGPT Codex';
      text.classList.remove('hidden');
    }
    spinner?.classList.add('hidden');
  }

  showFreeOfferCodexAuthRequired(reason, status) {
    this.clearFreeOfferOnboardingPending();
    this.showFreeOfferAlreadyClaimedAuthRequired(reason, status);
  }

  async continueFreeOfferToCodexAuth(reason = '') {
    this.clearFreeOfferOnboardingPending();
    const btn = document.getElementById('btn-claim-free-offer');
    const authReason = reason || btn?.dataset.freeOfferAuthReason || '';
    this.showAuthOptions('codex');
    const status = document.getElementById('auth-recheck-status');
    if (status && authReason) {
      status.textContent = this.getFreeOfferAlreadyClaimedAuthRequiredMessage(authReason);
      status.classList.remove('hidden');
      status.classList.add('is-error');
    }
  }

  async canContinueAfterAlreadyClaimedFreeOffer(reason, status) {
    if (reason !== 'account_already_claimed') return false;
    const hadLocalManagedCreditsProof = this.hasLocalManagedCreditsContinuationProof();
    const isManaged = await this.refreshAuthoritativeManagedCreditsState();
    if (isManaged || (hadLocalManagedCreditsProof && !this.hasAuthoritativeBringYourOwnAccountState())) return true;
    this.showFreeOfferAlreadyClaimedAuthRequired(reason, status);
    return false;
  }

  async continueAfterFreeOfferClaimUnavailable(reason, status) {
    if (
      reason !== 'account_already_claimed'
      || (
        !this.isManagedCreditsModeEnabled()
        && !this.hasLocalManagedCreditsContinuationProof()
      )
    ) {
      throw new Error('This free starter offer was already claimed, but this account is not set to Ropilot Credits yet.');
    }
    this.clearFreeOfferOnboardingPending();
    storage.set(storage.KEYS.freeOfferClaimUnavailableReason, reason || 'already_claimed');
    storage.set(storage.KEYS.freeOfferClaimUnavailableAt, new Date().toISOString());

    this.app.activateRopilotCreditsMode?.({ source: 'free_offer_unavailable', syncToEdge: false });
    const balancePayload = await this.refreshManagedCreditsAfterFreeOffer('free_offer_unavailable');
    this.app.activateRopilotCreditsMode?.({ source: 'free_offer_unavailable_defaults', syncToEdge: false });
    this.app.applyRopilotCreditsDefaultModel?.({ updateActiveChat: true });
    this.app.forceAutoPlaytestOffForAiModeToggle?.();
    this.app.refreshReasoningOptions?.();
    Promise.resolve(this.app.refreshModelOptions?.()).catch((err) => {
      console.warn('Failed to refresh models after unavailable free offer:', err);
    });
    this.app.syncComposerDropdown?.('composer-model-control');
    this.app.syncComposerFooterControls?.();

    if (status) {
      status.textContent = 'This account has already used the free starter credits. Continuing with Ropilot Credits setup.';
      status.classList.remove('hidden');
      status.classList.add('is-error');
    }

    this.showFreeOfferClaimSuccess({
      alreadyClaimed: true,
      credits: this.getFreeOfferCreditAmount(this._freeOfferAvailability, balancePayload),
      balancePayload,
      noActionsModalSource: 'free_offer_unavailable',
    });
  }

  async claimFreeOfferAndContinue() {
    const btn = document.getElementById('btn-claim-free-offer');
    const text = btn?.querySelector('.btn-text');
    const spinner = btn?.querySelector('.btn-spinner');
    const status = document.getElementById('free-offer-claim-status');
    if (btn?.dataset.freeOfferAction === 'continue') {
      await this.finishFreeOfferClaimSuccess();
      return;
    }
    if (btn?.dataset.freeOfferAction === 'codex-auth') {
      await this.continueFreeOfferToCodexAuth(btn.dataset.freeOfferAuthReason || '');
      return;
    }
    const apiKey = this.app.getEffectiveApiKey?.() || this.app.apiKey || '';
    if (!apiKey) {
      this.showApiKeySetup();
      return;
    }

    if (btn) btn.disabled = true;
    text?.classList.add('hidden');
    spinner?.classList.remove('hidden');
    // The button now shows its own "Claiming your credits…" label + spinner,
    // so keep the separate status line hidden (reserved for errors).
    if (status) {
      status.textContent = '';
      status.classList.add('hidden');
      status.classList.remove('is-error');
    }

    try {
      const response = await fetch(`${this.getOfferApiBase()}/api/ropilot-credit-free-offer`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.success) {
        const reason = typeof payload?.reason === 'string' ? payload.reason : '';
        if (this.isFreeOfferAlreadyClaimedReason(reason)) {
          if (await this.canContinueAfterAlreadyClaimedFreeOffer(reason, status)) {
            await this.continueAfterFreeOfferClaimUnavailable(reason, status);
            return;
          }
          this.showFreeOfferCodexAuthRequired(reason, status);
          return;
        }
        throw new Error(payload.reason || payload.error || `Offer claim failed (${response.status})`);
      }

      this.clearFreeOfferOnboardingPending();
      storage.set(storage.KEYS.freeOfferClaimed, '1');
      storage.set(storage.KEYS.freeOfferClaimedAt, new Date().toISOString());
      storage.set(storage.KEYS.freeOfferClaimId, payload.claim_id || '');
      this.app.activateRopilotCreditsMode?.({ source: 'free_offer_claim', syncToEdge: false });
      const balancePayload = await this.refreshManagedCreditsAfterFreeOffer('free_offer_claim');
      this.app.activateRopilotCreditsMode?.({ source: 'free_offer_claim_defaults', syncToEdge: false });
      this.app.applyRopilotCreditsDefaultModel?.({ updateActiveChat: true });
      this.app.forceAutoPlaytestOffForAiModeToggle?.();
      this.app.refreshReasoningOptions?.();
      this.app.refreshModelOptions?.().catch((err) => {
        console.warn('Failed to refresh models after free offer defaults:', err);
      });
      this.app.syncComposerDropdown?.('composer-model-control');
      this.app.syncComposerFooterControls?.();
      if (status) {
        status.textContent = '';
        status.classList.add('hidden');
        status.classList.remove('is-error');
      }
      this.showFreeOfferClaimSuccess({
        credits: this.getFreeOfferCreditAmount(payload, balancePayload),
        balancePayload,
      });
    } catch (err) {
      if (status) {
        status.textContent = err.message || 'Could not claim the free starter offer.';
        status.classList.remove('hidden');
        status.classList.add('is-error');
      }
      if (btn) btn.disabled = false;
    } finally {
      text?.classList.remove('hidden');
      spinner?.classList.add('hidden');
    }
  }

  async refreshManagedCreditsAfterFreeOffer(source, onBalance) {
    const task = (async () => {
      const balancePayload = await this.app.settings?.refreshManagedAiCredits?.();
      await this.app.settings?.loadFromEdge?.();
      return balancePayload || null;
    })();

    task
      .then((payload) => {
        if (payload) onBalance?.(payload);
      })
      .catch((err) => {
        console.warn(`Failed to refresh managed credits after ${source}:`, err);
      });

    return this._withTimeout(
      task.catch(() => null),
      this._freeOfferAccountRefreshTimeoutMs,
      null,
    );
  }

  showFreeOfferClaimSuccess(options = {}) {
    const sidebar = document.getElementById('sidebar');
    const screen = document.getElementById('free-offer-claim-screen');
    const title = document.getElementById('free-offer-claim-title');
    const description = document.getElementById('free-offer-claim-description');
    const status = document.getElementById('free-offer-claim-status');
    const btn = document.getElementById('btn-claim-free-offer');
    const text = btn?.querySelector('.btn-text');
    const spinner = btn?.querySelector('.btn-spinner');
    const credits = Number.isFinite(Number(options.credits)) && Number(options.credits) > 0
      ? Number(options.credits)
      : null;

    this._freeOfferClaimSuccessContext = {
      balancePayload: options.balancePayload || null,
      noActionsModalSource: options.noActionsModalSource || null,
    };

    this._hideAllSetupScreens();
    screen?.classList.remove('hidden');
    document.getElementById('chat-view')?.classList.add('hidden');
    document.getElementById('welcome-screen')?.classList.add('hidden');
    if (sidebar) {
      sidebar.style.opacity = '0.5';
      sidebar.style.pointerEvents = 'none';
    }

    if (title) {
      if (options.alreadyClaimed) {
        title.textContent = credits
          ? `Your ${credits} Ropilot Credits are ready`
          : 'Your Ropilot Credits are ready';
      } else {
        title.textContent = credits
          ? `You claimed ${credits} Ropilot Credits`
          : 'You claimed Ropilot Credits';
      }
    }
    if (description) {
      description.textContent = options.alreadyClaimed
        ? 'This account already claimed the free starter offer, so Ropilot Credits mode is ready.'
        : 'Your free starter credits were added to this account. Ropilot Credits mode is ready.';
    }
    if (status) {
      status.textContent = '';
      status.classList.add('hidden');
      status.classList.remove('is-error');
    }
    if (btn) {
      btn.disabled = false;
      btn.dataset.freeOfferAction = 'continue';
    }
    if (text) {
      text.textContent = 'Start building';
      text.classList.remove('hidden');
    }
    spinner?.classList.add('hidden');
  }

  async finishFreeOfferClaimSuccess() {
    const context = this._freeOfferClaimSuccessContext || {};
    this._freeOfferClaimSuccessContext = null;
    document.getElementById('free-offer-claim-screen')?.classList.add('hidden');
    await this.routeAfterProviderReady();
    if (context.noActionsModalSource) {
      this.maybeShowNoActionsModalForFreeOfferBalance(
        context.balancePayload,
        context.noActionsModalSource,
      );
    }
  }

  maybeShowNoActionsModalForFreeOfferBalance(balancePayload, source) {
    const remaining = Number(
      balancePayload?.credits_remaining
      ?? balancePayload?.remaining
      ?? this.app.latestManagedAiCreditsBalance?.remaining
      ?? this.app.accountCreditsBalance?.remaining,
    );
    if (Number.isFinite(remaining) && remaining < 0.5) {
      this.app.showNoActionsModal?.({ source });
    }
  }

  async getAdvancedInputConnectionStatus() {
    const wsUrl = this.app.wsUrl || await electronAPI().getWsUrl?.();
    const httpBase = wsUrl
      ? wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/ws$/, '')
      : 'http://localhost:8765';
    const response = await localApiFetch(`${httpBase}/health`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Health check failed (${response.status})`);
    }
    const payload = await response.json();
    return !!payload?.studio?.message_seen;
  }

  updateAdvancedInputSetupUI(connected, errorMessage = '') {
    const primaryBtn = document.getElementById('btn-complete-advanced-input-setup');
    const primaryText = primaryBtn?.querySelector('.btn-text');
    const statusText = document.getElementById('advanced-input-setup-status');

    this._advancedInputConnected = !!connected;
    if (primaryBtn) {
      primaryBtn.disabled = !connected;
    }
    if (primaryText) {
      primaryText.textContent = connected
        ? 'Finish Setup'
        : 'Waiting for connection from Roblox Studio...';
    }
    if (statusText) {
      statusText.textContent = connected
        ? 'Ropilot detected a connection from Roblox Studio. You can finish setup now.'
        : (errorMessage || 'Waiting for a connection from Roblox Studio.');
    }
  }

  async refreshAdvancedInputStatus() {
    try {
      const connected = await this.getAdvancedInputConnectionStatus();
      this.updateAdvancedInputSetupUI(connected);
      return connected;
    } catch (err) {
      this.updateAdvancedInputSetupUI(false, 'Waiting for a connection from Roblox Studio.');
      return false;
    }
  }

  startAdvancedInputStatusPolling() {
    this.stopAdvancedInputStatusPolling();
    this.refreshAdvancedInputStatus();
    this._advancedInputPollTimer = setInterval(() => {
      this.refreshAdvancedInputStatus();
    }, 1500);
  }

  stopAdvancedInputStatusPolling() {
    if (this._advancedInputPollTimer) {
      clearInterval(this._advancedInputPollTimer);
      this._advancedInputPollTimer = null;
    }
  }

  showWelcome() {
    if (this.isFreeOfferOnboardingPending() && this.app.apiKey) {
      this.showFreeOfferClaimSetup();
      return;
    }
    this.stopAdvancedInputStatusPolling();
    const sidebar = document.getElementById('sidebar');
    const wasOnboarded = storage.getRaw(storage.KEYS.onboardingComplete) === '1';
    storage.set(storage.KEYS.onboardingComplete, '1');
    if (this.app.activeChat) {
      document.getElementById('chat-view').classList.remove('hidden');
    } else {
      document.getElementById('welcome-screen').classList.remove('hidden');
    }
    sidebar.style.opacity = '1';
    sidebar.style.pointerEvents = 'auto';

    storage.set(storage.KEYS.opus47AnnouncementShown, 'true');
    if (wasOnboarded) {
      // Show the newest eligible announcement, at most one per startup.
      // (The Opus 5 announcement was retired with Opus 5 on 2026-10-04.)
      Promise.resolve(this.app.maybeShowAstraAnnouncement?.())
        .then((shown) => shown || this.app.maybeShowFable51Announcement?.())
        .catch(() => {});
    } else {
      // Brand-new users are onboarding to the current state, so skip launch modals.
      localStorage.setItem('ropilot_astra_announcement_shown', 'true');
      storage.set(storage.KEYS.gpt55AnnouncementShown, 'true');
      storage.set(storage.KEYS.opus48AnnouncementShown, 'true');
      storage.set(storage.KEYS.fable5AnnouncementShown, 'true');
      storage.set(storage.KEYS.opus5AnnouncementShown, 'true');
      storage.set(storage.KEYS.fable51AnnouncementShown, 'true');
    }
  }

  updateStatusIcon(itemId, status, resultText) {
    const item = document.getElementById(itemId);
    if (!item) return;

    const icon = item.querySelector('.status-icon');
    const result = item.querySelector('.status-result');

    icon.classList.remove('pending', 'checking', 'success', 'error');
    icon.classList.add(status);

    if (status === 'success') {
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
    } else if (status === 'error') {
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    } else if (status === 'checking') {
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
    }

    if (result) {
      result.textContent = resultText;
    }
  }
}
