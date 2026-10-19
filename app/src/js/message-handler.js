// Message Handler - routes incoming WebSocket messages to appropriate handlers
import { updateBlenderInstallToast } from './blender-install-toast.js';
import { showStudioRestartToast } from './studio-restart-toast.js';
import { MSG } from './protocol/messages.js';
import { normalizeThinkingContent } from './thinking-block.js';

// Never console.log full inbound payloads (script_diff carries whole files):
// DevTools retains logged objects, pinning multi-MB strings in memory. Flip
// this on locally to trace message flow — it logs type + size only.
const DEBUG_WS = false;

const CLAUDE_USAGE_PREFIX = '[From Claude Code]';
const CLAUDE_USAGE_SUFFIX = 'Check usage at https://claude.ai/settings/usage';
const CLAUDE_RESET_LINE_PATTERN = /^-\s*Resets\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;
const CLAUDE_AUTH_ERROR_PREFIX = '[From Claude Code]';
const CLAUDE_CREDIT_USAGE_SUFFIX = 'check your usage at https://claude.ai/settings/usage';
// Ropilot runs Claude only with the 1M context window (2026-10-04), so a plan
// without 1M access has no smaller Claude to fall back to.
const CLAUDE_OPUS_1M_NOTE = 'Ropilot runs Claude models with the 1M context window, which may require Claude Max or eligible account access. Upgrade from https://claude.com/pricing, or use a GPT model instead.';
const CODEX_AUTH_ERROR_PREFIX = '[From Codex]';
const CODEX_SETUP_MISSING_MESSAGE = 'This request was routed to ChatGPT Codex, but Codex is not set up in Ropilot Studio. Open the AI Providers screen, finish ChatGPT Codex setup, then retry.';
const CODEX_PLAN_LIMIT_NOTE = 'GPT 5.6 Sol and Luna, GPT 5.5, GPT 5.4, and GPT 5.3 Codex require ChatGPT Plus or higher. GPT 5.6 Terra is available on ChatGPT Free and Go.';
const CODEX_PLAN_RETRY_NOTE = 'This model is unavailable for your ChatGPT plan. Retry with GPT 5.6 Terra, which is available on ChatGPT Free and Go?';
const CODEX_PLAYTEST_SUBAGENT_PLAN_NOTE = 'Your Codex Playtest Subagent setting is using a restricted model. On ChatGPT Free or Go, switch that setting to GPT 5.6 Terra in Settings and retry.';
// Degeneration guard stop (Go server codexDegenerationStopMessage). The
// parenthesized machine marker classifies it; the displayed copy below is
// provider-framed and blame-free. The Go side quarantines the poisoned
// thread before emitting this, so ONE automatic retry usually succeeds.
const DEGENERATION_RETRY_MARKER = 'agent_loop_degenerated';
const DEGENERATION_RETRY_TEXT = 'OpenAI services are having issues — please try again in a moment.';
const ROPILOT_ECONOMY_ROUTE_RETRY_NOTE = 'Standard is having trouble with this request. You can retry Standard, or switch this chat to Priority and retry with the more reliable route. Priority can cost substantially more Ropilot Credits, so retry Standard if you are on a budget. If this does not work, there may be an active outage. Please try again in a few minutes/later.';
// Vendor status pages for Standard route failures. The sentence is APPENDED
// to ROPILOT_ECONOMY_ROUTE_RETRY_NOTE (never edits it — the autopilot and
// detection copy must stay byte-identical) and ends mid-phrase on "check";
// the renderer finishes it with the allowlisted noteLink anchor.
const VENDOR_STATUS_NOTE_LINKS = {
  codex: { vendor: 'OpenAI', href: 'https://status.openai.com/', label: 'status.openai.com' },
  claude: { vendor: 'Anthropic', href: 'https://status.claude.com/', label: 'status.claude.com' },
};
const STUDIO_DIAGNOSTIC_TYPES = new Set([
  'playtest_output_diagnostics',
  'studio_output_diagnostics',
  'studio_console_diagnostics',
  'studio_diagnostics',
]);

export class MessageHandler {
  constructor(app) {
    this.app = app;
    // chatId -> dispatch timestamp of the ONE automatic degeneration
    // recovery retry. Present = a retry is in flight / unresolved, so a
    // second degeneration in the same streak renders manual-only. Cleared
    // when the retried turn ends without degenerating (onDone/onStopped),
    // so a fresh degeneration hours later earns a fresh auto-retry.
    this.degenerationRetryPendingByChat = new Map();
    // chatIds whose CURRENT turn contained a degeneration stop — consumed at
    // turn end so settleDegenerationRetry can tell the degenerate turn apart
    // from the clean retry that follows it.
    this.degenerationStopSeenThisTurn = new Set();
    // Test seams for the auto-retry scheduling.
    this.degenAutoRetryDelayMs = 1200;
    this.degenAutoRetryPollMs = 1000;
    this.degenAutoRetryMaxPolls = 10;
    // Inbound dispatch table - one method per MSG type. Unknown types are
    // ignored, matching the old switch's no-default behavior.
    this.handlers = {
      [MSG.ROPILOT_ACTIONS_COST]: this.onRopilotActionsCost,
      [MSG.ROPILOT_CREDITS_COST]: this.onRopilotCreditsCost,
      [MSG.LOOP_WAIVER]: this.onLoopWaiver,
      [MSG.CONTEXT_WINDOW_USAGE]: this.onContextWindowUsage,
      [MSG.USAGE]: this.onContextWindowUsage,  // legacy alias of context_window_usage
      [MSG.WORKING_HINT]: this.onWorkingHint,
      [MSG.DEAD_AIR]: this.onDeadAir,
      [MSG.COMMAND_OUTPUT]: this.onCommandOutput,
      [MSG.BLENDER_PREVIEW]: this.onBlenderPreview,
      [MSG.CHAT_IMAGE]: this.onChatImage,
      [MSG.BLENDER_INSTALL]: this.onBlenderInstall,
      [MSG.STUDIO_RESTART_NEEDED]: this.onStudioRestartNeeded,
      [MSG.EMIT]: this.onEmit,
      [MSG.ERROR]: this.onError,
      [MSG.STEER_ACCEPTED]: this.onSteerAccepted,
      [MSG.STEER_REJECTED]: this.onSteerRejected,
      [MSG.DONE]: this.onDone,
      [MSG.STOPPED]: this.onStopped,
      [MSG.SCRIPT_DIFF]: this.onScriptDiff,
      [MSG.PATH_MAPPING]: this.onPathMapping,
      [MSG.SOURCECONTROL_STATE]: this.onSourcecontrolState,
      [MSG.SETTINGS_UPDATE]: this.onSettingsUpdate,
      [MSG.PLAYTEST_EVENT]: this.onPlaytestEvent,
      [MSG.PLAYTEST_SCRIPT]: this.onPlaytestScript,
      [MSG.PLAYTEST_SCRIPT_UPDATE]: this.onPlaytestScriptUpdate,
      [MSG.PLAYTEST_RESULT]: this.onPlaytestResult,
      [MSG.SUBAGENT_TEXT]: this.onSubagentText,
      [MSG.AGENT_TEXT]: this.onAgentText,
      [MSG.THINKING]: this.onThinking,
      [MSG.PLAN_MODE_ENTER]: this.onPlanModeEnter,
      [MSG.ASK_USER_QUESTION]: this.onAskUserQuestion,
      [MSG.PLAN_MODE_EXIT]: this.onPlanModeExit,
    };
  }

  persistProviderSessionState(msg, chat, targetChatId, reason = 'turn_terminal', options = {}) {
    if (!chat || !msg || typeof msg !== 'object') {
      return false;
    }

    let changed = false;
    // A completed Codex compact always resets the provider context. New Go
    // binaries say so explicitly (context_reset); older ones send a done
    // event whose session fields were all zero-valued and therefore stripped
    // by omitempty, so the renderer's own record of "this turn was a compact"
    // is the fallback that unsticks users without a binary update.
    //
    // Scoped to Codex on both sides. Claude keeps its CLI session across a
    // compact, and RunCompact reports "done" even when nothing was trimmed —
    // clearing the meter there would report a compaction that never happened.
    const chatProvider = this.app.getChatProvider?.(chat, this.app.modelProvider) || chat.provider;
    const contextReset = (msg.context_reset === true || options.contextReset === true)
      && chatProvider === 'codex';
    let shouldClearContextUsage = contextReset;
    if (contextReset) {
      chat.codexThreadId = null;
      chat.hasHistory = false;
      // The compact boundary: everything already on the timeline was
      // summarized away, so later turns stop re-sending it as reconstruction
      // context. Recorded only here — on a server-confirmed compact — never
      // from a `compaction` timeline item, which is also written for Codex's
      // internal auto-compaction and for compacts that failed.
      if (Array.isArray(chat.timeline)) {
        chat.codexCompactedTimelineIndex = chat.timeline.length;
      }
      changed = true;
    }
    if (msg.claude_session_id) {
      chat.claudeSessionId = msg.claude_session_id;
      chat.turnCheckpoints = msg.turn_checkpoints || {};
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(msg, 'codex_thread_id')) {
      chat.codexThreadId = msg.codex_thread_id || null;
      if (!msg.codex_thread_id && chatProvider === 'codex') {
        shouldClearContextUsage = true;
      }
      changed = true;
    } else if (msg.has_history === false && chat.codexThreadId) {
      // Codex compact/reset can intentionally clear the thread id.
      chat.codexThreadId = null;
      shouldClearContextUsage = true;
      changed = true;
    }
    if (typeof msg.has_history === 'boolean') {
      chat.hasHistory = msg.has_history;
      if (!msg.has_history) {
        shouldClearContextUsage = true;
      }
      changed = true;
    }
    if (shouldClearContextUsage) {
      // A compact must show its result immediately — the whole complaint is
      // that the meter never moves — so redraw rather than waiting for the
      // next turn's usage event.
      this.app.clearChatContextUsage(chat, { persist: false, rerender: contextReset });
      changed = true;
    }
    if (changed) {
      this.app.saveProjects();
      if (targetChatId) {
        this.app.chatSync?.scheduleChatCommit({ chatId: targetChatId, reason });
      }
    }
    return changed;
  }

  handle(msg) {
    if (DEBUG_WS) {
      let payloadChars = 0;
      try {
        payloadChars = JSON.stringify(msg)?.length || 0;
      } catch {
        // non-serializable payload — size unknown
      }
      console.log('Received:', msg?.type || '(untyped)', `~${payloadChars} chars`);
    }

    const rawSessionId = typeof msg.session_id === 'string' ? msg.session_id.trim() : '';
    const processingIds = this.app.store ? [...this.app.store.get('processingChatIds')] : [];
    // Prefer explicit routing; only fall back when exactly one session is active.
    const targetChatId = rawSessionId || (processingIds.length === 1 ? processingIds[0] : null);

    // Any stream traffic defers the processing-fallback spinner watchdog —
    // it should only fire during genuine dead air mid-turn.
    if (targetChatId) {
      this.app.statusManager?.noteStreamActivity?.(targetChatId);
    }

    // Check if user is currently viewing the target chat
    const isOnTargetChat = this.app.activeChat?.id === targetChatId;

    // Helper to find the target chat by session_id
    const getTargetChat = () => {
      if (!targetChatId) return null;
      for (const project of this.app.projects) {
        const chat = project.chats.find(c => c.id === targetChatId);
        if (chat) return chat;
      }
      return null;
    };

    const getTargetProvider = (chat) => {
      if (!chat) {
        return this.app.normalizeModelProvider(this.app.modelProvider);
      }
      return this.app.getChatProvider(chat, this.app.modelProvider);
    };

    const hasResolvablePlaytestTarget = () => {
      const resolved = this.app.playtestPanel?.resolveResultTarget?.(targetChatId);
      return !!(resolved?.panelId && resolved?.chatId);
    };

    const routeLatePlaytestResult = (text) => {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed || !hasResolvablePlaytestTarget()) return false;
      this.app.setPlaytestResult(trimmed, targetChatId);
      return true;
    };

    const isDuplicateOfLatestPlaytestResult = (text) => {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed || !hasResolvablePlaytestTarget()) return false;
      return trimmed === (this.app.playtestPanel?.getLatestResultMessage?.(targetChatId) || '');
    };

    // Temporarily disabled while the live Studio diagnostics feature is postponed.
    // if (this.isStudioDiagnosticsMessage(msg)) {
    //   this.handleStudioDiagnosticsMessage(msg, targetChatId);
    //   return;
    // }

    const ctx = {
      msg,
      targetChatId,
      isOnTargetChat,
      getTargetChat,
      getTargetProvider,
      hasResolvablePlaytestTarget,
      routeLatePlaytestResult,
      isDuplicateOfLatestPlaytestResult,
    };

    const handler = this.handlers[msg.type];
    if (handler) {
      handler.call(this, ctx);
    }
  }

  onRopilotActionsCost(ctx) {
    const { msg, targetChatId } = ctx;
    if (targetChatId) {
      const costMeta = this.app.getStoredTurnActionCostMeta?.(targetChatId);
      const balanceType = typeof costMeta?.actionCostBalanceType === 'string'
        ? costMeta.actionCostBalanceType.trim()
        : '';
      if (costMeta?.useRopilotCredits === true || balanceType === 'managed_ai_credits') {
        return;
      }
      const parsedCost = typeof msg.cost === 'number'
        ? msg.cost
        : Number(msg.cost);
      const nextCost = this.app.addTurnActionCost(targetChatId, parsedCost);
      if (nextCost > 0) {
        this.app.syncLatestTurnActionCost(targetChatId);
        this.app.settings?.applyOptimisticCharge?.(parsedCost);
      }
    }
    return;
  }

  onRopilotCreditsCost(ctx) {
    const { msg, targetChatId, getTargetChat } = ctx;
    if (targetChatId) {
      const content = this.parseContent(msg.content);
      const parsedCost = Number(
        msg.credits_charged
        ?? msg.creditsCharged
        ?? content?.credits_charged
        ?? content?.creditsCharged
      );
      if (Number.isFinite(parsedCost) && parsedCost < 0) {
        // Loop-guard waiver: the helper refunds the wasted tail of a stopped
        // turn and reports it as a negative delta. Correct the chip and the
        // optimistic balance; never let the turn total go below zero.
        this.applyManagedCreditsRefund(targetChatId, -parsedCost, Number(msg.message_index ?? content?.message_index), getTargetChat());
        return;
      }
      if (Number.isFinite(parsedCost) && parsedCost > 0) {
        const messageIndex = Number(msg.message_index ?? content?.message_index);
        const targetChat = getTargetChat();
        const currentMessageIndex = Array.isArray(targetChat?.timeline)
          ? targetChat.timeline.filter((item) => item?.type === 'user').length
          : 0;
        if (Number.isInteger(messageIndex) && messageIndex > 0 && messageIndex < currentMessageIndex) {
          // An async lookup for an earlier request can arrive after "done"
          // released a queued next turn. Apply it directly to the correlated
          // completed turn instead of contaminating the new turn's tally.
          const applied = this.app.messageRenderer?.addCompletedTurnActionCost?.(
            targetChatId,
            messageIndex,
            parsedCost,
            {
              actionCostLabel: 'Ropilot Credits',
              actionCostBalanceType: 'managed_ai_credits',
              useRopilotCredits: true,
            }
          );
          if (applied) {
            this.app.settings?.applyOptimisticCharge?.(parsedCost);
          } else {
            console.warn('Could not attach late managed credits cost to completed turn:', {
              session_id: targetChatId,
              message_index: messageIndex,
              credits_charged: parsedCost,
            });
          }
          return;
        }
        const costMeta = this.app.getStoredTurnActionCostMeta?.(targetChatId);
        const balanceType = typeof costMeta?.actionCostBalanceType === 'string'
          ? costMeta.actionCostBalanceType.trim()
          : '';
        const requestWasManaged = costMeta?.useRopilotCredits === true
          || balanceType === 'managed_ai_credits';
        const currentlyManagedMode = this.app.isUseRopilotCreditsEnabled?.() === true
          || this.app.useRopilotCredits === true;
        if (!requestWasManaged && !currentlyManagedMode) {
          console.warn('Ignoring managed credits cost event for non-managed turn:', {
            session_id: targetChatId,
            credits_charged: parsedCost,
          });
          return;
        }
        if (!requestWasManaged) {
          this.app.ensureManagedTurnActionCostMeta?.(targetChatId);
        }
        const nextCost = this.app.addTurnActionCost(targetChatId, parsedCost);
        if (nextCost > 0) {
          this.app.syncLatestTurnActionCost(targetChatId);
          this.app.settings?.applyOptimisticCharge?.(parsedCost);
        }
      }
    }
    return;
  }

  // A refund for a completed or running turn. Prefers the message-index
  // correlation (the waiver usually lands after "done"), then the live turn.
  applyManagedCreditsRefund(targetChatId, refund, messageIndex, targetChat) {
    if (!targetChatId || !Number.isFinite(refund) || refund <= 0) return false;
    const currentMessageIndex = Array.isArray(targetChat?.timeline)
      ? targetChat.timeline.filter((item) => item?.type === 'user').length
      : 0;
    let applied = false;
    if (Number.isInteger(messageIndex) && messageIndex > 0 && messageIndex < currentMessageIndex) {
      applied = this.app.messageRenderer?.addCompletedTurnActionCost?.(targetChatId, messageIndex, -refund, {
        actionCostLabel: 'Ropilot Credits',
        actionCostBalanceType: 'managed_ai_credits',
        useRopilotCredits: true,
      }) === true;
    } else {
      const nextCost = this.app.addTurnActionCost?.(targetChatId, -refund);
      applied = Number.isFinite(nextCost);
      if (applied) this.app.syncLatestTurnActionCost?.(targetChatId);
    }
    this.app.settings?.applyOptimisticCharge?.(-refund);
    return applied;
  }

  // Loop-guard refund outcome. Deliberately silent in the chat (operator
  // decision): the cost chip and balance are corrected by the negative
  // ropilot_credits_cost delta that accompanies this message; here we only
  // record it for the dashboard.
  onLoopWaiver(ctx) {
    const { msg, targetChatId, getTargetChat } = ctx;
    const content = this.parseContent(msg.content) || {};
    const waived = Number(content.waived_credits);
    const wasted = Number(content.wasted_requests);
    const total = Number(content.total_requests);
    const targetChat = getTargetChat();
    if (!targetChat) return;
    this.app.aiProviderAnalytics?.trackLoopWaiver?.({
      chatId: targetChatId,
      chat: targetChat,
      waivedCredits: waived,
      wastedRequests: wasted,
      totalRequests: total,
      guard: typeof content.guard === 'string' ? content.guard : '',
    });
  }

  onContextWindowUsage(ctx) {
    const { msg, targetChatId, getTargetChat } = ctx;
    {
      const targetChat = getTargetChat();
      if (!targetChat) return;
      const content = this.parseContent(msg.content);
      const usage = this.app.updateChatContextUsage(targetChat, content);
      if (targetChatId && usage) {
        this.app.updateCompactionProgressInChat(targetChatId, usage);
      }
    }
    return;
  }

  // The helper's dead-air watchdog ended the turn. Count it as a provider
  // failure so the Reliability page can see this class (it otherwise only
  // sees the plain "stream went silent" sentence as an error).
  onDeadAir(ctx) {
    const { msg, targetChatId } = ctx;
    if (!targetChatId) return;
    const content = this.parseContent(msg.content) || {};
    const budgetMs = Number(content.budget_ms) || 0;
    const openItems = Number(content.open_items) || 0;
    const reason = openItems > 0
      ? 'dead_air_open_item'
      : (content.awaiting_stream_retry ? 'dead_air_after_retry' : 'dead_air');
    this.app.aiProviderAnalytics?.trackProviderFail?.({
      chatId: targetChatId,
      source: 'dead_air_watchdog',
      reason,
      durationMs: Number(content.silence_ms) || undefined,
      thresholdMs: budgetMs || undefined,
      diagnostics: {
        ...content.diagnostics,
        budget_ms: budgetMs,
        silence_ms: Number(content.silence_ms),
        open_items: openItems,
        awaiting_stream_retry: content.awaiting_stream_retry === true,
        reasoning_level: content.reasoning_level,
      },
    });
  }

  onWorkingHint(ctx) {
    const { msg, targetChatId, isOnTargetChat } = ctx;
    {
      const content = this.parseContent(msg.content);
      const label = content?.label || 'Working';
      const detail = content?.detail || '';
      const command = typeof content?.command === 'string' ? content.command : '';

      if (targetChatId) {
        this.app.aiProviderAnalytics?.noteWorkingHint?.(targetChatId, { label, detail, command });
      }

      if (targetChatId && this.isCompactionWorkingHint(label, detail)) {
        if (isOnTargetChat) {
          this.app.hideStatus();
        } else {
          this.app.finalizeStatusInChat(targetChatId);
        }
        this.app.beginCompactionInChat(targetChatId);
        return;
      }

      if (targetChatId) {
        this.app.finalizeCompactionInChat(targetChatId);
      }

      // Keep the compact plan-mode status pill updated while planning is active.
      if (targetChatId) {
        this.app.planModeManager.handleWorkingHint(targetChatId, label, detail);
      }

      // Codex's turn-start hint is a bare "Thinking" label; while the detailed
      // Thinking block is streaming its summary, re-showing the generic pill
      // would read as a duplicate. Detailed hints (label + detail/command)
      // always pass through.
      if (label === 'Thinking' && !detail && !command && targetChatId
        && this.app.messageRenderer?.hasStreamingThinking?.(targetChatId)) {
        return;
      }

      if (isOnTargetChat) {
        this.app.showStatus(label, detail, command);
      } else if (targetChatId) {
        // Save status to target chat's timeline (no DOM) for when user switches back
        this.app.saveStatusToChat(targetChatId, label, detail, command);
      }
    }
    return;
  }

  onCommandOutput(ctx) {
    const { msg, targetChatId } = ctx;
    // Studio run-command result relayed by the MCP proxy — attach it as
    // an output drawer on the matching command-chip status row.
    if (targetChatId) {
      this.app.aiProviderAnalytics?.noteFirstOutput?.(targetChatId, 'command_output');
      this.app.statusManager.attachCommandOutput(targetChatId, msg.command, msg.output);
    }
    return;
  }

  onBlenderInstall(ctx) {
    // Ropilot's one-time Blender install: top-right progress notification.
    updateBlenderInstallToast(this.parseContent(ctx.msg.content));
    return;
  }

  onStudioRestartNeeded(ctx) {
    // Studio has to restart to pick up a setting Ropilot turned on: same
    // top-right notification as the Blender install.
    showStudioRestartToast(this.parseContent(ctx.msg.content));
    return;
  }

  // A screenshot the agent took (Studio viewport or Blender render) is shown
  // to the user right where it happened, as a visible message rather than a
  // folded work row. The image file is served by the local Go server.
  onChatImage(ctx) {
    const { msg, targetChatId, isOnTargetChat, getTargetChat } = ctx;
    if (!targetChatId || typeof msg?.path !== 'string' || !msg.path.trim()) return;
    const chat = getTargetChat();
    if (!chat) return;
    this.app.ensureTimelineForChat(chat);
    const item = {
      type: 'image',
      id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      path: msg.path.trim(),
      caption: typeof msg.caption === 'string' ? msg.caption.trim().slice(0, 200) : '',
      source: msg.source === 'blender' ? 'blender' : 'studio',
    };
    chat.timeline.push(item);
    this.app.projectManager?.markChatForFullUpdate?.(chat.id);
    this.app.saveChats();
    if (isOnTargetChat) {
      this.app.messageRenderer?.appendChatImageElement?.(item);
    }
    return;
  }

  onBlenderPreview(ctx) {
    const { msg, targetChatId } = ctx;
    // GLB snapshot relayed by the MCP proxy after a Blender tool call; the
    // turn's last one is shown at the bottom when the turn ends.
    if (targetChatId) {
      this.app.statusManager?.attachBlenderPreview?.(targetChatId, msg);
    }
    return;
  }

  onEmit(ctx) {
    const { msg, targetChatId, isOnTargetChat, getTargetChat, hasResolvablePlaytestTarget, routeLatePlaytestResult } = ctx;
    // Fallback emit from server (when no agent_text was streamed)
    let emitMessage = '';
    try {
      const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      emitMessage = content?.message || content?.text || JSON.stringify(content);
    } catch {
      emitMessage = String(msg.content || '');
    }
    emitMessage = this.tagClaudeUsageResetLine(emitMessage);
    if (targetChatId && emitMessage) {
      this.app.aiProviderAnalytics?.noteFirstOutput?.(targetChatId, 'emit');
      // Stream-disconnect errors can arrive via the emit fallback too —
      // count them (deduped per turn with the 'error' path marker).
      this.app.aiProviderAnalytics?.trackStreamClosedError?.(targetChatId, emitMessage);
    }

    const targetChatForEmit = getTargetChat();
    if (targetChatId) {
      this.app.finalizeCompactionInChat(targetChatId);
    }
    const handledSpecialEmitMessage = this.handleSpecialAssistantText(emitMessage, targetChatForEmit, isOnTargetChat);
    if (handledSpecialEmitMessage) {
      if (targetChatId) {
        this.app.planModeManager.handleAssistantOutput(targetChatId, emitMessage);
      }
      if (isOnTargetChat) {
        this.app.hideStatus();
      } else if (targetChatId) {
        this.app.finalizeStatusInChat(targetChatId);
      }
      return;
    }

    if (this.app.isPlaytestActive() || hasResolvablePlaytestTarget()) {
      // Playtest is active - this emit goes to the playtest panel as the subagent's result
      console.log('[EMIT] Playtest active - routing to playtest panel');
      try {
        routeLatePlaytestResult(emitMessage);
      } catch (e) {
        console.error('[EMIT] Failed to parse emit for playtest:', e);
      }
    } else {
      // No playtest - add to chat as normal
      this.app.addEmitMessageToChat({ message: emitMessage }, getTargetChat());
      if (targetChatId) {
        this.app.planModeManager.handleAssistantOutput(targetChatId, emitMessage);
      }
    }
    // Hide loading/thinking status when we receive the actual user-facing response
    if (isOnTargetChat) {
      this.app.hideStatus();
    }
    return;
  }

  onError(ctx) {
    const { msg, targetChatId, isOnTargetChat, getTargetChat, getTargetProvider } = ctx;
    // Handle error from Go server (msg.content.message) or direct error (msg.error)
    let errorText = msg.error || '';
    if (msg.content) {
      try {
        const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        errorText = content.message || content.error || errorText;
      } catch {
        errorText = String(msg.content);
      }
    }
    const targetChatForError = getTargetChat();
    if (targetChatId && errorText) {
      this.app.aiProviderAnalytics?.noteFirstOutput?.(targetChatId, 'error');
      this.app.aiProviderAnalytics?.trackStreamClosedError?.(targetChatId, errorText);
    }
    // App-server failures can carry appended debug innards (stderr tail with
    // timestamped rust log lines). Show only the human sentence; the full
    // text is preserved in the console by stripAppServerDebugNoise.
    errorText = this.stripAppServerDebugNoise(errorText);
    const targetProvider = getTargetProvider(targetChatForError);
    const targetModel = this.app.normalizeSelectedModel(targetChatForError?.model || this.app.selectedModel);
    const isExpiredClaudeOAuthError = targetProvider === 'claude'
      && this.canShowLocalProviderAuthCta('claude', targetChatForError)
      && this.isExpiredClaudeOAuthError(errorText);
    const isClaudeLoginRequiredError = this.isClaudeActionsAuthMessage(targetChatForError, targetProvider, errorText);
    const isCodexAuthError = targetProvider === 'codex' && this.isCodexAuthError(errorText);
    const isInvalidAuthCredentialsError = this.isInvalidAuthenticationCredentialsError(errorText);
    const invalidAuthProvider = isInvalidAuthCredentialsError
      ? this.getAuthCtaProvider(targetChatForError, targetProvider)
      : undefined;
    const shouldShowInvalidAuthCta = isInvalidAuthCredentialsError
      && this.canShowLocalProviderAuthCta(invalidAuthProvider, targetChatForError);
    const hasRefreshTokenText = this.hasRefreshTokenPhrase(errorText);
    const refreshTokenAuthProvider = hasRefreshTokenText
      ? this.getAuthCtaProvider(targetChatForError, targetProvider)
      : undefined;
    const shouldShowRefreshTokenCta = hasRefreshTokenText
      && this.canShowLocalProviderAuthCta(refreshTokenAuthProvider, targetChatForError);
    const isCreditLimitError = targetProvider === 'claude' && this.isCreditLimitMessage(errorText);
    const isRopilotCreditsLimitError = this.isRopilotCreditsLimitMessage(errorText);
    const isRopilotEconomyRouteFailure = this.isRopilotEconomyRouteFailedMessage(errorText);
    const isStalePlanModeResponseError = this.isStalePlanModeResponseError(errorText);
    const isCodexCliMissingError = this.isCodexCliMissingError(errorText);
    // Go server's classified message for a natively-crashing CLI binary
    // (0xC… NTSTATUS exits — corrupted install/auto-update).
    const isClaudeCliCrashError = /crashing on launch \(exit status 0xc0[0-9a-f]+\)/i.test(errorText || '');
    const isCodexPlusUpgradeLimitError = targetProvider === 'codex'
      && this.isCodexPlusUpgradeLimitMessage(errorText);
    const shouldOfferCodexPlanRetry = targetProvider === 'codex'
      && this.isCodexPlanRestrictedModelError(errorText);
    const isOpus1MModel = targetModel === 'claude-opus-5-5[1m]' || targetModel === 'claude-fable-5-1[1m]';
    const shouldShowClaude1MNote = targetProvider === 'claude'
      && isOpus1MModel
      && this.isClaudeOpus1MRateLimitMessage(errorText);
    if (isCodexCliMissingError) {
      errorText = CODEX_SETUP_MISSING_MESSAGE;
    } else if (isExpiredClaudeOAuthError || isClaudeLoginRequiredError) {
      errorText = this.ensureClaudeAuthErrorPrefix(errorText);
    } else if (isCodexAuthError || (shouldShowInvalidAuthCta && invalidAuthProvider === 'codex')) {
      errorText = this.ensureCodexAuthErrorPrefix(errorText);
    }
    // Check if this is a quota/credits error
    if (errorText && isStalePlanModeResponseError) {
      if (targetChatId) {
        this.app.planModeManager?.handlePlanModeResponseDesynced?.(targetChatId);
      }
      if (isOnTargetChat) {
        this.app.hideStatus();
      }
    } else if (errorText && isCodexPlusUpgradeLimitError) {
      this.showCodexPlusUpgradeCreditsModal(errorText);
      if (isOnTargetChat) {
        this.app.hideStatus();
      }
    } else if (errorText && isRopilotEconomyRouteFailure) {
      this.app.aiProviderAnalytics?.trackProviderFail?.({
        chatId: targetChatId,
        chat: targetChatForError,
        source: 'route_failure_message',
        reason: 'standard_route_unavailable',
        errorText,
      });
      this.app.addErrorMessageToChat(this.formatRopilotEconomyRouteFailureMessage(errorText), targetChatForError, isOnTargetChat, {
        noteTitle: '[Note from Ropilot]',
        ...this.buildRopilotEconomyRouteFailureNoteOptions(targetChatForError, targetProvider),
        cta: 'retry_ropilot_credits_route',
      });
    } else if (errorText && isRopilotCreditsLimitError) {
      // The gateway's structured 402 marker is authoritative: when present,
      // the balance really is exhausted (a mid-turn drain leaves the cached
      // snapshot stale-high, so the false-positive suppression must not
      // apply). Show the purchase CTA, never the raw error dump.
      const hasStructuredCreditsMarker = this.isRopilotCreditsRequiredMarker(errorText);
      if (!hasStructuredCreditsMarker && this.shouldSuppressRopilotCreditsWall()) {
        // Managed balance is healthy — this "out of credits" error is a
        // false positive. Surface it as an ordinary error instead of
        // walling (and swallowing) it.
        this.noteSuppressedRopilotCreditsWall();
        this.app.addErrorMessageToChat(errorText, targetChatForError, isOnTargetChat);
      } else if (this.isRopilotCreditsWallDismissedForCurrentTurn()) {
        // User dismissed the wall for this turn — show the (cleaned) error
        // rather than silently dropping it.
        this.app.addErrorMessageToChat(errorText, targetChatForError, isOnTargetChat);
      } else {
        this.showRopilotCreditsLimitModal();
        if (isOnTargetChat) {
          this.app.hideStatus();
        }
      }
    } else if (errorText && isCreditLimitError) {
      const formattedCreditError = this.formatClaudeCreditLimitMessage(errorText);
      this.app.addErrorMessageToChat(formattedCreditError, targetChatForError, isOnTargetChat);
    } else if (errorText) {
      const displayErrorText = shouldOfferCodexPlanRetry
        ? this.sanitizeCodexPlanRestrictedMessage(errorText)
        : errorText;
      // Save error to target chat's timeline (addErrorMessageToChat handles DOM-only-if-active)
      this.app.addErrorMessageToChat(displayErrorText, targetChatForError, isOnTargetChat, {
        noteTitle: shouldShowClaude1MNote || shouldOfferCodexPlanRetry ? '[Note from Ropilot]' : undefined,
        noteMessage: shouldShowClaude1MNote
          ? CLAUDE_OPUS_1M_NOTE
          : shouldOfferCodexPlanRetry
            ? CODEX_PLAN_RETRY_NOTE
            : undefined,
        cta: isClaudeCliCrashError
          ? 'reinstall_claude_cli'
          : isCodexCliMissingError
            ? 'return_to_provider_setup'
            : shouldOfferCodexPlanRetry
              ? 'switch_to_gpt56terra_codex_and_retry'
              : undefined,
        ctaProvider: isCodexCliMissingError ? 'codex' : undefined,
        showReturnToLogin: isExpiredClaudeOAuthError || isClaudeLoginRequiredError || isCodexAuthError || shouldShowInvalidAuthCta || shouldShowRefreshTokenCta,
        returnToLoginProvider: isExpiredClaudeOAuthError || isClaudeLoginRequiredError || isCodexAuthError || shouldShowInvalidAuthCta || shouldShowRefreshTokenCta
          ? (shouldShowInvalidAuthCta ? invalidAuthProvider : shouldShowRefreshTokenCta ? refreshTokenAuthProvider : this.getAuthCtaProvider(targetChatForError, targetProvider))
          : undefined
      });
    }
    if (isOnTargetChat) {
      this.app.hideStatus();
    } else if (targetChatId) {
      // User is on different chat - finalize status in target chat's timeline
      this.app.finalizeStatusInChat(targetChatId);
    }
    if (targetChatId) {
      this.app.finalizeCompactionInChat(targetChatId);
      this.app.messageRenderer?.finalizeThinkingInChat?.(targetChatId);
    }
    // A failed compact did not reset anything; drop the record so a later
    // unrelated turn cannot inherit it.
    this.app.messageSender?.consumePendingCodexCompact?.(targetChatId);
    this.persistProviderSessionState(msg, targetChatForError, targetChatId, 'turn_error');
    // Stop processing for this specific chat
    if (targetChatId) {
      this.app.ttfwAnalytics?.finishTurn(targetChatId);
      this.app.aiProviderAnalytics?.finishTurn?.(targetChatId);
      this.app.cancelTurnActionCost(targetChatId);
      this.app.stopProcessingChat(targetChatId);
      this.app.planModeManager.handleSessionFinished(targetChatId, 'error');
      this.app.messageSender.clearStopPending(targetChatId);
    }
    // Clear playtest state on error (prevents stuck state)
    this.app.clearPlaytestState('error');
    this.app.updateSendButton();
    this.app.renderProjectList();
    this.app.messageRenderer?.collapseFinishedTurn?.(targetChatId);
    // Process next queued message if any (even after error)
    this.app.messageSender.processNextQueued(targetChatId);
    return;
  }

  onSteerAccepted(ctx) {
    this.app.messageSender?.handleSteerAccepted?.(ctx.msg);
  }

  onSteerRejected(ctx) {
    const { msg, getTargetChat, isOnTargetChat } = ctx;
    const result = this.app.messageSender?.handleSteerRejected?.(msg);
    if (result?.queued || result?.duplicate) return;

    // A steer rejection is scoped to the attempted input, not the parent
    // request. Report non-retriable failures without ending that request.
    const errorText = typeof msg.error === 'string' ? msg.error.trim() : '';
    if (errorText) {
      this.app.addErrorMessageToChat(errorText, getTargetChat(), isOnTargetChat);
    }
  }

  onDone(ctx) {
    const { msg, targetChatId, isOnTargetChat, getTargetChat } = ctx;
    // Claude is done - hide status and reset processing state
    if (isOnTargetChat) {
      this.app.hideStatus();
    } else if (targetChatId) {
      // User is on different chat - finalize status in target chat's timeline
      this.app.finalizeStatusInChat(targetChatId);
    }
    if (targetChatId) {
      this.app.finalizeCompactionInChat(targetChatId);
      this.app.messageRenderer?.finalizeThinkingInChat?.(targetChatId);
      this.app.statusManager?.flushBlenderPreview?.(targetChatId);
    }
    const compactCompleted = this.app.messageSender?.consumePendingCodexCompact?.(targetChatId) === true;
    this.persistProviderSessionState(msg, getTargetChat(), targetChatId, 'turn_done', {
      contextReset: compactCompleted,
    });
    // Capture the turn duration before stopProcessingChat clears the
    // start timestamp — it renders on the cost line ("· 1m24s").
    const turnStartedAt = targetChatId
      ? Number(this.app.processingStartedAt?.get(targetChatId) || 0)
      : 0;
    // Stop processing for this specific chat
    if (targetChatId) {
      this.app.ttfwAnalytics?.finishTurn(targetChatId);
      this.app.aiProviderAnalytics?.finishTurn?.(targetChatId);
      this.app.stopProcessingChat(targetChatId);
      // A turn that completed without another degeneration stop closes the
      // recovery streak — a future degeneration earns a fresh auto-retry.
      this.settleDegenerationRetry(targetChatId);
      this.app.planModeManager.handleSessionFinished(targetChatId, 'done');
      this.app.messageSender.clearStopPending(targetChatId);
    }
    this.app.clearPlaytestState('done');
    this.app.updateSendButton();
    this.app.renderProjectList();
    if (targetChatId) {
      void this.app.taskNotificationManager?.notifyTaskCompleted(targetChatId);
    }
    // The per-turn cost chip renders immediately from the charge events
    // accumulated during the turn (never from balance deltas — those are
    // shared across chats and would misattribute concurrent turns), and
    // the message queue is released right away. Nothing here waits on
    // the network.
    if (targetChatId) {
      const totalCost = this.app.completeTurnActionCost(targetChatId);
      if (totalCost > 0) {
        this.app.syncLatestTurnActionCost(
          targetChatId,
          turnStartedAt > 0 ? Date.now() - turnStartedAt : null
        );
      }
    }
    // Fold the finished turn's work behind "Worked for …" before a queued
    // message starts the next one.
    this.app.messageRenderer?.collapseFinishedTurn?.(targetChatId);
    this.app.messageSender.processNextQueued(targetChatId);

    // Background refresh reconciles the optimistically-decremented
    // balance counter with the authoritative server value.
    void this.app.settings.refreshActions().catch((err) => {
      console.warn('Post-turn balance refresh failed:', err?.message || err);
    });
    return;
  }

  onStopped(ctx) {
    const { msg, targetChatId, isOnTargetChat, getTargetChat } = ctx;
    // User stopped the inference
    console.log('[STOPPED] Inference stopped by user');
    if (isOnTargetChat) {
      this.app.hideStatus();
      // Hide playtest panel if active
      const playtestPanel = document.querySelector('.playtest-panel');
      if (playtestPanel) {
        playtestPanel.classList.add('stopped');
        const statusText = playtestPanel.querySelector('.playtest-status-text');
        if (statusText) statusText.textContent = 'Stopped';
      }
    } else if (targetChatId) {
      // Match done/error: the background chat has no live DOM status to hide,
      // so finalize its persisted headline/status before the user returns.
      this.app.finalizeStatusInChat(targetChatId);
    }
    if (targetChatId) {
      this.app.finalizeCompactionInChat(targetChatId);
      this.app.messageRenderer?.finalizeThinkingInChat?.(targetChatId);
      this.app.statusManager?.flushBlenderPreview?.(targetChatId);
    }
    this.app.messageSender?.consumePendingCodexCompact?.(targetChatId);
    this.persistProviderSessionState(msg, getTargetChat(), targetChatId, 'turn_stopped');
    // Stop processing for this specific chat
    if (targetChatId) {
      this.app.ttfwAnalytics?.finishTurn(targetChatId);
      this.app.aiProviderAnalytics?.finishTurn?.(targetChatId);
      this.app.cancelTurnActionCost(targetChatId);
      this.app.stopProcessingChat(targetChatId);
      // Manual stop is user intervention: settle the recovery streak.
      this.settleDegenerationRetry(targetChatId);
      this.app.planModeManager.handleSessionFinished(targetChatId, 'stopped');
      this.app.messageSender.clearStopPending(targetChatId);
    }
    this.app.clearPlaytestState('stopped');
    // A user Stop while the credits wall is visible must also halt the
    // wall's auto-resume — before this, stopping just unblocked the
    // watcher's next tick (isChatProcessing went false) and re-sent the
    // prompt.
    if (isOnTargetChat) {
      this.app.creditsWall?.handleUserStop?.();
    }
    this.app.updateSendButton();
    this.app.renderProjectList();
    this.app.updateQueueIndicator();
    this.app.messageRenderer?.collapseFinishedTurn?.(targetChatId);
    this.app.messageSender.processNextQueued(targetChatId);
    return;
  }

  onScriptDiff(ctx) {
    const { msg, targetChatId, isOnTargetChat, getTargetChat } = ctx;
    // Assistant produced a diff - don't confirm pending message yet, wait for 'done'
    console.log('[SCRIPT_DIFF] Received:', {
      path: msg.path,
      localPath: msg.localPath,
      fileName: msg.fileName,
      hasOriginalContent: msg.originalContent !== undefined,
      originalContentLen: msg.originalContent?.length || 0,
      hasEditedContent: msg.editedContent !== undefined,
      editedContentLen: msg.editedContent?.length || 0,
      chatMessageIndex: msg.chatMessageIndex
    });
    if (targetChatId) {
      this.app.ttfwAnalytics?.noteFirstWrite(targetChatId, {
        isFileSync: !!msg.isFileSync
      });
      this.app.aiProviderAnalytics?.noteFirstOutput?.(targetChatId, 'script_diff');
    }
    // Store diff in the processing chat and only update UI if still on that chat
    this.app.showDiffPreviewToChat(msg, getTargetChat(), isOnTargetChat);
    return;
  }

  onPathMapping(ctx) {
    const { msg, getTargetChat } = ctx;
    // Store path mapping in the target chat (even if user switched away)
    const targetChat = getTargetChat();
    if (targetChat && msg.localPath && msg.gamePath) {
      if (!targetChat.pathMappings) {
        targetChat.pathMappings = {};
      }
      targetChat.pathMappings[msg.localPath] = msg.gamePath;
      // Also store scriptType for icon display
      if (!targetChat.scriptTypes) {
        targetChat.scriptTypes = {};
      }
      targetChat.scriptTypes[msg.gamePath] = msg.scriptType;
      console.log('[PATH_MAPPING] Stored:', msg.localPath, '->', msg.gamePath, '(type:', msg.scriptType, ')');
      // Persist to localStorage and edge
      this.app.saveChats();
    }
    return;
  }

  onSourcecontrolState(ctx) {
    const { msg, getTargetChat } = ctx;
    {
      const scopedChat = getTargetChat();
      if (!scopedChat || !msg.scriptPath) return;

      if (!scopedChat.sourcecontrolState) {
        scopedChat.sourcecontrolState = {};
      }

      if (msg.action === 'delete') {
        delete scopedChat.sourcecontrolState[msg.scriptPath];
      } else if (msg.mapping && typeof msg.mapping === 'object') {
        scopedChat.sourcecontrolState[msg.scriptPath] = msg.mapping;
      }

      this.app.saveChats();
    }
    return;
  }

  onSettingsUpdate(ctx) {
    const { msg } = ctx;
    {
      const settingsValues = msg.settingsValues || msg.settings;
      if (settingsValues && typeof settingsValues === 'object') {
        this.app.settings.applySettingsValues(settingsValues, 'edge_ws');
        console.log('[SETTINGS] Applied settings_update from edge websocket:', settingsValues);
      }
    }
    return;
  }

  onPlaytestEvent(ctx) {
    const { msg, targetChatId } = ctx;
    // Handle playtest start/stop
    console.log('[PLAYTEST] Received playtest_event:', JSON.stringify(msg));
    console.log('[PLAYTEST] msg.event value:', msg.event, 'type:', typeof msg.event);
    if (msg.event === 'start') {
      console.log('[PLAYTEST] Calling showPlaytestPanel() for chat:', targetChatId);
      this.app.showPlaytestPanel(targetChatId);
      console.log('[PLAYTEST] showPlaytestPanel() returned');
    } else if (msg.event === 'stop') {
      console.log('[PLAYTEST] Calling hidePlaytestPanel()...');
      // Pass the final subagent message to display in the modal
      const stopMessage = typeof msg.message === 'string'
        ? this.tagClaudeUsageResetLine(msg.message)
        : msg.message;
      this.app.hidePlaytestPanel(stopMessage);
    } else {
      console.log('[PLAYTEST] Unknown event type, not start or stop!');
    }
    return;
  }

  onPlaytestScript(ctx) {
    const { msg, targetChatId } = ctx;
    // Add executed script to playtest panel
    console.log('[PLAYTEST] Received playtest_script:', msg.runContext, 'code length:', msg.code?.length);
    this.app.addPlaytestScript(msg.scriptId, msg.runContext, msg.code, targetChatId);
    return;
  }

  onPlaytestScriptUpdate(ctx) {
    const { msg, targetChatId } = ctx;
    console.log('[PLAYTEST] Received playtest_script_update:', msg.scriptId, 'screenshots:', msg.screenshots?.length || 0);
    this.app.addPlaytestScriptScreenshots(msg.scriptId, msg.screenshots, targetChatId);
    return;
  }

  onPlaytestResult(ctx) {
    const { msg, targetChatId } = ctx;
    // Subagent's final response - update the playtest panel with the real result
    // Parse content which contains {message: "..."}
    try {
      const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      const resultMessage = this.tagClaudeUsageResetLine(content?.message || msg.message);
      console.log('[PLAYTEST] Received playtest_result:', resultMessage?.substring(0, 100));
      if (typeof resultMessage === 'string' && resultMessage.trim()) {
        this.app.aiProviderAnalytics?.noteFirstOutput?.(targetChatId, 'playtest_result');
      }
      this.app.setPlaytestResult(resultMessage, targetChatId);
    } catch (e) {
      console.error('[PLAYTEST] Failed to parse playtest_result:', e);
      const fallbackMessage = this.tagClaudeUsageResetLine(msg.message);
      if (typeof fallbackMessage === 'string' && fallbackMessage.trim()) {
        this.app.aiProviderAnalytics?.noteFirstOutput?.(targetChatId, 'playtest_result');
      }
      this.app.setPlaytestResult(fallbackMessage, targetChatId);
    }
    return;
  }

  onSubagentText(ctx) {
    const { msg, targetChatId, isOnTargetChat, getTargetChat, hasResolvablePlaytestTarget, routeLatePlaytestResult } = ctx;
    // Subagent (haiku) streaming text - suppress during playtest (final summary arrives via playtest_result)
    {
      let text = '';
      try {
        const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        text = content?.text || '';
      } catch {
        text = String(msg.content);
      }
      text = this.tagClaudeUsageResetLine(text);
      if (text) {
        this.app.aiProviderAnalytics?.noteFirstOutput?.(targetChatId, 'subagent_text');
        if (this.app.isPlaytestActive() || hasResolvablePlaytestTarget()) {
          routeLatePlaytestResult(text);
          console.log('[SUBAGENT_TEXT] Routing to playtest panel:', text.substring(0, 100));
        } else {
          const targetChatForSubagent = getTargetChat();
          if (targetChatId) {
            this.app.finalizeCompactionInChat(targetChatId);
          }
          const handledSpecialSubagentMessage = this.handleSpecialAssistantText(text, targetChatForSubagent, isOnTargetChat);
          if (handledSpecialSubagentMessage) {
            if (targetChatId) {
              this.app.planModeManager.handleAssistantOutput(targetChatId, text);
            }
            if (isOnTargetChat) {
              this.app.hideStatus();
            } else if (targetChatId) {
              this.app.finalizeStatusInChat(targetChatId);
            }
            return;
          }
          // Save to target chat's timeline (addAgentTextMessage handles DOM-only-if-active)
          this.app.addAgentTextMessage(text, targetChatForSubagent);
          if (targetChatId) {
            this.app.planModeManager.handleAssistantOutput(targetChatId, text);
          }
          // Agent text means tool call is done — finalize active status
          if (isOnTargetChat) {
            this.app.hideStatus();
          } else if (targetChatId) {
            this.app.finalizeStatusInChat(targetChatId);
          }
        }
      }
    }
    return;
  }

  onAgentText(ctx) {
    const { msg, targetChatId, isOnTargetChat, getTargetChat, isDuplicateOfLatestPlaytestResult } = ctx;
    // Agent thinking/intermediate text response - shown as regular assistant messages
    // Always save to target chat's timeline (addAgentTextMessage handles DOM-only-if-active)
    {
      let text = '';
      try {
        const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        text = content?.text || '';
      } catch {
        text = String(msg.content);
      }
      text = this.tagClaudeUsageResetLine(text);
      if (text) {
        this.app.aiProviderAnalytics?.noteFirstOutput?.(targetChatId, 'agent_text');
        // Codex error items surface as agent text (not 'error' messages) —
        // without this, stream disconnects on that path are never counted.
        if (targetChatId) {
          this.app.aiProviderAnalytics?.trackStreamClosedError?.(targetChatId, text);
        }
        if (isDuplicateOfLatestPlaytestResult(text)) {
          console.log('[AGENT_TEXT] Suppressing duplicate playtest result:', text.substring(0, 100));
          if (isOnTargetChat) {
            this.app.hideStatus();
          } else if (targetChatId) {
            this.app.finalizeStatusInChat(targetChatId);
          }
          return;
        }
        const targetChatForAgent = getTargetChat();
        if (targetChatId) {
          this.app.finalizeCompactionInChat(targetChatId);
        }
        const handledSpecialAgentMessage = this.handleSpecialAssistantText(text, targetChatForAgent, isOnTargetChat);
        if (handledSpecialAgentMessage) {
          if (targetChatId) {
            this.app.planModeManager.handleAssistantOutput(targetChatId, text);
          }
          if (isOnTargetChat) {
            this.app.hideStatus();
          } else if (targetChatId) {
            this.app.finalizeStatusInChat(targetChatId);
          }
          return;
        }

        this.app.addAgentTextMessage(text, targetChatForAgent);
        if (targetChatId) {
          this.app.planModeManager.handleAssistantOutput(targetChatId, text);
        }
        // Agent text means tool call is done — finalize active status
        if (isOnTargetChat) {
          this.app.hideStatus();
        } else if (targetChatId) {
          this.app.finalizeStatusInChat(targetChatId);
        }
      }
    }
    return;
  }

  onThinking(ctx) {
    const { msg, targetChatId, getTargetChat } = ctx;
    // Codex public reasoning summary (never private chain-of-thought). Each
    // update carries the authoritative cumulative text for one summary part;
    // the renderer updates the block in place. Malformed or unknown payload
    // shapes are dropped harmlessly.
    if (!targetChatId || !getTargetChat()) return;
    const update = normalizeThinkingContent(this.parseContent(msg.content));
    if (!update) return;
    this.app.aiProviderAnalytics?.noteFirstOutput?.(targetChatId, 'thinking');
    this.app.messageRenderer?.upsertThinkingInChat?.(targetChatId, update);
  }

  onPlanModeEnter(ctx) {
    const { targetChatId } = ctx;
    if (this.app.planModeEnabled && targetChatId) {
      this.app.planModeManager.handlePlanModeEnter(targetChatId);
    }
    return;
  }

  onAskUserQuestion(ctx) {
    const { msg, targetChatId } = ctx;
    if (this.app.planModeEnabled && targetChatId) {
      const content = this.parseContent(msg.content);
      this.app.planModeManager.handleAskUserQuestion(
        targetChatId,
        msg.tool_use_id,
        content?.questions || []
      );
    }
    return;
  }

  onPlanModeExit(ctx) {
    const { msg, targetChatId } = ctx;
    if (this.app.planModeEnabled && targetChatId) {
      const content = this.parseContent(msg.content);
      this.app.planModeManager.handlePlanModeExit(targetChatId, content?.plan_text || '');
    }
    return;
  }

  handleText(msg) {
    let text = '';

    if (msg.content) {
      try {
        const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        text = content.text || content.message || JSON.stringify(content);
      } catch {
        text = String(msg.content);
      }
    }

    text = this.tagClaudeUsageResetLine(text);

    if (text) {
      const activeChat = this.app.store?.getActiveChat ? this.app.store.getActiveChat() : this.app.activeChat;
      if (activeChat?.id) {
        this.app.finalizeCompactionInChat(activeChat.id);
      }
      const handledSpecialTextMessage = this.handleSpecialAssistantText(text, activeChat, true);
      if (handledSpecialTextMessage) {
        return;
      }
      this.app.addAssistantMessage(text);
    }
  }

  handleWorkingHint(msg) {
    console.log('handleWorkingHint received:', msg);
    try {
      const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      if (!content) {
        console.log('handleWorkingHint: content is null/undefined');
        return;
      }
      const label = content.label || 'Working';
      const detail = content.detail || '';
      if (this.isCompactionWorkingHint(label, detail)) {
        if (this.app.activeChat?.id) {
          this.app.hideStatus();
          this.app.beginCompactionInChat(this.app.activeChat.id);
        }
        return;
      }
      console.log('handleWorkingHint: showing status', label, detail);
      this.app.showStatus(label, detail);
    } catch (e) {
      console.error('handleWorkingHint error:', e, 'msg:', msg);
    }
  }

  isCompactionWorkingHint(label, detail) {
    const normalizedLabel = this.normalizeDetectionText(label || '');
    if (!normalizedLabel) return false;
    if (!normalizedLabel.startsWith('compact')) return false;
    const normalizedDetail = this.normalizeDetectionText(detail || '');
    return normalizedDetail.length === 0 || normalizedDetail.includes('conversation');
  }

  parseContent(content) {
    if (content === null || content === undefined) return null;
    try {
      return typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      return null;
    }
  }

  tagClaudeUsageResetLine(text) {
    if (typeof text !== 'string' || text.length === 0) return text;

    let changed = false;
    const taggedLines = text.split('\n').map((line) => {
      const trimmed = line.trimStart();
      if (!CLAUDE_RESET_LINE_PATTERN.test(trimmed)) return line;

      let tagged = trimmed;
      if (!tagged.startsWith(CLAUDE_USAGE_PREFIX)) {
        tagged = `${CLAUDE_USAGE_PREFIX} ${tagged}`;
      }
      if (!tagged.includes(CLAUDE_USAGE_SUFFIX)) {
        tagged = `${tagged} ${CLAUDE_USAGE_SUFFIX}`;
      }

      changed = true;
      const leadingWhitespace = line.slice(0, line.length - trimmed.length);
      return `${leadingWhitespace}${tagged}`;
    });

    return changed ? taggedLines.join('\n') : text;
  }

  isExpiredClaudeOAuthError(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;
    const hasAuth401 = /failed to authenticate\.\s*api error:?\s*401/.test(normalized);
    const hasExpiredOAuth = /oauth token has expired\.\s*please obtain a new token or refresh your existing token\.?/.test(normalized);
    const hasExpiredOAuthSession = normalized.includes('oauth session expired')
      && normalized.includes('could not be refreshed');
    const hasInvalidCredentials = this.isInvalidAuthenticationCredentialsError(text);
    const hasSocketClosedAuth = normalized.includes('socket connection was closed unexpectedly');
    const hasClaudePrefix = normalized.startsWith(this.normalizeDetectionText(CLAUDE_AUTH_ERROR_PREFIX));
    // Anthropic answers a stale/detached OAuth session with 403 "Unable to
    // verify organization membership", not 401. Without this the error falls
    // through every auth classifier and renders with no "Return to login" CTA,
    // leaving the user stuck. Kept deliberately narrow — matched only together
    // with that exact phrasing, because ordinary 403s (reseller quota walls,
    // policy blocks) must NOT be classified as auth failures.
    const hasOrgMembership403 = /\b403\b/.test(normalized)
      && normalized.includes('unable to verify organization membership');
    return hasExpiredOAuthSession
      || hasOrgMembership403
      || (hasAuth401 && (hasExpiredOAuth || hasSocketClosedAuth || (hasClaudePrefix && hasInvalidCredentials)));
  }

  isManagedCreditsAuthMode(targetChat) {
    return this.app.isUseRopilotCreditsEnabled?.() === true
      || this.app.useRopilotCredits === true
      || targetChat?.useRopilotCredits === true
      || targetChat?.use_ropilot_credits === true;
  }

  canShowLocalProviderAuthCta(provider, targetChat) {
    const normalized = this.app.normalizeModelProvider?.(provider) || provider;
    if (normalized === 'claude' && this.isManagedCreditsAuthMode(targetChat)) return false;
    return true;
  }

  isClaudeActionsAuthMessage(targetChat, targetProvider, text) {
    if (targetProvider !== 'claude') return false;
    if (!this.canShowLocalProviderAuthCta('claude', targetChat)) return false;
    return this.isClaudeLoginRequiredMessage(text);
  }

  isClaudeLoginRequiredMessage(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;
    return normalized.includes('not logged in') && normalized.includes('please run /login')
      || normalized.includes('/login isn') && normalized.includes('available in this environment');
  }

  ensureClaudeAuthErrorPrefix(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    return text.startsWith(CLAUDE_AUTH_ERROR_PREFIX) ? text : `${CLAUDE_AUTH_ERROR_PREFIX} ${text}`;
  }

  isCodexAuthError(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;

    if (normalized.includes('codex cli installed but not logged in')) return true;
    if (normalized.includes('run: codex login')) return true;
    if (normalized.includes('failed to authenticate. api error: 401 invalid authentication credentials')) return true;
    if (normalized.includes('invalid authentication credentials')) return true;
    if (normalized.includes('authentication failed')) return true;

    const has401 = /\b401\b/.test(normalized);
    const hasAuthTerm = normalized.includes('authenticate')
      || normalized.includes('authentication')
      || normalized.includes('credential')
      || normalized.includes('unauthorized')
      || normalized.includes('unauthorised');
    return has401 && hasAuthTerm;
  }

  isCodexCliMissingError(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;
    return normalized.includes('codex cli not found')
      || normalized.includes('missing optional dependency @openai/codex')
      || normalized.includes('reinstall codex:');
  }

  isInvalidAuthenticationCredentialsError(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;
    const has401 = /\b401\b/.test(normalized);
    const hasFailedAuth = normalized.includes('failed to authenticate')
      || normalized.includes('authentication_error')
      || normalized.includes('authentication error');
    const hasInvalidCredentials = normalized.includes('invalid authentication credentials')
      || normalized.includes('invalid credentials');
    return has401 && hasFailedAuth && hasInvalidCredentials;
  }

  getAuthCtaProvider(targetChat, fallbackProvider) {
    const normalizeKnownProvider = (provider) => {
      const value = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
      if (value === 'codex' || value === 'openai') return 'codex';
      if (value === 'claude' || value === 'anthropic') return 'claude';
      return '';
    };

    const model = targetChat?.model || this.app.selectedModel;
    if (typeof this.app.getProviderForModel === 'function') {
      const providerForModel = normalizeKnownProvider(this.app.getProviderForModel(model));
      if (providerForModel) return providerForModel;
    }

    const selectedModel = typeof model === 'string' ? model.trim().toLowerCase() : '';
    if (selectedModel.startsWith('gpt-') || selectedModel.includes('codex')) return 'codex';
    if (
      selectedModel.includes('claude') ||
      selectedModel.includes('opus') ||
      selectedModel.includes('sonnet') ||
      selectedModel.includes('haiku') ||
      selectedModel.includes('fable')
    ) {
      return 'claude';
    }

    return normalizeKnownProvider(fallbackProvider) || undefined;
  }

  hasRefreshTokenPhrase(text) {
    const normalized = this.normalizeDetectionText(text);
    return normalized.includes('refresh token');
  }

  ensureCodexAuthErrorPrefix(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    return text.startsWith(CODEX_AUTH_ERROR_PREFIX) ? text : `${CODEX_AUTH_ERROR_PREFIX} ${text}`;
  }

  isCodexPlanRestrictedModelError(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;

    return normalized.includes('model is not supported when using codex with a chatgpt account')
      || normalized.includes("isn't available in codex when you're signed in with a chatgpt account")
      || normalized.includes('is not available in codex when you\'re signed in with a chatgpt account');
  }

  sanitizeCodexPlanRestrictedMessage(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    return text
      .replace(/['"`]gpt-5\.6-(?:sol|terra|luna)['"`]/gi, 'this model')
      .replace(/'gpt-5\.5'/gi, 'this model')
      .replace(/"gpt-5\.5"/gi, 'this model')
      .replace(/`gpt-5\.5`/gi, 'this model')
      .replace(/'gpt-5\.4'/gi, 'this model')
      .replace(/"gpt-5\.4"/gi, 'this model')
      .replace(/`gpt-5\.4`/gi, 'this model')
      .replace(/'gpt-5\.3 codex'/gi, 'this model')
      .replace(/"gpt-5\.3 codex"/gi, 'this model')
      .replace(/`gpt-5\.3 codex`/gi, 'this model');
  }

  isCodexPlaytestSubagentPlanRestrictedError(text) {
    if (!this.isCodexPlanRestrictedModelError(text)) return false;

    const preference = this.app.normalizeCodexPlaytestSubagentModelPreference?.(this.app.codexPlaytestSubagentModel) || 'auto';
    if (preference === 'auto' || preference === 'gpt-5.6-terra' || preference === 'gpt-5.4-mini' || preference === 'gpt-5.2-codex') {
      return false;
    }

    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;

    const modelHints = {
      'gpt-6-astra': ['gpt 6 astra', 'gpt-6-astra'],
      'gpt-6.1-sol': ['gpt 6.1 sol', 'gpt-6.1-sol'],
      'gpt-6-sol': ['gpt 6 sol', 'gpt-6-sol'],
      'gpt-6-luna': ['gpt 6 luna', 'gpt-6-luna'],
      'gpt-5.6-sol': ['gpt 5.6 sol', 'gpt-5.6-sol'],
      'gpt-5.6-terra': ['gpt 5.6 terra', 'gpt-5.6-terra'],
      'gpt-5.6-luna': ['gpt 5.6 luna', 'gpt-5.6-luna'],
      'gpt-5.5': ['gpt 5.5', 'gpt-5.5'],
      'gpt-5.4': ['gpt 5.4', 'gpt-5.4'],
      'gpt-5.3-codex': ['gpt 5.3 codex', 'gpt-5.3-codex'],
      'gpt-5.3-codex-spark': ['gpt 5.3 spark', 'gpt-5.3-codex-spark'],
      'gpt-5.2-codex': ['gpt 5.2 codex', 'gpt-5.2-codex'],
    };

    return (modelHints[preference] || [preference]).some((hint) => normalized.includes(hint));
  }

  isCreditLimitMessage(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;
    return (
      normalized.includes('credit balance is too low') ||
      normalized.includes('credits balance is too low') ||
      normalized.includes('insufficient credits') ||
      normalized.includes('insufficient_credits') ||
      normalized.includes('not enough credits') ||
      normalized.includes('out of credits') ||
      normalized.includes('credits exhausted') ||
      normalized.includes('credit limit') ||
      normalized.includes('payment required') ||
      normalized.includes("you've hit your limit") ||
      normalized.includes('you have hit your limit') ||
      normalized.includes('no credits remaining') ||
      // A script line or numeric value (for example, line 402) is not an
      // HTTP payment error. Only accept the status code with error context.
      /\b(?:api\s+error|http(?:\s+(?:error|status))?|status(?:\s+code)?)\s*[:=]?\s*402\b/.test(normalized)
    );
  }

  isClaudeCreditLimitAssistantMessage(text) {
    if (!this.isCreditLimitMessage(text)) return false;
    const normalized = this.normalizeDetectionText(text)
      .replace(/^\[from claude code\]\s*/, '')
      .replace(/^error:\s*/, '');

    // Assistant text can discuss game currencies and HTTP errors. Only
    // divert a provider-shaped error from the normal Markdown renderer.
    // Structured error events keep using isCreditLimitMessage directly.
    if (/^(?:api\s+error\b|http(?:\/[\d.]+)?\s|status(?:\s+code)?\s*[:=]?\s*402\b|402\s+payment required\b)/.test(normalized)) {
      return true;
    }
    if (/```|~~~/.test(text)) return false;
    return /^(?:your\s+)?credits? balance is too low\b/.test(normalized)
      || /^(?:insufficient credits|insufficient_credits|not enough credits|out of credits|credits exhausted|credit limit(?: reached| exceeded)?|payment required|you've hit your limit|you have hit your limit|no credits remaining)(?:$|[.!:;,\s]*[·|]|[.!:;,](?:\s|$))/.test(normalized);
  }

  /**
   * The gateway's structured mid-turn 402 marker. Unlike the substring-based
   * isRopilotCreditsLimitMessage heuristic, this marker is only ever emitted
   * by our own Go server / gateway when the managed balance is genuinely
   * exhausted, so it must bypass the false-positive wall suppression (whose
   * cached balance snapshot is stale-high exactly in the mid-turn case).
   */
  isRopilotCreditsRequiredMarker(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;
    return normalized.includes('managed_ai_credits_required')
      || normalized.includes('ropilot credits required');
  }

  /**
   * App-server failure strings from the Go server can carry appended debug
   * innards — a trailing parenthesized stderr tail with rust log lines like
   * "2026-08-08T16:47:39Z ERROR codex_core::tools::router: …". Users should
   * only see the human sentence; the full text stays in the console.
   */
  stripAppServerDebugNoise(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    // Only touch app-server failure strings — other errors keep their text.
    if (!/app-server failed/i.test(text)) return text;
    // Trailing " (…" fragment whose content starts with a timestamp and/or a
    // rust log level + codex_core-style module path (ANSI escapes allowed).
    const debugTail = /\s*\(\s*(?:\u001b\[[0-9;]*m\s*)*(?:(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+)(?:\u001b\[[0-9;]*m\s*)*(?:ERROR|WARN|INFO|DEBUG|TRACE)\b|(?:ERROR|WARN|INFO|DEBUG|TRACE)\b\s+(?:\u001b\[[0-9;]*m\s*)*\w+(?:::\w+)+|\w+(?:::\w+)+\b)[\s\S]*$/;
    const match = text.match(debugTail);
    if (!match || match.index === undefined || match.index <= 0) return text;
    const cleaned = text.slice(0, match.index).trim();
    if (!cleaned) return text;
    console.debug('[error] app-server failure debug tail stripped from display; full text:', text);
    return cleaned;
  }

  isRopilotCreditsLimitMessage(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized || !this.isCreditLimitMessage(text)) return false;

    if (this.app.isUseRopilotCreditsEnabled?.() === true || this.app.useRopilotCredits === true) {
      return true;
    }

    return normalized.includes('ropilot credits')
      || normalized.includes('managed ai credits')
      || normalized.includes('managed_ai_credits')
      || normalized.includes('use_managed_ai_credits');
  }

  /**
   * The credit-limit detection is substring-based and can trip on text that
   * is NOT about the user's managed balance (e.g. a drained legacy pool on
   * the edge billing "No credits remaining" while the managed balance is
   * healthy). When the last-known managed balance is at or above the wall's
   * own minimum, showing the wall would be a false positive — the caller
   * should surface the text as ordinary output instead.
   */
  shouldSuppressRopilotCreditsWall() {
    const wall = this.app.creditsWall;
    if (!wall) return false;
    const remaining = wall.getManagedCreditsRemaining?.();
    if (!Number.isFinite(remaining)) return false;
    return remaining >= wall.getNoActionsMinimumCredits();
  }

  // Telemetry + reconciliation for suppressed false-positive walls
  // (throttled — a drained legacy pool can emit one trigger per tool call).
  noteSuppressedRopilotCreditsWall() {
    const now = Date.now();
    if (this._lastWallSuppressedPostAt && now - this._lastWallSuppressedPostAt < 60 * 1000) return;
    this._lastWallSuppressedPostAt = now;
    this.app.postWallEvent?.('suppressed_false_positive', 'no_actions');
    // The suppression decision reads the CACHED balance snapshot. If that
    // snapshot is stale-high (balance drained out-of-band), the turn never
    // completes, so the post-turn refresh in onDone never runs and the wall
    // would stay suppressed forever. Kick a refresh here so the next trigger
    // re-evaluates against fresh data.
    const refresh = this.app.settings?.refreshManagedAiCredits?.();
    if (refresh && typeof refresh.catch === 'function') {
      refresh.catch((err) => {
        console.warn('Failed to refresh managed AI credits after suppressed credit-limit trigger:', err);
      });
    }
  }

  isRopilotCreditsWallDismissedForCurrentTurn() {
    return this.app.creditsWall?.isNoActionsWallDismissedForCurrentTurn?.() === true;
  }

  isCodexPlusUpgradeLimitMessage(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;

    const mentionsCodexOrChatGpt = normalized.includes('codex')
      || normalized.includes('chatgpt')
      || normalized.includes('openai')
      || normalized.includes('chat.openai.com')
      || normalized.includes('gpt-');
    const mentionsUsageLimit = normalized.includes('usage limit')
      || normalized.includes('hit your limit')
      || normalized.includes('reached your chatgpt limit')
      || normalized.includes('hit your chatgpt limit')
      || normalized.includes('reached your usage cap')
      || normalized.includes('usage cap');

    return mentionsCodexOrChatGpt && mentionsUsageLimit;
  }

  extractCodexUsageLimitRetryAt(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    const cleaned = text
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const precise = cleaned.match(/\btry again at\s+([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    if (precise) {
      return precise[1].replace(/\s+/g, ' ').trim();
    }

    const fallback = cleaned.match(/\btry again (?:at|after|on)\s+([^.)\]\n\r]+)(?=[.)\]\n\r]|$)/i);
    return fallback ? fallback[1].replace(/\s+/g, ' ').trim() : '';
  }

  showRopilotCreditsLimitModal() {
    const refresh = this.app.settings?.refreshManagedAiCredits?.();
    if (refresh && typeof refresh.catch === 'function') {
      refresh.catch((err) => {
        console.warn('Failed to refresh managed AI credits after credit limit:', err);
      });
    }
    this.app.showNoActionsModal?.();
  }

  showCodexPlusUpgradeCreditsModal(text = '') {
    const refresh = this.app.settings?.refreshManagedAiCredits?.();
    if (refresh && typeof refresh.catch === 'function') {
      refresh.catch((err) => {
        console.warn('Failed to refresh managed AI credits after Codex Plus upgrade limit:', err);
      });
    }
    this.app.showNoActionsModal?.({
      upgradeToRopilotCreditsOnPurchase: true,
      chatGptUsageLimitRetryAt: this.extractCodexUsageLimitRetryAt(text),
    });
  }

  isClaudeOpus1MRateLimitMessage(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;
    return normalized.includes('api error: rate limit reached') || normalized.includes('rate limit reached');
  }

  isStalePlanModeResponseError(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;
    return normalized.includes('no pending plan mode tool call to respond');
  }

  handleSpecialAssistantText(text, targetChat, isOnTargetChat) {
    if (typeof text !== 'string' || text.length === 0) return false;
    const targetProvider = targetChat
      ? this.app.getChatProvider(targetChat, this.app.modelProvider)
      : this.app.normalizeModelProvider(this.app.modelProvider);
    const targetModel = this.app.normalizeSelectedModel(targetChat?.model || this.app.selectedModel);

    if (this.isStalePlanModeResponseError(text)) {
      if (targetChat?.id) {
        this.app.planModeManager?.handlePlanModeResponseDesynced?.(targetChat.id);
      }
      return true;
    }

    if (this.isCodexCliMissingError(text)) {
      this.app.addErrorMessageToChat(CODEX_SETUP_MISSING_MESSAGE, targetChat, isOnTargetChat, {
        cta: 'return_to_provider_setup',
        ctaProvider: 'codex',
      });
      return true;
    }

    if (targetProvider === 'codex' && this.isCodexPlusUpgradeLimitMessage(text)) {
      this.showCodexPlusUpgradeCreditsModal(text);
      return true;
    }

    if (
      targetProvider === 'claude'
      && this.canShowLocalProviderAuthCta('claude', targetChat)
      && (this.isExpiredClaudeOAuthError(text) || this.isClaudeActionsAuthMessage(targetChat, targetProvider, text))
    ) {
      const prefixed = this.ensureClaudeAuthErrorPrefix(text);
      this.app.addErrorMessageToChat(prefixed, targetChat, isOnTargetChat, {
        showReturnToLogin: true,
        returnToLoginProvider: 'claude'
      });
      return true;
    }

    if (targetProvider === 'codex' && this.isCodexAuthError(text)) {
      const prefixed = this.ensureCodexAuthErrorPrefix(text);
      this.app.addErrorMessageToChat(prefixed, targetChat, isOnTargetChat, {
        showReturnToLogin: true,
        returnToLoginProvider: 'codex'
      });
      return true;
    }

    if (this.isInvalidAuthenticationCredentialsError(text)) {
      const provider = this.getAuthCtaProvider(targetChat, targetProvider);
      if (!this.canShowLocalProviderAuthCta(provider, targetChat)) {
        return false;
      }
      const displayText = provider === 'codex'
        ? this.ensureCodexAuthErrorPrefix(text)
        : provider === 'claude'
          ? this.ensureClaudeAuthErrorPrefix(text)
          : text;
      this.app.addErrorMessageToChat(displayText, targetChat, isOnTargetChat, {
        showReturnToLogin: true,
        returnToLoginProvider: provider
      });
      return true;
    }

    if (this.hasRefreshTokenPhrase(text)) {
      if (!this.canShowLocalProviderAuthCta(targetProvider, targetChat)) {
        return false;
      }
      this.app.addErrorMessageToChat(text, targetChat, isOnTargetChat, {
        showReturnToLogin: true,
        returnToLoginProvider: targetProvider
      });
      return true;
    }

    const isOpus1MModel = targetModel === 'claude-opus-5-5[1m]' || targetModel === 'claude-fable-5-1[1m]';
    if (targetProvider === 'claude' && isOpus1MModel && this.isClaudeOpus1MRateLimitMessage(text)) {
      this.app.addErrorMessageToChat(text, targetChat, isOnTargetChat, {
        noteTitle: '[Note from Ropilot]',
        noteMessage: CLAUDE_OPUS_1M_NOTE,
      });
      return true;
    }

    if (targetProvider === 'codex' && this.isCodexPlanRestrictedModelError(text)) {
      if (this.isCodexPlaytestSubagentPlanRestrictedError(text)) {
        this.app.addErrorMessageToChat(text, targetChat, isOnTargetChat, {
          noteTitle: '[Note from Ropilot]',
          noteMessage: CODEX_PLAYTEST_SUBAGENT_PLAN_NOTE,
        });
        return true;
      }

      this.app.addErrorMessageToChat(this.sanitizeCodexPlanRestrictedMessage(text), targetChat, isOnTargetChat, {
        noteTitle: '[Note from Ropilot]',
        noteMessage: CODEX_PLAN_RETRY_NOTE,
        cta: 'switch_to_gpt56terra_codex_and_retry',
      });
      return true;
    }

    if (this.isDegenerationStopMessage(text)) {
      // Degeneration guard stop (Go server): the poisoned Codex thread was
      // already quarantined server-side, so one automatic retry rebuilds
      // clean context and usually succeeds. Surface the same quiet
      // failure-note-with-retry the provider outages use — never the raw
      // marker text.
      this.app.aiProviderAnalytics?.trackProviderFail?.({
        chatId: targetChat?.id,
        chat: targetChat,
        source: 'degeneration_guard',
        reason: 'agent_loop_degenerated',
        errorText: text,
      });
      const autoRetry = !!targetChat?.id && !this.degenerationRetryPendingByChat.has(targetChat.id);
      if (targetChat?.id) {
        this.degenerationStopSeenThisTurn.add(targetChat.id);
      }
      this.app.addErrorMessageToChat(DEGENERATION_RETRY_TEXT, targetChat, isOnTargetChat, {
        cta: 'retry_degeneration_recovery',
      });
      if (autoRetry) {
        this.scheduleDegenerationAutoRetry(targetChat.id);
      }
      return true;
    }

    if (this.isRopilotEconomyRouteFailedMessage(text)) {
      // Economy/Standard route failures usually arrive as ASSISTANT TEXT (the
      // gateway streams the failure message and completes the turn cleanly),
      // not as a WS error — so the fail marker must be emitted here too or
      // these outages never show as failures on the admin panel.
      this.app.aiProviderAnalytics?.trackProviderFail?.({
        chatId: targetChat?.id,
        chat: targetChat,
        source: 'route_failure_message',
        reason: 'standard_route_unavailable',
        errorText: text,
      });
      this.app.addErrorMessageToChat(this.formatRopilotEconomyRouteFailureMessage(text), targetChat, isOnTargetChat, {
        noteTitle: '[Note from Ropilot]',
        ...this.buildRopilotEconomyRouteFailureNoteOptions(targetChat, targetProvider),
        cta: 'retry_ropilot_credits_route',
      });
      return true;
    }

    if (this.isRopilotCreditsLimitMessage(text)) {
      // The gateway's structured 402 marker is authoritative — a mid-turn
      // drain leaves the cached balance snapshot stale-high, so the
      // false-positive suppression must not apply when it is present.
      if (!this.isRopilotCreditsRequiredMarker(text) && this.shouldSuppressRopilotCreditsWall()) {
        // Managed balance is healthy — this "out of credits" text is a
        // false positive. Let it render as ordinary assistant output
        // instead of walling (and swallowing) it.
        this.noteSuppressedRopilotCreditsWall();
        return false;
      }
      if (this.isRopilotCreditsWallDismissedForCurrentTurn()) {
        // User dismissed the wall for this turn — surface the text rather
        // than silently re-walling.
        return false;
      }
      this.showRopilotCreditsLimitModal();
      return true;
    }

    if (targetProvider === 'claude' && this.isClaudeCreditLimitAssistantMessage(text)) {
      const formattedCreditMessage = this.formatClaudeCreditLimitMessage(text);
      this.app.addErrorMessageToChat(formattedCreditMessage, targetChat, isOnTargetChat);
      return true;
    }

    return false;
  }

  normalizeDetectionText(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    return text
      .toLowerCase()
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
      .replace(/\u2019/g, '\'')
      .replace(/\s+/g, ' ')
      .trim();
  }

  isDegenerationStopMessage(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;
    return normalized.includes(DEGENERATION_RETRY_MARKER)
      // Legacy Go binaries (pre-marker guard build) used this wording.
      || normalized.includes('got stuck repeating the same action');
  }

  // One-shot automatic recovery retry after a degeneration stop. The stop
  // arrives while the turn is still winding down (done/stopped follows the
  // stop text), so poll briefly until the chat is idle, then dispatch via
  // the SAME handler the note's manual button uses. Guards:
  // - exactly one auto-retry per degeneration streak (pending-map gate;
  //   cleared only by a turn that ends WITHOUT degenerating again)
  // - never fires into a different chat, a busy chat, or a dead socket
  // - never auto-retries into an exhausted balance (manual note remains)
  scheduleDegenerationAutoRetry(chatId) {
    this.degenerationRetryPendingByChat.set(chatId, Date.now());
    let polls = 0;
    const attempt = () => {
      if (this.app.activeChat?.id !== chatId) return; // manual note remains
      if (this.app.isChatProcessing?.(chatId)) {
        if (++polls <= this.degenAutoRetryMaxPolls) {
          setTimeout(attempt, this.degenAutoRetryPollMs);
        }
        return;
      }
      if (this.app.wsManager?.state !== undefined && this.app.wsManager.state !== 'open') return;
      if (this.isManagedBalanceExhausted()) return;
      this.app.retryDegenerationRecovery?.();
    };
    setTimeout(attempt, this.degenAutoRetryDelayMs);
  }

  // True when the managed balance is known to be below the minimum needed
  // for a turn — the one case an automatic retry must not spend.
  isManagedBalanceExhausted() {
    const wall = this.app.creditsWall;
    if (!wall) return false;
    const remaining = wall.getManagedCreditsRemaining?.();
    if (!Number.isFinite(remaining)) return false;
    return remaining < wall.getNoActionsMinimumCredits();
  }

  // Called on turn end (done/stopped). The degenerate turn ITSELF ends right
  // after the stop text, so a turn that contained a stop must not settle the
  // streak — only a turn that finished clean does. Without that distinction
  // the pending gate would clear before the auto-retry even dispatched and a
  // re-degenerating retry would auto-retry forever.
  settleDegenerationRetry(chatId) {
    if (!chatId) return;
    if (this.degenerationStopSeenThisTurn.delete(chatId)) return; // this WAS the degenerate turn
    this.degenerationRetryPendingByChat.delete(chatId);
  }

  isRopilotEconomyRouteFailedMessage(text) {
    const normalized = this.normalizeDetectionText(text);
    if (!normalized) return false;
    return normalized.includes('economy_route_failed')
      || normalized.includes('economy routing is having trouble with this request')
      || normalized.includes('economy is temporarily unavailable')
      || normalized.includes('standard is having trouble with this request')
      || normalized.includes('standard is temporarily unavailable');
  }

  // Builds the addErrorMessageToChat note options for a Standard route
  // failure, appending a vendor-outage hint + status-page link for the
  // provider the failed model routes to. The base note text is left intact
  // so the autopilot's copy expectations keep matching.
  buildRopilotEconomyRouteFailureNoteOptions(targetChat, fallbackProvider) {
    // Model-first provider derivation (gpt-* → codex, claude/opus/... →
    // claude), same rules as the auth CTA routing.
    const provider = this.getAuthCtaProvider(targetChat, fallbackProvider);
    const statusLink = VENDOR_STATUS_NOTE_LINKS[provider];
    if (!statusLink) {
      return { noteMessage: ROPILOT_ECONOMY_ROUTE_RETRY_NOTE };
    }
    return {
      noteMessage: `${ROPILOT_ECONOMY_ROUTE_RETRY_NOTE} If this keeps happening, ${statusLink.vendor} may be having an outage: check`,
      noteLink: { href: statusLink.href, label: statusLink.label },
    };
  }

  formatRopilotEconomyRouteFailureMessage(text) {
    const normalized = this.normalizeDetectionText(text);
    if (normalized.includes('temporarily_unavailable') || normalized.includes('economy is temporarily unavailable')) {
      return 'Standard is temporarily unavailable. Try again later.';
    }
    return 'Standard routing is having trouble with this request.';
  }

  formatClaudeCreditLimitMessage(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return `${CLAUDE_USAGE_PREFIX} ${CLAUDE_CREDIT_USAGE_SUFFIX}`;
    }

    let formatted = text.startsWith(CLAUDE_USAGE_PREFIX) ? text : `${CLAUDE_USAGE_PREFIX} ${text}`;
    const normalized = this.normalizeDetectionText(formatted);
    if (!normalized.includes(CLAUDE_CREDIT_USAGE_SUFFIX)) {
      formatted = `${formatted} ${CLAUDE_CREDIT_USAGE_SUFFIX}`;
    }
    return formatted;
  }

  isStudioDiagnosticsMessage(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (STUDIO_DIAGNOSTIC_TYPES.has(msg.type)) return true;
    if (msg.type !== 'edge_event') return false;
    if (Array.isArray(msg.errors) && msg.errors.length > 0) return true;
    const eventPayload = msg.event && typeof msg.event === 'object' ? msg.event : null;
    if (eventPayload && Array.isArray(eventPayload.errors) && eventPayload.errors.length > 0) {
      return true;
    }

    const typeHints = [
      msg.channel,
      msg.kind,
      msg.name,
      msg.source,
      msg.topic,
      eventPayload?.type,
      eventPayload?.kind,
      eventPayload?.name,
      eventPayload?.source,
    ]
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .join(' ')
      .toLowerCase();

    if (!/(diagnostic|console|studio|playtest)/i.test(typeHints)) {
      return false;
    }

    const candidateText = [
      msg.message,
      msg.output,
      msg.content,
      eventPayload?.message,
      eventPayload?.output,
    ]
      .filter((value) => typeof value === 'string')
      .join('\n');
    return /(error|exception|failed|invalid|uncaught|attempt to|stack trace)/i.test(candidateText);
  }

  handleStudioDiagnosticsMessage(msg, targetChatId) {
    this.app.recordStudioDiagnostics(msg, targetChatId || null);
  }
}
