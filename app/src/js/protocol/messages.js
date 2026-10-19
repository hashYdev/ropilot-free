// @ts-check
// The renderer's WebSocket contract with the local Go server.
//
// Every inbound message is a JSON envelope; `content` is usually a
// JSON-encoded string (parse with MessageHandler.parseContent), and
// `session_id` routes the message to a chat. MessageHandler dispatches on
// `type` via its handlers map; the RopilotHarness in app.handleMessage may
// intercept a message before it reaches the handler.
//
// Keep this enum in sync with the Go server's outbound writes (server/*.go)
// — it is documentation plus dispatch keys, with no runtime validation.

/**
 * @typedef {Object} InboundMessage
 * @property {string} type - one of the MSG values
 * @property {string} [session_id] - target chat id; when absent the handler
 *   falls back to the single processing chat, if there is exactly one
 * @property {string|Object} [content] - JSON-encoded payload (shape varies
 *   by type; see field notes on each MSG entry)
 * @property {number|string} [cost] - ropilot_actions_cost
 * @property {number|string} [credits_charged] - ropilot_credits_cost
 * @property {string} [command] - command_output: the Studio command run
 * @property {string} [output] - command_output: its captured output
 * @property {string} [tool_use_id] - ask_user_question
 * @property {string} [claude_session_id] - done/stopped/error: provider
 *   session persistence
 * @property {Object} [turn_checkpoints] - done/stopped/error
 * @property {string|null} [codex_thread_id] - done/stopped/error
 * @property {boolean} [has_history] - done/stopped/error
 * @property {boolean} [context_reset] - done: a Codex compact reset the
 *   provider context, so the renderer should clear its context-window usage.
 *   Codex-only; Claude keeps its CLI session across a compact
 * @property {number} [client_sent_at_ms] - steer_accepted/steer_rejected:
 *   correlates the acknowledgement with the outbound steer
 * @property {string} [request_id] - steer_accepted/steer_rejected: stable
 *   request correlation identifier
 * @property {boolean} [queue_for_next_turn] - steer_rejected: retry the exact
 *   input as the next main-agent turn
 * @property {boolean} [session_processing] - steer_rejected: authoritative
 *   server session state when the rejection was emitted
 */

/**
 * @typedef {Object} OutboundUserMessage
 * @property {'user'} type
 * @property {string} prompt
 * @property {string} session_id
 * @property {string} api_key
 * @property {string} [project_dir]
 * @property {string} [model]
 * @property {number} [message_index]
 * @property {string} [custom_prompt]
 * @property {Array<{role: string, content: string}>} [messages]
 * @property {Array<{mime_type: string, data: string}>} [images]
 */

/**
 * @typedef {Object} OutboundSteerMessage
 * @property {'steer'} type
 * @property {string} prompt
 * @property {string} session_id
 * @property {Array<{mime_type: string, data: string}>} [images]
 * @property {number} client_sent_at_ms
 * @property {string} request_id
 * @property {true} steer_rejection_supported - capability negotiation for
 *   correlated, nonterminal steer acknowledgements
 */

/** Inbound message types (Go server → renderer). */
export const MSG = Object.freeze({
  // Billing / usage
  ROPILOT_ACTIONS_COST: 'ropilot_actions_cost', // per-turn action cost (msg.cost)
  ROPILOT_CREDITS_COST: 'ropilot_credits_cost', // managed-credits charge (msg.credits_charged; negative = refund)
  LOOP_WAIVER: 'loop_waiver', // loop-guard refund outcome, analytics only; the chip is corrected by the negative ropilot_credits_cost that accompanies it
  CONTEXT_WINDOW_USAGE: 'context_window_usage', // token usage snapshot (content.{input,output,...})
  USAGE: 'usage', // legacy alias of context_window_usage

  // Turn lifecycle
  WORKING_HINT: 'working_hint', // status pill (content.{label,detail,command})
  COMMAND_OUTPUT: 'command_output', // Studio run-command output (msg.{command,output})
  BLENDER_INSTALL: 'blender_install', // Blender install progress (content.{state,version,received,total,error})
  STUDIO_RESTART_NEEDED: 'studio_restart_needed', // Studio must restart to pick up a setting Ropilot turned on (content.{reason,platform})
  BLENDER_PREVIEW: 'blender_preview', // GLB snapshot after a Blender tool call (msg.{path,objects,tool,name})
  CHAT_IMAGE: 'chat_image', // screenshot the agent took, shown inline in the chat (msg.{path,caption,source})
  EMIT: 'emit', // explicit user-facing message from the agent
  ERROR: 'error', // turn-fatal error text (content.text)
  DEAD_AIR: 'dead_air', // helper ended the turn for stream silence (content.{budget_ms,silence_ms,open_items,reasoning_level,model})
  STEER_ACCEPTED: 'steer_accepted', // nonterminal acknowledgement of a steer
  STEER_REJECTED: 'steer_rejected', // nonterminal rejection; may request main-turn queue fallback
  DONE: 'done', // turn finished (session persistence fields)
  STOPPED: 'stopped', // turn cancelled by the user

  // Script sync
  SCRIPT_DIFF: 'script_diff', // full-file diff payload for the diff preview
  PATH_MAPPING: 'path_mapping', // Studio path ↔ file path mapping
  SOURCECONTROL_STATE: 'sourcecontrol_state', // Studio-mode pending-script state
  SETTINGS_UPDATE: 'settings_update', // server-pushed settings change

  // Playtest
  PLAYTEST_EVENT: 'playtest_event',
  PLAYTEST_SCRIPT: 'playtest_script',
  PLAYTEST_SCRIPT_UPDATE: 'playtest_script_update',
  PLAYTEST_RESULT: 'playtest_result',

  // Assistant output
  SUBAGENT_TEXT: 'subagent_text', // Task-tool subagent stream
  AGENT_TEXT: 'agent_text', // main assistant text stream
  THINKING: 'thinking', // Codex public reasoning summary (content.{item_id,summary_index,text,delta,completed})

  // Plan mode
  PLAN_MODE_ENTER: 'plan_mode_enter',
  ASK_USER_QUESTION: 'ask_user_question', // content.questions + msg.tool_use_id
  PLAN_MODE_EXIT: 'plan_mode_exit', // content.plan_text
});

/** Outbound message types (renderer → Go server). */
export const OUT = Object.freeze({
  USER: 'user', // start/continue a turn (message-sender.js)
  STEER: 'steer', // steer a running turn (message-sender.js)
  STOP: 'stop', // cancel the running turn (message-sender.js)
  SET_API_KEY: 'set_api_key', // announce the key after connect (websocket.js)
});
