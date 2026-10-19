// @ts-check
// Credits wall — free build.
//
// The shipped version was the monetisation surface: an inline out-of-credits
// card carrying a checkout button and a price, auto top-up charged against a
// saved card through their billing endpoint, a fallback card injected into
// stored chats, a referral promo, and wall telemetry to their analytics.
//
// None of that applies here. This build never routes to Ropilot's managed
// inference — isUseRopilotCreditsEnabled() is pinned to false in app.js, so the
// Credits route is unreachable and every balance it used to read is a number
// about a product this build does not use.
//
// What is left is the part that was never for sale: telling the user their own
// ChatGPT / Claude plan ran out, with no way to buy anything. Every method the
// rest of the app calls is kept, with the same signature, so nothing upstream
// has to change.
import { escapeHtml } from '../utils.js';

// message-renderer.js imports this for stored-chat cards. It was the
// "Invite friends" referral block; there is no referral programme to feed.
export const INLINE_INVITE_PROMO_MARKUP = '';

const CARD_ID = 'credits-inline-card';

export class CreditsWall {
  constructor(app) {
    this.app = app;
  }

  /** Nothing is metered in this build, so there is no balance to report. */
  getManagedCreditsRemaining() {
    return null;
  }

  getNoActionsMinimumCredits() {
    return 0.2;
  }

  /**
   * Identity of the failure: same chat + same last user message. Kept because
   * the dismissal memory keys off it, and that behaviour is still useful — the
   * notice should not re-appear for a turn the user already dismissed.
   */
  getNoActionsWallTurnKey() {
    const chat = this.app.activeChat;
    if (!chat?.id) return '';
    const timeline = Array.isArray(chat.timeline) ? chat.timeline : [];
    let userMessageCount = 0;
    let lastUserItemId = '';
    for (const item of timeline) {
      if (item?.type === 'user') {
        userMessageCount += 1;
        if (item.id != null && item.id !== '') lastUserItemId = String(item.id);
      }
    }
    return lastUserItemId
      ? `${chat.id}:${userMessageCount}:${lastUserItemId}`
      : `${chat.id}:${userMessageCount}`;
  }

  isNoActionsWallDismissedForCurrentTurn() {
    const key = this.getNoActionsWallTurnKey();
    return !!key && this.app.noActionsWallDismissedKey === key;
  }

  ensureNoActionsWallEpisode() {
    const key = this.getNoActionsWallTurnKey();
    if (this.app.noActionsWallEpisodeKey === key) return;
    this.app.noActionsWallEpisodeKey = key;
    this.app.noActionsWallShownBalance = null;
  }

  /**
   * The old card offered three ways to pay; there is nothing to offer now, so
   * "you hit your plan limit" is delivered plainly and the chat stream carries
   * the provider's own error.
   */
  showNoActionsModal(options = {}) {
    const container = document.getElementById('messages');
    if (!container) return;
    if (this.isNoActionsWallDismissedForCurrentTurn()) return;
    this.ensureNoActionsWallEpisode();

    const existing = document.getElementById(CARD_ID);
    if (existing) {
      this.updateNoActionsCard();
      return;
    }

    container.appendChild(this.createNoActionsCard(options));
    const scroller = document.getElementById('chat-messages-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  hideNoActionsModal() {
    this.app.noActionsAutoRetryInFlight = false;
    this.app.noActionsUpgradeToRopilotCreditsPending = false;
    this.app.noActionsChatGptUsageLimitRetryAt = '';
    document.getElementById(CARD_ID)?.remove();
  }

  clearNoActionsUpgradeRecoveryState() {
    this.hideNoActionsModal();
  }

  handleUserStop() {
    if (!document.getElementById(CARD_ID)) return;
    this.app.noActionsWallDismissedKey = this.getNoActionsWallTurnKey();
    this.updateNoActionsCard();
  }

  // ── the card ──────────────────────────────────────────────────────────────

  getLimitNoticeText() {
    const retryAt = String(this.app.noActionsChatGptUsageLimitRetryAt || '').trim();
    if (retryAt) {
      return `You have hit your ChatGPT usage limit. Try again at ${retryAt}.`;
    }
    return 'You have hit the usage limit on your own ChatGPT or Claude plan.';
  }

  createNoActionsCard() {
    const card = document.createElement('div');
    card.className = 'credits-inline-card';
    card.id = CARD_ID;
    card.innerHTML = `
      <p class="cic-kicker">${escapeHtml(this.getLimitNoticeText())}</p>
      <div class="cic-card">
        <h2 class="cic-title">Your plan's limit, not a paywall</h2>
        <p class="cic-sub">This build runs on your own Claude Code or Codex login. It has no
        credits to sell and no route of its own &mdash; when your provider says stop,
        that is the whole story.</p>
        <div class="cic-footer">
          <button type="button" class="cic-later" id="cic-later">Dismiss</button>
        </div>
      </div>
    `;
    card.querySelector('#cic-later')?.addEventListener('click', () => {
      this.app.noActionsWallDismissedKey = this.getNoActionsWallTurnKey();
      this.hideNoActionsModal();
    });
    return card;
  }

  updateNoActionsCard() {
    const card = document.getElementById(CARD_ID);
    if (!card) return;
    const kicker = card.querySelector('.cic-kicker');
    if (kicker) kicker.textContent = this.getLimitNoticeText();
  }

  // ── no-op surface kept for the callers that still reference it ────────────
  // These are called from message handling and settings; they are deliberately
  // inert rather than deleted, so upstream code paths stay simple.

  startNoActionsCreditRecoveryWatcher() {}

  stopNoActionsCreditRecoveryWatcher() {
    if (this.app.noActionsCreditRefreshTimer) {
      clearInterval(this.app.noActionsCreditRefreshTimer);
      this.app.noActionsCreditRefreshTimer = null;
    }
  }

  handleAccountBalanceUpdated() {}

  handleManagedAiCreditsBalanceUpdated() {}

  refreshAndMaybeResumeNoActions() {
    return false;
  }

  retryNoActionsAfterCreditRecovery() {
    return false;
  }

  attemptNoActionsAutoResume() {
    return false;
  }

  /** No billing analytics endpoint is contacted by this build. */
  postWallEvent() {}

  /** Auto top-up charged a saved card. It does not exist here. */
  async fetchAutoRefillState() {
    return null;
  }

  async refillNowAndEnable() {}

  async renderWallAutoRefillSection() {}
}
