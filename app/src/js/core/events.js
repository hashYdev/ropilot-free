// @ts-check
// Names of every event that flows through the state store's pub-sub
// (store.subscribe / store.notify). Two kinds share the channel:
//
//  - State keys: notify fires automatically when store.set/batch changes
//    the key. The value is the new state.
//  - Signals: fire-and-forget notifications for cross-module events that
//    aren't state (timeline appended, chat content updated). Payload is
//    event-specific; there is no stored value behind them.
//
// Wildcard subscribers (subscribe('*')) receive both kinds. Use these
// constants instead of string literals so the channel list stays greppable.

/** State keys (mirror the StateStore state shape). */
export const STATE = Object.freeze({
  PROJECTS: 'projects',
  ACTIVE_CHAT_ID: 'activeChatId',
  ACTIVE_PROJECT_ID: 'activeProjectId',
  PROCESSING_CHAT_IDS: 'processingChatIds',
  PLAYTEST_ACTIVE: 'playtestActive',
  ACTIVE_PLAYTEST_PANEL_ID: 'activePlaytestPanelId',
  ACTIVE_PLAYTEST_CHAT_ID: 'activePlaytestChatId',
  MODEL_SELECTION: 'modelSelection',
  CREDITS: 'credits',
});

/** Signals with no stored state behind them. */
export const SIGNALS = Object.freeze({
  /** A chat's timeline got a new item; payload { chatId }. */
  CHAT_TIMELINE: 'chatTimeline',
  /** A chat's content changed outside the timeline; payload { chatId }. */
  CHAT_UPDATED: 'chatUpdated',
});
