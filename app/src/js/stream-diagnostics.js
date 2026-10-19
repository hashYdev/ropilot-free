// Metadata only. Never copy arbitrary helper payloads or error text into diagnostics.
export function normalizeStreamDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = { schema_version: 1 };
  const enums = {
    "last_method": [
      "thread/started",
      "thread/status/changed",
      "turn/started",
      "turn/completed",
      "turn/aborted",
      "thread/tokenUsage/updated",
      "item/started",
      "item/completed",
      "item/updated",
      "item/reasoning/summaryPartAdded",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/textDelta",
      "item/agentMessage/delta",
      "item/commandExecution/outputDelta",
      "item/mcpToolCall/progress",
      "error",
      "unknown",
      "rawResponseItem/completed",
      "rawResponse/completed",
      "item/commandExecution/terminalInteraction",
      "item/fileChange/outputDelta",
      "item/fileChange/patchUpdated",
      "item/plan/delta",
      "turn/plan/updated",
      "turn/diff/updated",
      "mcpServer/startupStatus/updated",
      "account/rateLimits/updated",
      "warning",
      "thread/settings/updated",
      "thread/compacted",
      "model/rerouted"
    ],
    "last_item_type": [
      "reasoning",
      "agentMessage",
      "userMessage",
      "commandExecution",
      "mcpToolCall",
      "dynamicToolCall",
      "fileChange",
      "collabAgentToolCall",
      "webSearch",
      "imageView",
      "imageGeneration",
      "enteredReviewMode",
      "exitedReviewMode",
      "contextCompaction",
      "subAgentActivity",
      "unknown",
      "functionCallOutput",
      "error",
      "hookPrompt",
      "plan",
      "sleep"
    ],
    "last_event_scope": [
      "parent",
      "child",
      "other",
      "unknown"
    ],
    "reasoning_level": [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "unknown"
    ]
  };
  for (const [key, allowed] of Object.entries(enums)) {
    if (typeof value[key] === 'string') out[key] = allowed.includes(value[key]) ? value[key] : 'unknown';
  }
  for (const key of ['turn_elapsed_ms', 'last_item_age_ms', 'last_completed_age_ms', 'notification_count', 'child_notification_count', 'open_items', 'budget_ms', 'silence_ms']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) {
      out[key] = Math.min(2147483647, Math.round(value[key]));
    }
  }
  if (typeof value.awaiting_stream_retry === 'boolean') out.awaiting_stream_retry = value.awaiting_stream_retry;
  return out;
}
