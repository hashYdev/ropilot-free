function toFiniteNumber(value) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.isFinite(Number(value)) ? Number(value) : null;
}

function asRecord(value) {
  return value && typeof value === 'object' ? value : null;
}

function asBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function roundTokenCount(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase() === 'codex' ? 'codex' : 'claude';
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalRounded(value, { min = 0 } = {}) {
  if (!Number.isFinite(value) || value < min) {
    return undefined;
  }
  return Math.round(value);
}

// A current-context reading can never exceed the context window itself.
// Server builds have leaked the CUMULATIVE session total into usedTokens
// (the Go server falls back to total_token_usage when a Codex
// thread/tokenUsage/updated event carries an empty last_token_usage, and
// older codex_turn_completed / claude paths summed per-request usage), which
// rendered as e.g. "100% · 3m/380k context used". Each Codex request
// re-sends the full history, so the cumulative total overshoots the real
// context size by orders of magnitude within a handful of turns.
//
// When usedTokens overflows the window, try to recover the real current
// context size from the per-turn reading; if the payload has no distinct
// per-turn reading (the fallback case copies the cumulative value into the
// last* fields too), the event carries no usable context information.
// Returns { usedTokens, totalProcessedTokens } or null when unrecoverable.
function reconcileOverflowingUsedTokens(usedTokens, maxTokens, lastUsedTokens, totalProcessedTokens) {
  // A genuine reading can exceed the window by roughly one turn's output
  // right before compaction kicks in; only readings past a 10% overshoot are
  // treated as the cumulative-total bug.
  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || !(usedTokens > maxTokens * 1.1)) {
    return { usedTokens, totalProcessedTokens };
  }
  if (!Number.isFinite(lastUsedTokens) || lastUsedTokens <= 0
    || lastUsedTokens > maxTokens * 1.1 || lastUsedTokens >= usedTokens) {
    return null;
  }
  const cumulative = Math.round(usedTokens);
  return {
    usedTokens: Math.round(lastUsedTokens),
    totalProcessedTokens: Number.isFinite(totalProcessedTokens) && totalProcessedTokens > cumulative
      ? Math.round(totalProcessedTokens)
      : cumulative,
  };
}

export function normalizeContextWindowUsage(rawUsage, {
  fallbackProvider = 'claude',
  fallbackModel = '',
} = {}) {
  if (!rawUsage || typeof rawUsage !== 'object') {
    return null;
  }

  const provider = normalizeProvider(rawUsage.provider || fallbackProvider);
  const model = trimString(rawUsage.model) || trimString(fallbackModel);
  const source = trimString(rawUsage.source) || 'unknown';
  const usedTokens = toFiniteNumber(rawUsage.usedTokens ?? rawUsage.used_tokens);
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) {
    return null;
  }

  const contextWindow = toFiniteNumber(rawUsage.contextWindow ?? rawUsage.context_window);
  const rawMaxTokens = toFiniteNumber(rawUsage.maxTokens ?? rawUsage.max_tokens);
  const maxTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens > 0
    ? Math.round(rawMaxTokens)
    : Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.round(contextWindow)
      : null;
  const totalProcessedTokens = toFiniteNumber(rawUsage.totalProcessedTokens ?? rawUsage.total_processed_tokens);
  const updatedAt = toFiniteNumber(rawUsage.updatedAt ?? rawUsage.updated_at) || Date.now();

  const reconciled = reconcileOverflowingUsedTokens(
    usedTokens,
    maxTokens,
    toFiniteNumber(rawUsage.lastUsedTokens ?? rawUsage.last_used_tokens),
    totalProcessedTokens,
  );
  if (!reconciled) {
    return null;
  }

  const normalized = {
    provider,
    model,
    source,
    usedTokens: Math.round(reconciled.usedTokens),
    totalProcessedTokens: Number.isFinite(reconciled.totalProcessedTokens) && reconciled.totalProcessedTokens > reconciled.usedTokens
      ? Math.round(reconciled.totalProcessedTokens)
      : null,
    maxTokens,
    contextWindow: optionalRounded(contextWindow, { min: 1 }),
    maxOutputTokens: optionalRounded(toFiniteNumber(rawUsage.maxOutputTokens ?? rawUsage.max_output_tokens), { min: 1 }),
    inputTokens: optionalRounded(toFiniteNumber(rawUsage.inputTokens ?? rawUsage.input_tokens)),
    cachedInputTokens: optionalRounded(toFiniteNumber(rawUsage.cachedInputTokens ?? rawUsage.cached_input_tokens)),
    outputTokens: optionalRounded(toFiniteNumber(rawUsage.outputTokens ?? rawUsage.output_tokens)),
    reasoningOutputTokens: optionalRounded(toFiniteNumber(rawUsage.reasoningOutputTokens ?? rawUsage.reasoning_output_tokens)),
    lastUsedTokens: optionalRounded(toFiniteNumber(rawUsage.lastUsedTokens ?? rawUsage.last_used_tokens)),
    lastInputTokens: optionalRounded(toFiniteNumber(rawUsage.lastInputTokens ?? rawUsage.last_input_tokens)),
    lastCachedInputTokens: optionalRounded(toFiniteNumber(rawUsage.lastCachedInputTokens ?? rawUsage.last_cached_input_tokens)),
    lastOutputTokens: optionalRounded(toFiniteNumber(rawUsage.lastOutputTokens ?? rawUsage.last_output_tokens)),
    lastReasoningOutputTokens: optionalRounded(toFiniteNumber(rawUsage.lastReasoningOutputTokens ?? rawUsage.last_reasoning_output_tokens)),
    cacheCreationInputTokens: optionalRounded(toFiniteNumber(rawUsage.cacheCreationInputTokens ?? rawUsage.cache_creation_input_tokens)),
    cacheReadInputTokens: optionalRounded(toFiniteNumber(rawUsage.cacheReadInputTokens ?? rawUsage.cache_read_input_tokens)),
    toolUses: optionalRounded(toFiniteNumber(rawUsage.toolUses ?? rawUsage.tool_uses)),
    durationMs: optionalRounded(toFiniteNumber(rawUsage.durationMs ?? rawUsage.duration_ms)),
    compactsAutomatically: rawUsage.compactsAutomatically === true || rawUsage.compacts_automatically === true,
    updatedAt,
  };

  if (normalized.lastUsedTokens == null) {
    normalized.lastUsedTokens = normalized.usedTokens;
  }
  if (normalized.lastInputTokens == null && normalized.inputTokens != null) {
    normalized.lastInputTokens = normalized.inputTokens;
  }
  if (normalized.lastCachedInputTokens == null && normalized.cachedInputTokens != null) {
    normalized.lastCachedInputTokens = normalized.cachedInputTokens;
  }
  if (normalized.lastOutputTokens == null && normalized.outputTokens != null) {
    normalized.lastOutputTokens = normalized.outputTokens;
  }
  if (normalized.lastReasoningOutputTokens == null && normalized.reasoningOutputTokens != null) {
    normalized.lastReasoningOutputTokens = normalized.reasoningOutputTokens;
  }

  return normalized;
}

export function contextWindowUsageEquals(left, right) {
  if (!left || !right) {
    return false;
  }

  return left.provider === right.provider
    && left.model === right.model
    && left.source === right.source
    && left.usedTokens === right.usedTokens
    && (left.totalProcessedTokens ?? null) === (right.totalProcessedTokens ?? null)
    && (left.maxTokens ?? null) === (right.maxTokens ?? null)
    && (left.inputTokens ?? null) === (right.inputTokens ?? null)
    && (left.cachedInputTokens ?? null) === (right.cachedInputTokens ?? null)
    && (left.outputTokens ?? null) === (right.outputTokens ?? null)
    && (left.reasoningOutputTokens ?? null) === (right.reasoningOutputTokens ?? null)
    && (left.toolUses ?? null) === (right.toolUses ?? null)
    && (left.durationMs ?? null) === (right.durationMs ?? null)
    && left.compactsAutomatically === right.compactsAutomatically;
}

export function appendContextWindowActivity(chat, rawUsage, options = {}) {
  if (!chat) {
    return { usage: null, changed: false };
  }

  const normalized = normalizeContextWindowUsage(rawUsage, options);
  if (!normalized) {
    return { usage: null, changed: false };
  }

  if (!Array.isArray(chat.activities)) {
    chat.activities = [];
  }

  const current = deriveLatestContextWindowSnapshot(chat.activities);
  if (current && contextWindowUsageEquals(current, normalized)) {
    chat.contextUsage = null;
    return { usage: current, changed: false };
  }

  chat.activities.push({
    kind: 'context-window.updated',
    createdAt: new Date(normalized.updatedAt).toISOString(),
    payload: normalized,
  });
  chat.contextUsage = null;

  return { usage: normalized, changed: true };
}

export function clearContextWindowActivities(chat) {
  if (!chat) {
    return false;
  }

  const hadLegacyUsage = chat.contextUsage != null;
  chat.contextUsage = null;
  if (!Array.isArray(chat.activities) || chat.activities.length === 0) {
    return hadLegacyUsage;
  }

  const nextActivities = chat.activities.filter((activity) => activity?.kind !== 'context-window.updated');
  if (nextActivities.length === chat.activities.length) {
    return hadLegacyUsage;
  }

  chat.activities = nextActivities;
  return true;
}

export function migrateLegacyContextWindowActivities(chat, options = {}) {
  if (!chat || typeof chat !== 'object') {
    return false;
  }

  if (!Array.isArray(chat.activities)) {
    chat.activities = [];
  }

  if (chat.activities.some((activity) => activity?.kind === 'context-window.updated')) {
    return false;
  }

  const legacyUsage = normalizeContextWindowUsage(chat.contextUsage, options);
  if (!legacyUsage) {
    return false;
  }

  chat.activities.push({
    kind: 'context-window.updated',
    createdAt: new Date(legacyUsage.updatedAt || chat.updatedAt || Date.now()).toISOString(),
    payload: legacyUsage,
  });
  chat.contextUsage = null;
  return true;
}

export function deriveLatestContextWindowSnapshot(activities) {
  if (!Array.isArray(activities)) {
    return null;
  }

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== 'context-window.updated') {
      continue;
    }

    const payload = asRecord(activity.payload);
    const rawUsedTokens = toFiniteNumber(payload?.usedTokens);
    if (rawUsedTokens === null || rawUsedTokens <= 0) {
      continue;
    }

    const maxTokens = toFiniteNumber(payload?.maxTokens);
    // Persisted activities can carry the cumulative-total bug too; repair the
    // reading the same way live events are repaired, or skip it entirely.
    const reconciled = reconcileOverflowingUsedTokens(
      rawUsedTokens,
      maxTokens,
      toFiniteNumber(payload?.lastUsedTokens),
      toFiniteNumber(payload?.totalProcessedTokens),
    );
    if (!reconciled) {
      continue;
    }
    const usedTokens = Math.round(reconciled.usedTokens);
    const usedPercentage = maxTokens !== null && maxTokens > 0
      ? Math.min(100, (usedTokens / maxTokens) * 100)
      : null;
    const remainingTokens = maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      provider: normalizeProvider(payload?.provider),
      model: trimString(payload?.model),
      source: trimString(payload?.source) || 'unknown',
      usedTokens,
      totalProcessedTokens: Number.isFinite(reconciled.totalProcessedTokens) && reconciled.totalProcessedTokens > usedTokens
        ? Math.round(reconciled.totalProcessedTokens)
        : toFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      contextWindow: toFiniteNumber(payload?.contextWindow),
      maxOutputTokens: toFiniteNumber(payload?.maxOutputTokens),
      inputTokens: toFiniteNumber(payload?.inputTokens),
      cachedInputTokens: toFiniteNumber(payload?.cachedInputTokens),
      outputTokens: toFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: toFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: toFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: toFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: toFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: toFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: toFiniteNumber(payload?.lastReasoningOutputTokens),
      cacheCreationInputTokens: toFiniteNumber(payload?.cacheCreationInputTokens),
      cacheReadInputTokens: toFiniteNumber(payload?.cacheReadInputTokens),
      toolUses: toFiniteNumber(payload?.toolUses),
      durationMs: toFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      updatedAt: typeof activity.createdAt === 'string' && activity.createdAt
        ? activity.createdAt
        : new Date().toISOString(),
    };
  }

  return null;
}

export function formatContextWindowTokens(value) {
  if (!Number.isFinite(value) || value === null) {
    return '0';
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}
