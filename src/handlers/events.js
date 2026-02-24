'use strict';

/**
 * Slack Events API handler.
 *
 * Responsibilities:
 *  - Respond to url_verification challenges immediately.
 *  - ACK all other events within Slack's 3-second window.
 *  - Process `message.im` events asynchronously:
 *      • Dedup via event_id
 *      • Per-user rate limiting (30 msg / 5 min)
 *      • Per-user concurrency mutex (1 Argus call at a time)
 *      • Threaded replies → check relay table first
 *      • Approval responses from User A → handled before identity resolution
 *      • Post "thinking" message, run Argus, update with reply
 *      • Non-Atlas users → check active relay before greeting
 */

const { WebClient } = require('@slack/web-api');
const slackVerify = require('../middleware/slack-verify');
const { isDuplicate } = require('../utils/dedup');
const supabase = require('../utils/supabase');
const { resolveIdentity } = require('../services/identity');

const { runCloudArgus } = require('../services/argus-cloud');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// ---------------------------------------------------------------------------
// Relay service — optional; falls back gracefully if not yet available
// ---------------------------------------------------------------------------

let relayService = null;
try {
  relayService = require('../services/relay');
} catch (_) {
  console.warn('[events] relay service not available — relay features disabled');
}

// ---------------------------------------------------------------------------
// Rate limiting — 30 messages per 5 minutes per user
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX = 30;

/**
 * @typedef {{ timestamps: number[] }} RateLimitEntry
 */

/** @type {Map<string, RateLimitEntry>} */
const rateLimitMap = new Map();

/**
 * Check (and record) a message against the per-user rate limit.
 * @param {string} userId
 * @returns {boolean} `true` if the user is within their allowance.
 */
function checkRateLimit(userId) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let entry = rateLimitMap.get(userId);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitMap.set(userId, entry);
  }

  // Prune old timestamps
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  if (entry.timestamps.length >= RATE_LIMIT_MAX) {
    return false; // over limit
  }

  entry.timestamps.push(now);
  return true;
}

// ---------------------------------------------------------------------------
// Concurrency mutex — 1 Argus call per user at a time
// ---------------------------------------------------------------------------

/** @type {Set<string>} */
const activeArgusUsers = new Set();

// ---------------------------------------------------------------------------
// Express middleware chain: [slackVerify, handler]
// ---------------------------------------------------------------------------

/**
 * Main Slack events route handler.
 * Compose with slackVerify middleware before registering.
 */
const eventsHandler = [
  slackVerify,
  async (req, res) => {
    const body = req.body;

    // ── url_verification ───────────────────────────────────────────────────
    if (body.type === 'url_verification') {
      return res.status(200).json({ challenge: body.challenge });
    }

    // ── ACK immediately (Slack requires < 3 s) ─────────────────────────────
    res.status(200).send();

    // ── Process event asynchronously ───────────────────────────────────────
    const event = body.event;
    if (!event) return;

    // Only handle direct message events from real users
    if (event.type !== 'message' || event.channel_type !== 'im') return;
    if (event.bot_id) return;              // ignore bot messages
    if (event.subtype) return;            // ignore edits, deletes, etc.

    // ── Deduplication ──────────────────────────────────────────────────────
    const eventId = body.event_id;
    if (isDuplicate(eventId)) {
      console.log(`[events] Duplicate event ${eventId} — skipping`);
      return;
    }

    // Kick off async processing without blocking the ACK response
    processImMessage(body, event).catch((err) => {
      console.error('[events] Unhandled error in processImMessage:', err);
    });
  },
];

// ---------------------------------------------------------------------------
// Async message processing
// ---------------------------------------------------------------------------

/**
 * Process a `message.im` event end-to-end.
 * @param {object} body  - Full Slack Events API payload
 * @param {object} event - `body.event`
 */
async function processImMessage(body, event) {
  const slackUserId = event.user;
  const slackTeamId = body.team_id;
  const channelId = event.channel;
  const messageTs = event.ts;
  const threadTs = event.thread_ts;
  const messageText = event.text ?? '';

  // ── Rate limit ─────────────────────────────────────────────────────────
  if (!checkRateLimit(slackUserId)) {
    console.warn(`[events] Rate limit hit for user ${slackUserId}`);
    await safePostMessage(channelId, {
      text: '⚠️ You\'re sending messages too quickly. Please wait a moment before trying again.',
      thread_ts: threadTs,
    });
    return;
  }

  // ── Threaded reply → check relay table ────────────────────────────────
  if (threadTs && threadTs !== messageTs) {
    const handled = await tryHandleRelayReply(event, slackUserId, channelId, messageText, threadTs);
    if (handled) return;
  }

  // ── Check if this is an approval response from User A ──────────────────
  // Must come BEFORE identity resolution so we handle it regardless of Atlas status
  if (threadTs && threadTs !== messageTs && relayService) {
    try {
      const approval = await relayService.findPendingApproval(slackUserId, threadTs);
      if (approval) {
        await processApprovalResponse(approval, messageText, channelId);
        return;
      }
    } catch (err) {
      console.error('[events] approval check error:', err.message);
      // fall through to normal handling
    }
  }

  // ── Resolve Atlas identity ─────────────────────────────────────────────
  const atlasUserId = await resolveIdentity(slackUserId, slackTeamId);
  if (!atlasUserId) {
    console.log(`[events] No Atlas identity for Slack user ${slackUserId} — checking relay`);

    // ── Check for active relay before showing greeting ──────────────────
    if (relayService) {
      try {
        const activeRelay = await relayService.findActiveRelay(slackUserId, threadTs);

        if (activeRelay) {
          // This person is in an active relay conversation

          // Check if there's a pending approval they're already waiting on
          const pending = await relayService.checkPendingForRecipient(slackUserId);
          if (pending) {
            // They're waiting on User A — tell them gracefully
            await safePostMessage(channelId, {
              text: 'Still sorting the details on that — I should have an answer for you shortly.\n\nIs there anything else I can assist with in the meantime?\n\n— _Argus_ 🎩',
            });
            return;
          }

          // Evaluate their reply — can Argus answer directly, or does it need approval?
          const apiKey = process.env.ANTHROPIC_API_KEY;
          const evaluation = await relayService.evaluateReply(activeRelay, messageText, apiKey);

          if (evaluation.action === 'answer_directly') {
            await safePostMessage(channelId, { text: markdownToSlack(evaluation.response) });
            return;
          }

          if (evaluation.action === 'acknowledge') {
            // Simple ack — respond to User B and forward summary to User A
            await safePostMessage(channelId, { text: markdownToSlack(evaluation.response) });
            // Notify User A
            await safePostMessage(activeRelay.sender_slack_user_id, {
              text: `📨 *${activeRelay.recipient_name || 'The recipient'}* replied to your message: "${messageText.substring(0, 200)}"`,
            });
            return;
          }

          if (evaluation.action === 'needs_approval') {
            // Request approval from User A, then tell User B we're on it
            await relayService.requestApproval(activeRelay, messageText, evaluation.response, slack);
            await safePostMessage(channelId, {
              text: 'Let me check on that for you — I should have an answer shortly.\n\n— _Argus_ 🎩',
            });
            return;
          }
        }
      } catch (err) {
        console.error('[events] relay check for non-Atlas user error:', err.message);
        // fall through to greeting
      }
    }

    // ── No active relay — show the Argus greeting ───────────────────────
    // Fetch their display name for a personal touch
    let displayName = 'there';
    try {
      const info = await slack.users.info({ user: slackUserId });
      displayName = info.user?.profile?.first_name || info.user?.real_name || 'there';
    } catch (_) { /* best effort */ }

    await safePostMessage(channelId, {
      text: `Good ${getTimeOfDayGreeting()}, ${displayName}.\n\n` +
        `I'm Argus. I don't appear to have you in my records just yet — which means my rather ` +
        `considerable capabilities are, regrettably, unavailable to you at present.\n\n` +
        `If you've been sent here by someone who _does_ have an account, do reply here and ` +
        `I shall see to it your message reaches them. Otherwise, a word with your administrator ` +
        `ought to sort the introductions.\n\n` +
        `— _Argus_ 🎩`,
    });
    return;
  }

  // ── Per-user concurrency mutex ─────────────────────────────────────────
  if (activeArgusUsers.has(atlasUserId)) {
    console.log(`[events] Argus already running for ${atlasUserId} — dropping`);
    await safePostMessage(channelId, {
      text: '⏳ I\'m still working on your previous message. Please wait a moment.',
      thread_ts: threadTs,
    });
    return;
  }

  activeArgusUsers.add(atlasUserId);

  try {
    // ── Post "thinking" message ──────────────────────────────────────────
    const thinkingMsg = await safePostMessage(channelId, {
      text: '🤔 Thinking…',
      thread_ts: threadTs,
    });

    // ── Fetch minimal conversation history ───────────────────────────────
    const conversationHistory = await fetchConversationHistory(channelId, messageTs);

    // ── Run Cloud Argus ──────────────────────────────────────────────────
    let replyText;
    let argusResult = null;
    try {
      argusResult = await runCloudArgus(atlasUserId, messageText, conversationHistory, {
        supabase,
        onStatus: (status) => {
          // Update the thinking message with tool status (best-effort, don't await)
          if (thinkingMsg?.ts) {
            safeUpdateMessage(channelId, thinkingMsg.ts, status).catch(() => {});
          }
        },
      });
      console.log('[events] runCloudArgus result:', JSON.stringify({
        success: argusResult.success,
        hasReply: !!argusResult.reply,
        replyLen: argusResult.reply?.length,
        error: argusResult.error,
        usage: argusResult.usage,
        type: argusResult.type,
      }));

      // Draft confirmation is handled conversationally — Argus shows the draft
      // in its reply, and when User A confirms, Argus calls send_slack_dm tool
      // in the next turn (with conversation history providing context).
      replyText = argusResult.success
        ? markdownToSlack(argusResult.reply)
        : `⚠️ Argus encountered an issue: ${argusResult.error || argusResult.reply || 'Unknown error'}`;
    } catch (err) {
      console.error('[events] runCloudArgus threw:', err.stack || err);
      replyText = `⚠️ Something went wrong: ${err.message}`;
    }

    // ── Update thinking message with final response ───────────────────────
    if (thinkingMsg?.ts) {
      await safeUpdateMessage(channelId, thinkingMsg.ts, replyText);
    } else {
      // Fallback: post a new message if we couldn't capture the thinking ts
      await safePostMessage(channelId, { text: replyText, thread_ts: threadTs });
    }
  } finally {
    activeArgusUsers.delete(atlasUserId);
  }
}

// ---------------------------------------------------------------------------
// Approval response handler (User A responding to an approval request thread)
// ---------------------------------------------------------------------------

/**
 * Handle a reply from User A to an approval request thread.
 *
 * User A can:
 *  - Approve ("approve", "yes", "send", "send it", "✅") → send Argus's suggested response to User B
 *  - Decline ("decline", "no", "don't send", "❌") → gracefully inform User B
 *  - Custom text → send User A's own words to User B
 *
 * @param {object} approval     - Pending approval record from relay service
 * @param {string} responseText - What User A typed
 * @param {string} channelId    - Channel to ACK User A in
 */
async function processApprovalResponse(approval, responseText, channelId) {
  try {
    const lc = responseText.toLowerCase().trim();

    if (lc === 'approve' || lc === 'yes' || lc === 'send' || lc === 'send it' || lc === '✅') {
      await relayService.processApproval(approval.id, 'approved', slack);
      await safePostMessage(channelId, { text: '✅ Sent.' });
    } else if (lc === 'decline' || lc === 'no' || lc === "don't send" || lc === '❌') {
      await relayService.processApproval(approval.id, 'declined', slack);
      await safePostMessage(channelId, { text: "✅ Noted — I'll let them know gracefully." });
    } else {
      // User A typed a custom response — send that instead of Argus's suggestion
      await relayService.processApproval(approval.id, 'modified', slack, responseText);
      await safePostMessage(channelId, { text: '✅ Sent your response.' });
    }
  } catch (err) {
    console.error('[events] processApprovalResponse error:', err.message);
    await safePostMessage(channelId, {
      text: '⚠️ Something went wrong processing your response. Please try again.',
    });
  }
}

// ---------------------------------------------------------------------------
// Relay reply handling (recipient replies to a relayed message thread)
// ---------------------------------------------------------------------------

/**
 * Check whether a threaded reply belongs to an active relay session and, if
 * so, forward it back to the original sender.
 *
 * DB columns used:
 *   recipient_slack_user_id  — Slack ID of the recipient (User B)
 *   slack_message_ts         — Timestamp of the bot message in User B's DM
 *   sender_atlas_user_id     — Atlas user ID of User A (sender)
 *   sender_slack_user_id     — Slack user ID of User A (for reply DM)
 *   recipient_dm_channel_id  — DM channel ID for User B
 *
 * @param {object} event
 * @param {string} slackUserId    - Recipient's Slack user id (replying user)
 * @param {string} channelId
 * @param {string} messageText
 * @param {string} threadTs       - Thread parent ts
 * @returns {Promise<boolean>} `true` if the event was handled as a relay reply.
 */
async function tryHandleRelayReply(event, slackUserId, channelId, messageText, threadTs) {
  const { data: relay, error } = await supabase
    .from('slack_message_relay')
    .select('*')
    .eq('recipient_slack_user_id', slackUserId)
    .eq('slack_message_ts', threadTs)
    .eq('status', 'sent')
    .maybeSingle();

  if (error) {
    console.error('[events] relay lookup error:', error.message);
    return false;
  }

  if (!relay) return false;

  await handleRelayReply(relay, messageText);
  return true;
}

/**
 * Forward a reply from the recipient (User B) back to the original sender (User A).
 *
 * Column references (all correct against DB schema):
 *   relay.sender_slack_user_id   — User A's Slack ID (post reply here)
 *   relay.recipient_dm_channel_id — User B's DM channel (used for context, not posting)
 *   relay.sender_atlas_user_id   — User A's Atlas ID
 *
 * @param {object} relay      - Row from `slack_message_relay`
 * @param {string} replyText  - Text the recipient typed
 */
async function handleRelayReply(relay, replyText) {
  try {
    // Send reply to original sender's DM channel (User A)
    // relay.sender_slack_user_id is User A's Slack ID; Slack resolves DM automatically
    await slack.chat.postMessage({
      channel: relay.sender_slack_user_id,
      text: replyText,
    });

    // Mark relay as replied
    const { error } = await supabase
      .from('slack_message_relay')
      .update({ status: 'replied', reply_text: replyText })
      .eq('id', relay.id);

    if (error) {
      console.error('[events] failed to update relay status:', error.message);
    }
  } catch (err) {
    console.error('[events] handleRelayReply error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

/**
 * Fetch recent conversation history for Argus context.
 * Returns the last 20 messages before (but not including) the current one.
 *
 * @param {string} channelId
 * @param {string} latestTs   - Timestamp of the current (new) message
 * @returns {Promise<Array<{ role: string, content: string }>>}
 */
async function fetchConversationHistory(channelId, latestTs) {
  try {
    const result = await slack.conversations.history({
      channel: channelId,
      latest: latestTs,
      inclusive: false,
      limit: 20,
    });

    if (!result.ok || !result.messages) return [];

    return result.messages
      .reverse() // chronological order
      .map((msg) => ({
        role: msg.bot_id ? 'assistant' : 'user',
        content: msg.text ?? '',
      }));
  } catch (err) {
    console.error('[events] fetchConversationHistory error:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a time-of-day greeting word (Eastern time).
 * @returns {string}
 */
function getTimeOfDayGreeting() {
  const hour = new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' });
  const h = parseInt(hour, 10);
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

// ---------------------------------------------------------------------------
// Markdown → Slack mrkdwn conversion
// ---------------------------------------------------------------------------

/**
 * Convert standard markdown formatting to Slack mrkdwn.
 *
 * Slack mrkdwn reference:
 *   Bold:          *text*
 *   Italic:        _text_
 *   Strikethrough: ~text~
 *   Inline code:   `text`
 *   Code block:    ```text```
 *   Block quote:   > text
 *   Lists:         * or - for bullets, 1. for numbered
 *   Links:         <url|text>
 *   Mentions:      <@user_id> or <!channel>
 *
 * @param {string} text
 * @returns {string}
 */
function markdownToSlack(text) {
  if (!text) return text;

  // Preserve code blocks from being mangled — extract, convert later
  const codeBlocks = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push('```' + code.trimEnd() + '```');
    return `__CODEBLOCK_${idx}__`;
  });

  // Preserve inline code
  const inlineCodes = [];
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push('`' + code + '`');
    return `__INLINECODE_${idx}__`;
  });

  result = result
    // Headings: ### Foo → *Foo*
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    // Bold: **text** or __text__ → *text* (must do before italic)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    // Italic: markdown _text_ is already Slack-compatible
    // Strikethrough: ~~text~~ → ~text~
    .replace(/~~(.+?)~~/g, '~$1~')
    // Links: [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    // Bare URLs not already in <> — wrap them for Slack
    .replace(/(?<![<|])https?:\/\/[^\s>)]+/g, '<$&>')
    // Horizontal rules: --- or *** or ___ → visual separator
    .replace(/^[-*_]{3,}$/gm, '───')
    // Block quotes: already > syntax, Slack-compatible
    // Numbered lists: already 1. syntax, Slack-compatible
    // Bullet lists: - or * at start of line, Slack-compatible (uses • for cleaner look)
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    // Clean up any resulting double-asterisks from nested bold
    .replace(/\*\*+/g, '*');

  // Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`__INLINECODE_${i}__`, inlineCodes[i]);
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`__CODEBLOCK_${i}__`, codeBlocks[i]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Safe Slack API wrappers
// ---------------------------------------------------------------------------

/**
 * Post a message without throwing. Returns the API response or null on error.
 * @param {string} channel
 * @param {object} params  - Additional chat.postMessage params
 * @returns {Promise<object|null>}
 */
async function safePostMessage(channel, params) {
  try {
    const result = await slack.chat.postMessage({ channel, ...params });
    return result.ok ? result.message : null;
  } catch (err) {
    console.error('[events] safePostMessage error:', err.message);
    return null;
  }
}

/**
 * Update an existing message without throwing.
 * @param {string} channel
 * @param {string} ts       - Timestamp of the message to update
 * @param {string} text     - New text content
 */
async function safeUpdateMessage(channel, ts, text) {
  try {
    // Slack blocks have a 3000 char limit per section — split if needed
    const blocks = [];
    let remaining = text;
    while (remaining.length > 0) {
      const chunk = remaining.substring(0, 3000);
      // Try to break at a newline if we're splitting
      let breakAt = 3000;
      if (remaining.length > 3000) {
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline > 2000) breakAt = lastNewline;
      }
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: remaining.substring(0, breakAt) },
      });
      remaining = remaining.substring(breakAt);
    }

    await slack.chat.update({
      channel,
      ts,
      text,  // plaintext fallback for notifications
      blocks,
    });
  } catch (err) {
    console.error('[events] safeUpdateMessage error:', err.message);
    // Fallback: post a fresh message
    await safePostMessage(channel, { text });
  }
}

module.exports = eventsHandler;
