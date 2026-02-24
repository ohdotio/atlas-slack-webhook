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
 *      • Post "thinking" message, run Argus, update with reply
 */

const { WebClient } = require('@slack/web-api');
const slackVerify = require('../middleware/slack-verify');
const { isDuplicate } = require('../utils/dedup');
const supabase = require('../utils/supabase');
const { resolveIdentity } = require('../services/identity');

const { runCloudArgus } = require('../services/argus-cloud');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

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

  // ── Resolve Atlas identity ─────────────────────────────────────────────
  const atlasUserId = await resolveIdentity(slackUserId, slackTeamId);
  if (!atlasUserId) {
    console.warn(`[events] No Atlas identity for Slack user ${slackUserId}`);
    await safePostMessage(channelId, {
      text: '🔒 Your Slack account isn\'t linked to an Atlas account yet. Please contact your administrator.',
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
    try {
      const result = await runCloudArgus(atlasUserId, messageText, conversationHistory, {
        supabase,
        onStatus: (status) => {
          // Update the thinking message with tool status (best-effort, don't await)
          if (thinkingMsg?.ts) {
            safeUpdateMessage(channelId, thinkingMsg.ts, status).catch(() => {});
          }
        },
      });
      console.log('[events] runCloudArgus result:', JSON.stringify({
        success: result.success,
        hasReply: !!result.reply,
        replyLen: result.reply?.length,
        error: result.error,
        usage: result.usage,
      }));
      replyText = result.success
        ? markdownToSlack(result.reply)
        : `⚠️ Argus encountered an issue: ${result.error || result.reply || 'Unknown error'}`;
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
// Relay reply handling
// ---------------------------------------------------------------------------

/**
 * Check whether a threaded reply belongs to an active relay session and, if
 * so, forward it back to the original sender.
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
 * Forward a reply from the recipient back to the original sender.
 *
 * @param {object} relay      - Row from `slack_message_relay`
 * @param {string} replyText  - Text the recipient typed
 */
async function handleRelayReply(relay, replyText) {
  try {
    // Send reply to original sender's DM channel
    await slack.chat.postMessage({
      channel: relay.sender_slack_user_id, // Slack will resolve to DM
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
// Markdown → Slack mrkdwn conversion
// ---------------------------------------------------------------------------

/**
 * Convert standard markdown formatting to Slack mrkdwn.
 * - **bold** → *bold*
 * - __bold__ → *bold*
 * - ### headings → *heading*
 * - --- → ─── (visual separator, not HR)
 * - [text](url) → <url|text>
 * @param {string} text
 * @returns {string}
 */
function markdownToSlack(text) {
  if (!text) return text;

  return text
    // Headings: ### Foo → *Foo*
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    // Bold: **text** or __text__ → *text*  (do ** first to avoid double-converting)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    // Italic: _text_ is already Slack-compatible, leave it
    // Strikethrough: ~~text~~ → ~text~
    .replace(/~~(.+?)~~/g, '~$1~')
    // Links: [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    // Horizontal rules: --- or *** → visual separator
    .replace(/^[-*]{3,}$/gm, '───')
    // Clean up any resulting double-asterisks from nested bold
    .replace(/\*\*+/g, '*');
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
