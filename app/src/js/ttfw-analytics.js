const LOG_PREFIX = '[TTFW]';

export class TtfwAnalytics {
  constructor(app, options = {}) {
    this.app = app;
    this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
    this.now = options.now || (() => Date.now());
    this.pendingByChatId = new Map();
  }

  getEffectiveApiKey() {
    return typeof this.app.getEffectiveApiKey === 'function'
      ? this.app.getEffectiveApiKey()
      : this.app.apiKey;
  }

  getIngestEndpointUrl() {
    const siteUrl = typeof this.app.config?.siteUrl === 'string'
      ? this.app.config.siteUrl.trim()
      : '';
    if (siteUrl) {
      return `${siteUrl}/api/analytics/ttfw-event`;
    }

    return 'https://ropilot.ai/api/analytics/ttfw-event';
  }

  startTurn({
    chatId,
    turnId,
    provider,
    model,
    projectDir = null,
    startedAt = this.now(),
  }) {
    if (!chatId || !turnId) {
      return;
    }

    this.pendingByChatId.set(chatId, {
      chatId,
      turnId,
      provider: provider || 'unknown',
      model: model || 'unknown',
      projectDir: typeof projectDir === 'string' && projectDir.trim() ? projectDir.trim() : null,
      startedAt,
      emitted: false,
    });
  }

  finishTurn(chatId) {
    if (!chatId) {
      return;
    }
    this.pendingByChatId.delete(chatId);
  }

  async postEvent(payload) {
    const apiKey = this.getEffectiveApiKey();
    if (!apiKey) {
      throw new Error('Missing API key');
    }

    const response = await this.fetchImpl(this.getIngestEndpointUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`TTFW ingest failed (${response.status}): ${raw || 'empty response'}`);
    }
  }

  noteFirstWrite(chatId, details = {}) {
    if (!chatId) {
      return;
    }

    const pending = this.pendingByChatId.get(chatId);
    if (!pending || pending.emitted) {
      return;
    }

    const ttfwMs = this.now() - pending.startedAt;
    if (!Number.isFinite(ttfwMs) || ttfwMs < 0) {
      return;
    }

    pending.emitted = true;

    const payload = {
      chat_id: pending.chatId,
      turn_id: pending.turnId,
      provider: pending.provider,
      model: pending.model,
      project_dir: pending.projectDir,
      source_mode: details.isFileSync ? 'filesync' : 'sourcecontrol',
      ttfw_ms: Math.round(ttfwMs),
    };

    void this.postEvent(payload)
      .catch((err) => {
        pending.emitted = false;
        console.warn(`${LOG_PREFIX} Failed to post event for ${pending.turnId}:`, err);
      });
  }
}
