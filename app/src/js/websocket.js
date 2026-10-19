// WebSocket - connection management for Go server communication
import { store } from './state-store.js';
import { createLocalAPIWebSocket } from './local-api-auth.js';

export class WebSocketManager {
  constructor(app) {
    this.app = app;
    this.ws = null;
    this.connectAttempts = 0;
    this.state = 'idle'; // idle | connecting | open | backoff | closed
    this.reconnectTimer = null;
    this.reconnectDisabled = false;
    this.baseBackoffMs = 300;
    this.maxBackoffMs = 10000;
    this.connectionGeneration = 0;
  }

  log(event, extra = {}) {
    console.log(JSON.stringify({
      event,
      component: 'websocket',
      state: this.state,
      ...extra,
    }));
  }

  connect() {
    this.reconnectDisabled = false;
    this.clearReconnectTimer();
    this.startConnection();
  }

  // Explicit user retry path
  forceReconnect() {
    this.connectAttempts = 0;
    this.connect();
  }

  stop() {
    this.reconnectDisabled = true;
    this.connectionGeneration += 1;
    this.state = 'closed';
    this.clearReconnectTimer();
    this.detachSocketHandlers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  detachSocketHandlers() {
    if (!this.ws) return;
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
  }

  async startConnection() {
    if (this.reconnectDisabled) {
      return;
    }

    const generation = ++this.connectionGeneration;

    this.detachSocketHandlers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    this.state = 'connecting';
    this.connectAttempts += 1;
    this.log('ws_connect_attempt', { attempt: this.connectAttempts, url: this.app.wsUrl });

    let socket;
    try {
      socket = await createLocalAPIWebSocket(this.app.wsUrl);
    } catch (error) {
      if (generation !== this.connectionGeneration || this.reconnectDisabled) return;
      this.log('ws_create_error', { error: String(error?.message || error) });
      this.scheduleReconnect();
      return;
    }
    if (generation !== this.connectionGeneration || this.reconnectDisabled) {
      try { socket.close(); } catch {}
      return;
    }

    this.ws = socket;
    this.app.ws = this.ws; // Backward compat for existing send paths

    this.ws.onopen = () => {
      this.state = 'open';
      this.log('ws_open', { attempt: this.connectAttempts });
      this.connectAttempts = 0;
      this.hideErrorModal();
      this.clearStaleStateOnReconnect();

      const apiKey = typeof this.app.getEffectiveApiKey === 'function'
        ? this.app.getEffectiveApiKey()
        : '';
      if (apiKey) {
        this.send({
          type: 'set_api_key',
          api_key: apiKey
        });
      }

      // Re-announce local preferences to the (possibly restarted) server.
      this.app._lastDiscordPresenceKey = null;
      this.app.sendDiscordPresence?.();
      this.app.sendAddRopilotMCPServerPreference?.();
      this.app.startNoActionsCreditRecoveryWatcher?.();
      // Prewarm attempts made before the socket opened were dropped by send();
      // the active chat is still empty, so retry now that there is a transport.
      // The dedupe set is per-connection: a reconnect usually means the Go
      // process restarted and lost the warm session, and a server that did
      // keep it refuses the duplicate itself (IsCodexThreadPrewarmed).
      this.app.prewarmedChatIds?.clear();
      this.app.maybePrewarmActiveCodexSession?.();
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this.app.handleMessage(msg);
      } catch (err) {
        this.log('ws_message_parse_error', { error: err.message });
      }
    };

    this.ws.onerror = () => {
      this.log('ws_error');
    };

    this.ws.onclose = () => {
      if (this.reconnectDisabled) {
        this.state = 'closed';
        return;
      }
      this.scheduleReconnect();
    };
  }

  computeReconnectDelay() {
    const exp = Math.max(0, this.connectAttempts - 1);
    const noJitter = Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** exp));
    const jitter = Math.floor(Math.random() * 150);
    return noJitter + jitter;
  }

  scheduleReconnect() {
    if (this.reconnectDisabled) return;
    if (this.reconnectTimer) return;

    if (this.connectAttempts >= 3) {
      this.showErrorModal();
    }

    const delay = this.computeReconnectDelay();
    this.state = 'backoff';
    this.log('ws_reconnect_scheduled', { attempt: this.connectAttempts + 1, delay_ms: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startConnection();
    }, delay);
  }

  clearStaleStateOnReconnect() {
    if (store.isAnyChatProcessing()) {
      const processingIds = new Set(store.get('processingChatIds'));
      this.log('ws_clear_processing', { count: processingIds.size });
      for (const chatId of processingIds) {
        this.app.finalizeStatusInChat(chatId);
      }
      store.clearAllProcessing();
    }
    // Turns interrupted by the disconnect never produce a terminal event, so
    // an in-flight compact record would otherwise survive to be consumed by
    // some later unrelated turn's "done".
    this.app.messageSender?.clearPendingCodexCompacts?.();

    // Clear stale playtest state (compat helper updates store + legacy fields)
    if (this.app.isPlaytestActive()) {
      this.log('ws_clear_playtest');
      this.app.clearPlaytestState('reconnect');
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      return true;
    }
    this.log('ws_send_blocked');
    return false;
  }

  showErrorModal() {
    const modal = document.getElementById('connection-error-modal');
    if (modal) {
      modal.classList.remove('hidden');
    }
  }

  hideErrorModal() {
    const modal = document.getElementById('connection-error-modal');
    if (modal) {
      modal.classList.add('hidden');
    }
    const retryText = document.querySelector('#btn-connection-retry .retry-text');
    const retrySpinner = document.querySelector('#btn-connection-retry .retry-spinner');
    if (retryText) retryText.classList.remove('hidden');
    if (retrySpinner) retrySpinner.classList.remove('visible');
  }
}
