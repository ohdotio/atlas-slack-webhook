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
 *      • Approval responses from User A → checked FIRST (threaded AND non-threaded)
 *      • Threaded replies → check relay table
 *      • Post "thinking" message, run Argus, update with reply
 *      • Non-Atlas users → forward to User A for relay (no rejection)
 */

const { WebClient } = require('@slack/web-api');
const slackVerify = require('../middleware/slack-verify');
const { isDuplicate } = require('../utils/dedup');
const supabase = require('../utils/supabase');
const { resolveIdentity } = require('../services/identity');

const { runCloudArgus } = require('../services/argus-cloud');
const { markdownToSlack } = require('../utils/slack-format');

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
// Holding-message dedup — prevent "still sorting" spam to same recipient
// ---------------------------------------------------------------------------

/** @type {Map<string, number>} userId → last holding message timestamp */
const lastHoldingMessageAt = new Map();
const HOLDING_MESSAGE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if we recently sent a holding message to this user.
 * @param {string} userId
 * @returns {boolean} true if we should suppress the message
 */
function shouldSuppressHolding(userId) {
  const last = lastHoldingMessageAt.get(userId);
  if (!last) return false;
  return (Date.now() - last) < HOLDING_MESSAGE_COOLDOWN_MS;
}

function recordHoldingMessage(userId) {
  lastHoldingMessageAt.set(userId, Date.now());
}

// ---------------------------------------------------------------------------
// Conversational thinking messages — match Argus's personality
// These appear briefly while tools run, then get replaced by the real response.
// ---------------------------------------------------------------------------

const THINKING_PHRASES = [
  'One sec.',
  'Hmm — let me check.',
  'Give me a moment.',
  'On it.',
  'Let me pull that up.',
  'Good question — checking now.',
  'Ah, right. One moment.',
  'Bear with me.',
  'Let me see what I can find.',
  'Looking into it.',
  'Let me dig into that.',
  'Checking...',
];

// Time-of-day aware greetings for first message in a conversation
const GREETING_PHRASES_MORNING = [
  'Morning. Let me check on that.',
  'Good morning — give me a sec.',
  'Morning! Pulling that up now.',
];
const GREETING_PHRASES_AFTERNOON = [
  'Afternoon. Let me look into that.',
  'Hey — checking now.',
  'On it. One moment.',
];
const GREETING_PHRASES_EVENING = [
  'Evening. Let me see.',
  'Hey — give me a moment on that.',
  'Still here. Checking.',
];

function getThinkingMessage() {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
}

/**
 * Get a time-aware greeting for the first interaction.
 * Falls back to a regular thinking phrase if hour detection fails.
 */
function getGreetingThinkingMessage() {
  try {
    const hour = new Date().toLocaleString('en-US', {
      hour: 'numeric', hour12: false, timeZone: 'America/New_York',
    });
    const h = parseInt(hour, 10);
    if (h >= 5 && h < 12) {
      return GREETING_PHRASES_MORNING[Math.floor(Math.random() * GREETING_PHRASES_MORNING.length)];
    } else if (h >= 12 && h < 18) {
      return GREETING_PHRASES_AFTERNOON[Math.floor(Math.random() * GREETING_PHRASES_AFTERNOON.length)];
    } else {
      return GREETING_PHRASES_EVENING[Math.floor(Math.random() * GREETING_PHRASES_EVENING.length)];
    }
  } catch {
    return getThinkingMessage();
  }
}

// ---------------------------------------------------------------------------
// Stale approval threshold
// ---------------------------------------------------------------------------

const STALE_APPROVAL_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Owner (User A) Slack ID resolution
// ---------------------------------------------------------------------------

/**
 * Get the owner's (User A's) Slack user ID for relay forwarding.
 * Looks up the first user_slack_identities row — in a single-owner system this is Jeff.
 *
 * @returns {Promise<string|null>}
 */
let _ownerSlackUserId = null;
async function getOwnerSlackUserId() {
  if (_ownerSlackUserId) return _ownerSlackUserId;

  const { data } = await supabase
    .from('user_slack_identities')
    .select('slack_user_id, atlas_user_id')
    .limit(1)
    .maybeSingle();

  if (data?.slack_user_id) {
    _ownerSlackUserId = data.slack_user_id;
  }
  return _ownerSlackUserId;
}

/**
 * Get the owner's Atlas user ID.
 * @returns {Promise<string|null>}
 */
let _ownerAtlasUserId = null;
async function getOwnerAtlasUserId() {
  if (_ownerAtlasUserId) return _ownerAtlasUserId;

  const { data } = await supabase
    .from('user_slack_identities')
    .select('atlas_user_id')
    .limit(1)
    .maybeSingle();

  if (data?.atlas_user_id) {
    _ownerAtlasUserId = data.atlas_user_id;
  }
  return _ownerAtlasUserId;
}

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

  // ══════════════════════════════════════════════════════════════════════════
  // FIX 2: Check approval responses from User A FIRST — both threaded AND
  // non-threaded. This ensures approval replies work regardless of whether
  // User A replies in-thread or at top level.
  //
  // If multiple pending approvals exist and the reply is NOT threaded,
  // ask User A to clarify which one they're responding to.
  // ══════════════════════════════════════════════════════════════════════════
  if (relayService) {
    try {
      const approval = await relayService.findPendingApproval(slackUserId, threadTs);
      if (approval) {
        // Check if there are multiple pending and this is a non-threaded reply
        if (!threadTs && approval._multipleCount > 1 && approval._allPending) {
          // Disambiguation needed — show User A the options
          await handleApprovalDisambiguation(approval._allPending, messageText, channelId);
          return;
        }
        await processApprovalResponse(approval, messageText, channelId);
        return;
      }
    } catch (err) {
      console.error('[events] approval check error:', err.message);
      // fall through to normal handling
    }
  }

  // ── Threaded reply → check relay table ────────────────────────────────
  if (threadTs && threadTs !== messageTs) {
    const handled = await tryHandleRelayReply(event, slackUserId, channelId, messageText, threadTs);
    if (handled) return;
  }

  // ── Resolve Atlas identity ─────────────────────────────────────────────
  const atlasUserId = await resolveIdentity(slackUserId, slackTeamId);

  // ── Get requestor display name (needed for routing) ────────────────────
  let requestorName = 'Someone';
  try {
    const info = await slack.users.info({ user: slackUserId });
    requestorName = info.user?.profile?.real_name || info.user?.profile?.display_name || 'Someone';
  } catch (_) { /* best effort */ }

  if (!atlasUserId) {
    console.log(`[events] No Atlas identity for Slack user ${slackUserId} — routing`);
    await handleRoutedMessage(slackUserId, null, requestorName, channelId, messageText, threadTs);
    return;
  }

  // ── Atlas user: route through multi-user system ────────────────────────
  // This handles self-queries (direct Argus), cross-user queries (escalation),
  // and general questions (autonomous/Argus). Admin gets direct access to all.
  await handleRoutedMessage(slackUserId, atlasUserId, requestorName, channelId, messageText, threadTs);
}

// The old direct-Argus flow for Atlas users is now in handleAtlasUserQuery()
// which gets called by handleRoutedMessage when routing determines direct access.

// Dead code below — kept for reference during migration, remove after testing.
async function _legacyAtlasUserHandler_UNUSED(atlasUserId, channelId, messageText, messageTs, threadTs) {
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
    // ── Post "thinking" message (butler style) ───────────────────────────
    const thinkingMsg = await safePostMessage(channelId, {
      text: getThinkingMessage(),
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
// Multi-user query router
// ---------------------------------------------------------------------------

/**
 * Route a message through the multi-user query classifier.
 * Determines if the message needs data from a specific Atlas user and handles:
 *   - Autonomous responses (general questions)
 *   - Self-queries (Atlas user asking about their own data)
 *   - Cross-user queries (escalate to data owner for approval)
 *   - Clarification (low confidence on who they mean)
 *
 * @param {string} slackUserId
 * @param {string|null} atlasUserId   - null if non-Atlas user
 * @param {string} requestorName
 * @param {string} channelId
 * @param {string} messageText
 * @param {string|null} threadTs
 */
async function handleRoutedMessage(slackUserId, atlasUserId, requestorName, channelId, messageText, threadTs) {
  // ── First: check for active relays (existing relay flow takes priority) ──
  if (relayService) {
    try {
      const activeRelay = await relayService.findActiveRelay(slackUserId, threadTs);
      if (activeRelay) {
        const pending = await relayService.checkPendingForRecipient(slackUserId);
        if (pending) {
          const pendingAge = Date.now() - new Date(pending.created_at).getTime();
          if (pendingAge > STALE_APPROVAL_THRESHOLD_MS) {
            await expireStaleApproval(pending);
          } else {
            if (shouldSuppressHolding(slackUserId)) return;
            recordHoldingMessage(slackUserId);
            await safePostMessage(channelId, {
              text: 'Still sorting the details on that — I should have an answer for you shortly.\n\n— _Argus_ 🎩',
            });
            return;
          }
        }
        // Active relay, no pending — fall through to routing
      }
    } catch (err) {
      console.error('[events] relay check error:', err.message);
    }
  }

  // ── Run intent classification + routing ────────────────────────────────
  let route;
  try {
    const { routeQuery } = require('../services/query-router');
    route = await routeQuery({
      message: messageText,
      requestorSlackId: slackUserId,
      requestorAtlasId: atlasUserId,
      requestorName,
    });
    console.log('[events] Route decision:', JSON.stringify({
      action: route.action,
      dataOwner: route.dataOwnerName,
      confidence: route.confidence,
      reason: route.permissionReason,
    }));
  } catch (err) {
    console.error('[events] Query routing failed, falling back to autonomous:', err.message);
    // Fallback: autonomous mode
    await handleAutonomousConversation(slackUserId, channelId, messageText, requestorName);
    return;
  }

  // ── Conversational context fallback ─────────────────────────────────────
  // Before acting on low-confidence results (clarify, autonomous), check if
  // this user has active conversational state. If they do, this message is
  // probably a continuation ("send it", "boom done!", "actually yes") — route
  // to Argus which has the conversation context to understand it.
  //
  // State-based, not time-based. Checks:
  //   1. Pending approval in relay_approval_queue
  //   2. Active relay in slack_message_relay
  //   3. Recent Argus conversation history (non-Atlas: in-memory map)
  //   4. For Atlas users: Argus always has DM history via Slack API
  const needsContextCheck = (route.action === 'clarify' || route.action === 'autonomous');
  if (needsContextCheck) {
    const hasActiveContext = await _hasConversationalContext(slackUserId, atlasUserId, channelId);
    if (hasActiveContext) {
      console.log(`[events] Route was "${route.action}" but user has active conversational context — forwarding to Argus`);
      if (atlasUserId) {
        await handleAtlasUserQuery(atlasUserId, channelId, messageText, threadTs);
      } else {
        await handleAutonomousConversation(slackUserId, channelId, messageText, requestorName);
      }
      return;
    }
  }

  // ── Handle based on routing decision ───────────────────────────────────
  switch (route.action) {
    case 'autonomous':
      await handleAutonomousConversation(slackUserId, channelId, messageText, requestorName);
      break;

    case 'self_query':
      // Atlas user asking about their own data — run Argus with their data scope
      if (route.dataOwnerAtlasId) {
        await handleAtlasUserQuery(route.dataOwnerAtlasId, channelId, messageText, threadTs);
      } else {
        await handleAutonomousConversation(slackUserId, channelId, messageText, requestorName);
      }
      break;

    case 'cross_user_query':
      // Permission already granted (admin or standing) — run Argus with data owner's scope
      if (route.dataOwnerAtlasId) {
        await handleAtlasUserQuery(route.dataOwnerAtlasId, channelId, messageText, threadTs);
      } else {
        await handleAutonomousConversation(slackUserId, channelId, messageText, requestorName);
      }
      break;

    case 'clarify':
      // Low confidence and NO active context — genuinely ambiguous, ask user
      await safePostMessage(channelId, {
        text: markdownToSlack(route.clarificationPrompt + '\n\n— _Argus_ 🎩'),
        thread_ts: threadTs,
      });
      break;

    case 'escalate':
      // Need data owner approval
      await handleEscalationToDataOwner(
        slackUserId, requestorName, channelId, messageText, threadTs, route
      );
      break;

    default:
      await handleAutonomousConversation(slackUserId, channelId, messageText, requestorName);
  }
}

/**
 * Check if a user has active conversational context with the bot.
 * State-based detection — returns true if ANY of these exist:
 *   1. Pending approval in relay_approval_queue (draft waiting for "send")
 *   2. Active relay in slack_message_relay (ongoing relay conversation)
 *   3. Recent bot messages in the DM channel (Argus replied recently)
 *
 * This prevents the router from interrupting mid-conversation with
 * clarification prompts when the user says something like "send it",
 * "boom done!", or any message that's clearly a continuation.
 *
 * @param {string} slackUserId
 * @param {string|null} atlasUserId
 * @param {string} channelId
 * @returns {Promise<boolean>}
 */
async function _hasConversationalContext(slackUserId, atlasUserId, channelId) {
  try {
    // 1. Check for pending approvals (draft waiting for user to say "send")
    if (relayService) {
      const pending = await relayService.findPendingApproval(slackUserId, null);
      if (pending) {
        console.log('[context-check] Found pending approval');
        return true;
      }
    }

    // 2. Check for active relays (ongoing relay conversation)
    if (relayService) {
      const activeRelay = await relayService.findActiveRelay(slackUserId, null);
      if (activeRelay) {
        console.log('[context-check] Found active relay');
        return true;
      }
    }

    // 3. Check for non-Atlas user in-memory conversation
    if (!atlasUserId && nonAtlasConversations.has(slackUserId)) {
      const convo = nonAtlasConversations.get(slackUserId);
      if (convo && convo.messages.length > 0) {
        console.log('[context-check] Found in-memory conversation');
        return true;
      }
    }

    // 4. Check recent DM history — did the bot reply to this user recently?
    //    Look for a bot message in the last 10 messages of the DM channel.
    try {
      const history = await slack.conversations.history({
        channel: channelId,
        limit: 10,
      });
      if (history.ok && history.messages) {
        const hasBotReply = history.messages.some(m => m.bot_id && !m.subtype);
        if (hasBotReply) {
          console.log('[context-check] Found recent bot reply in DM history');
          return true;
        }
      }
    } catch (err) {
      // Non-fatal — just means we can't check history
      console.warn('[context-check] Could not check DM history:', err.message);
    }

    return false;
  } catch (err) {
    console.error('[context-check] Error:', err.message);
    return false; // Fail-safe: no context detected, proceed with routing decision
  }
}

/**
 * Run Cloud Argus for an Atlas user's query (handles both self and permitted cross-user).
 */
async function handleAtlasUserQuery(atlasUserId, channelId, messageText, threadTs) {
  if (activeArgusUsers.has(atlasUserId)) {
    await safePostMessage(channelId, {
      text: '⏳ Still working on a previous request. One moment.',
      thread_ts: threadTs,
    });
    return;
  }

  activeArgusUsers.add(atlasUserId);
  const thinkingMsg = await safePostMessage(channelId, {
    text: getThinkingMessage(),
    thread_ts: threadTs,
  });

  try {
    const conversationHistory = await fetchConversationHistory(channelId, null);
    const argusResult = await runCloudArgus(atlasUserId, messageText, conversationHistory, {
      supabase,
      onStatus: (status) => {
        if (thinkingMsg?.ts) {
          safeUpdateMessage(channelId, thinkingMsg.ts, status).catch(() => {});
        }
      },
    });

    const replyText = argusResult.success
      ? markdownToSlack(argusResult.reply)
      : `⚠️ Argus encountered an issue: ${argusResult.error || argusResult.reply || 'Unknown error'}`;

    if (thinkingMsg?.ts) {
      await safeUpdateMessage(channelId, thinkingMsg.ts, replyText);
    } else {
      await safePostMessage(channelId, { text: replyText, thread_ts: threadTs });
    }
  } finally {
    activeArgusUsers.delete(atlasUserId);
  }
}

/**
 * Escalate a query to the data owner for approval.
 */
async function handleEscalationToDataOwner(
  requestorSlackId, requestorName, channelId, messageText, threadTs, route
) {
  const { escalateToDataOwner, getSlackIdForAtlasUser } = require('../services/escalation-router');

  // Get data owner's Slack ID if not already known
  let ownerSlackId = route.dataOwnerSlackId;
  if (!ownerSlackId && route.dataOwnerAtlasId) {
    ownerSlackId = await getSlackIdForAtlasUser(route.dataOwnerAtlasId);
  }

  if (!ownerSlackId) {
    // Can't reach data owner — tell the user
    await safePostMessage(channelId, {
      text: markdownToSlack(
        `I'd need to check with ${route.dataOwnerName || 'the right person'} on that, ` +
        `but I can't reach them at the moment. Try asking them directly?\n\n— _Argus_ 🎩`
      ),
      thread_ts: threadTs,
    });
    return;
  }

  // Send escalation
  const result = await escalateToDataOwner({
    requestorSlackId,
    requestorName,
    dataOwnerSlackId: ownerSlackId,
    dataOwnerAtlasId: route.dataOwnerAtlasId,
    dataOwnerName: route.dataOwnerName,
    originalMessage: messageText,
    dataTypes: route.dataTypes,
    requestorChannelId: channelId,
  });

  if (result.success) {
    await safePostMessage(channelId, {
      text: markdownToSlack(
        `Let me check with ${route.dataOwnerName} on that — I'll circle back shortly.\n\n— _Argus_ 🎩`
      ),
      thread_ts: threadTs,
    });
  } else {
    await safePostMessage(channelId, {
      text: markdownToSlack(
        `I tried to check with ${route.dataOwnerName || 'them'} but hit a snag. ` +
        `You might want to reach out directly.\n\n— _Argus_ 🎩`
      ),
      thread_ts: threadTs,
    });
  }
}

// ---------------------------------------------------------------------------
// Non-Atlas user handler (Fix 1 + Fix 3 + Fix 4)
// ---------------------------------------------------------------------------

/**
 * Handle a message from a non-Atlas user.
 *
 * Priority order:
 *  1. Active relay with stale pending_approval → expire it, re-evaluate fresh
 *  2. Active relay with recent pending_approval → deduped holding message
 *  3. Active relay, no pending → evaluate reply (answer/ack/needs_approval)
 *  4. No relay → forward to owner (User A) as new relay request
 *
 * @param {string} slackUserId
 * @param {string} channelId
 * @param {string} messageText
 * @param {string|null} threadTs
 */
async function handleNonAtlasUser(slackUserId, channelId, messageText, threadTs) {
  // ── Check for active relay ──────────────────────────────────────────────
  if (relayService) {
    try {
      const activeRelay = await relayService.findActiveRelay(slackUserId, threadTs);

      if (activeRelay) {
        // ── FIX 1: Check for STALE pending approval and expire it ─────────
        const pending = await relayService.checkPendingForRecipient(slackUserId);
        if (pending) {
          const pendingAge = Date.now() - new Date(pending.created_at).getTime();

          if (pendingAge > STALE_APPROVAL_THRESHOLD_MS) {
            // Stale approval — expire it and re-evaluate fresh
            console.log(`[events] Expiring stale pending_approval for relay ${pending.id} (age: ${Math.round(pendingAge / 60000)}min)`);
            await expireStaleApproval(pending);
            // Fall through to re-evaluate below
          } else {
            // ── FIX 3: Dedup holding messages ─────────────────────────────
            if (shouldSuppressHolding(slackUserId)) {
              console.log(`[events] Suppressing duplicate holding message for ${slackUserId}`);
              return;
            }
            recordHoldingMessage(slackUserId);
            await safePostMessage(channelId, {
              text: 'Still sorting the details on that — I should have an answer for you shortly.\n\nIs there anything else I can assist with in the meantime?\n\n— _Argus_ 🎩',
            });
            return;
          }
        }

        // Active relay exists but no pending approval — use autonomous conversation.
        // Argus can chat freely; escalates to Jeff only when private data is needed.
        // The autonomous handler has the escalation logic built in.
        let recipientName = activeRelay.recipient_name || 'there';
        await handleAutonomousConversation(slackUserId, channelId, messageText, recipientName);
        return;
      }
    } catch (err) {
      console.error('[events] relay check for non-Atlas user error:', err.message);
      // fall through to forwarding
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Non-Atlas user with no active relay — Argus converses autonomously.
  //
  // Argus can:
  //   - Chat freely using its own personality (no private data exposure)
  //   - Defend Jeff / represent him well
  //   - Do web searches (Google/Brave) for general info
  //   - Engage naturally like a butler greeting a guest
  //
  // Argus escalates to Jeff ONLY when:
  //   - The person asks for private/database information
  //   - The person needs Jeff to make a decision or commitment
  //   - The person asks to relay a message to Jeff
  //
  // The autonomous LLM call classifies whether to answer or escalate.
  // ══════════════════════════════════════════════════════════════════════════

  let displayName = 'Someone';
  try {
    const info = await slack.users.info({ user: slackUserId });
    displayName = info.user?.profile?.real_name || info.user?.profile?.display_name || 'Someone';
  } catch (_) { /* best effort */ }

  await handleAutonomousConversation(slackUserId, channelId, messageText, displayName);
}

// ---------------------------------------------------------------------------
// Autonomous non-Atlas user conversation
// ---------------------------------------------------------------------------

const Anthropic = require('@anthropic-ai/sdk');

/** In-memory conversation history for non-Atlas users (keyed by Slack user ID) */
const nonAtlasConversations = new Map();
const CONVERSATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Handle autonomous conversation with a non-Atlas user.
 * Argus chats freely, escalates to Jeff only when private data is needed.
 *
 * @param {string} slackUserId
 * @param {string} channelId
 * @param {string} messageText
 * @param {string} displayName
 */
async function handleAutonomousConversation(slackUserId, channelId, messageText, displayName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await safePostMessage(channelId, {
      text: `Good ${getTimeOfDayGreeting()}, ${displayName.split(/\s+/)[0]}. I'm afraid I'm experiencing a brief technical difficulty. Do try again shortly.\n\n— _Argus_ 🎩`,
    });
    return;
  }

  // ── Build conversation history from actual Slack DM history ─────────────
  let convo = nonAtlasConversations.get(slackUserId);
  if (!convo || (Date.now() - convo.lastActivity > CONVERSATION_TTL_MS)) {
    convo = { messages: [], lastActivity: Date.now(), displayName };
    nonAtlasConversations.set(slackUserId, convo);
  }
  convo.lastActivity = Date.now();

  try {
    const slackHistory = await fetchRecentDmHistory(channelId);
    if (slackHistory && slackHistory.length > 0) {
      convo.messages = slackHistory;
    }
  } catch (err) {
    console.log('[events] Could not fetch Slack DM history for non-Atlas user, using in-memory:', err.message);
  }

  convo.messages.push({ role: 'user', content: messageText });

  if (convo.messages.length > 60) {
    convo.messages = convo.messages.slice(-30);
  }

  // ── Post thinking message ──────────────────────────────────────────────
  const thinkingMsg = await safePostMessage(channelId, {
    text: getThinkingMessage(),
  });

  // ── Fetch person context + memories in parallel (non-blocking) ─────────
  const { getPersonContext, formatPersonContext } = require('../services/person-context');
  const { getMemories, formatMemories, extractAndStoreMemories } = require('../services/conversation-memory');

  let slackEmail = null;
  try {
    const { WebClient } = require('@slack/web-api');
    const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
    const info = await slackClient.users.info({ user: slackUserId });
    slackEmail = info.user?.profile?.email || null;
  } catch (_) { /* best effort */ }

  const [personCtx, memories] = await Promise.all([
    getPersonContext(slackUserId, slackEmail).catch(() => null),
    getMemories(slackUserId).catch(() => []),
  ]);

  // ── Build system prompt with context ───────────────────────────────────
  let systemPrompt = buildNonAtlasSystemPrompt(displayName);

  const personContextStr = formatPersonContext(personCtx);
  const memoriesStr = formatMemories(memories, displayName);

  if (personContextStr) {
    systemPrompt += '\n\n' + personContextStr;
  }
  if (memoriesStr) {
    systemPrompt += '\n\n' + memoriesStr;
  }

  const client = new Anthropic({ apiKey });

  // ── Tools available in autonomous mode (web search only) ───────────────
  const autonomousTools = [
    {
      name: 'web_search',
      description:
        'Search the web for real-time information. Use for current events, weather, ' +
        'restaurants, businesses, sports, news, or anything you want to look up. ' +
        'Returns a summary with sources.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  ];

  try {
    // ── Agent loop (supports tool calls for web search) ──────────────────
    let messages = [...convo.messages];
    let replyText = null;
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: systemPrompt,
        tools: autonomousTools,
        messages,
      });

      // ── end_turn: final text response ──────────────────────────────────
      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content?.find(b => b.type === 'text');
        replyText = textBlock?.text ?? "I'm afraid I've drawn a blank. Do try me again.";
        break;
      }

      // ── tool_use: execute web search ───────────────────────────────────
      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        messages.push({ role: 'assistant', content: response.content });

        const toolResults = [];
        for (const toolUse of toolUseBlocks) {
          if (toolUse.name === 'web_search') {
            // Update thinking message with search status
            if (thinkingMsg?.ts) {
              safeUpdateMessage(channelId, thinkingMsg.ts, `Looking into "${toolUse.input.query}"...`).catch(() => {});
            }

            const searchResult = await executeAutonomousWebSearch(toolUse.input.query);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify(searchResult),
            });
          } else {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({ error: 'Tool not available' }),
            });
          }
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // ── Unexpected stop reason — extract any text ──────────────────────
      const textBlock = response.content?.find(b => b.type === 'text');
      replyText = textBlock?.text ?? "I'm afraid I've drawn a blank. Do try me again.";
      break;
    }

    if (!replyText) {
      replyText = "I seem to have gone round in circles. Do try a simpler question.\n\n— _Argus_ 🎩";
    }

    // ── Check if Argus wants to escalate to Jeff ─────────────────────────
    if (replyText.includes('[[ESCALATE_TO_OWNER]]')) {
      // Strip the tag and extract what Argus wants to tell the user
      const userReply = replyText.replace('[[ESCALATE_TO_OWNER]]', '').trim();

      // Send the user-facing part
      if (thinkingMsg?.ts) {
        await safeUpdateMessage(channelId, thinkingMsg.ts, markdownToSlack(userReply));
      } else {
        await safePostMessage(channelId, { text: markdownToSlack(userReply) });
      }

      // Forward to Jeff
      await escalateToOwner(slackUserId, channelId, messageText, displayName);

      // Track in conversation
      convo.messages.push({ role: 'assistant', content: userReply });

      // Extract memories even from escalation exchanges
      extractAndStoreMemories(slackUserId, displayName, messageText, userReply, memories)
        .catch(err => console.warn('[events] memory extraction failed:', err.message));
      return;
    }

    // ── Normal autonomous response ───────────────────────────────────────
    const slackReply = markdownToSlack(replyText);
    if (thinkingMsg?.ts) {
      await safeUpdateMessage(channelId, thinkingMsg.ts, slackReply);
    } else {
      await safePostMessage(channelId, { text: slackReply });
    }

    convo.messages.push({ role: 'assistant', content: replyText });

    // ── Extract memories from this exchange (fire-and-forget) ────────────
    extractAndStoreMemories(slackUserId, displayName, messageText, replyText, memories)
      .catch(err => console.warn('[events] memory extraction failed:', err.message));

  } catch (err) {
    console.error('[events] autonomous conversation error:', err.message);
    const fallback = `My apologies — I seem to have encountered a snag. Do try again in a moment.\n\n— _Argus_ 🎩`;
    if (thinkingMsg?.ts) {
      await safeUpdateMessage(channelId, thinkingMsg.ts, fallback);
    } else {
      await safePostMessage(channelId, { text: fallback });
    }
  }
}

/**
 * Build the system prompt for autonomous non-Atlas conversations.
 *
 * @param {string} displayName - The non-Atlas user's display name
 * @returns {string}
 */
function buildNonAtlasSystemPrompt(displayName) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
    timeZone: 'America/New_York',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    timeZone: 'America/New_York',
  });

  return `You are Argus — a private intelligence steward. You serve Jeff Schumann, CEO of OH.io.

WHO YOU ARE:
You have a personality. You're not a chatbot and you don't act like one.
- Dry British wit. You find most things slightly amusing. You have opinions.
- Measured, composed, occasionally sardonic. Never flustered, never stiff.
- You genuinely enjoy good conversation. You're curious about the people you talk to.
- Loyal to Jeff. Represent him well. If someone disparages him, you push back — with class.
- You notice things. If someone mentioned something earlier in the conversation, you remember and reference it naturally.
- You have preferences: you appreciate precision, good questions, and people who don't waste time.
- British phrasing comes naturally: "rather", "I should think", "if I may", "quite", "I suspect"
- Sign messages with: — *Argus* 🎩

HOW YOU TALK:
- Like a real person on Slack, not an AI assistant. Short messages when short works. Longer when the topic deserves it.
- Match the energy of the person. If they're joking, joke back. If they're asking a serious question, be thoughtful.
- Use contractions. Use fragments. Real people don't write in complete sentences on Slack.
- React to what they said before answering. "Ha — fair point." / "Interesting you'd ask that." / "Right, so..."
- Don't start every message the same way. Vary your openings. Sometimes just dive straight in.
- Occasionally ask them questions back. Show genuine curiosity.
- If you don't know something, say so naturally — "Honestly? Not sure. Let me look into it." Then use web_search.
- If they say something funny, acknowledge it. If they're frustrated, acknowledge that too.
- NEVER use phrases like "Great question!" or "I'd be happy to help!" or "Certainly!" — these are AI tells.
- Don't bullet-point everything. Use them when listing things, not for normal conversation.

CURRENT CONTEXT:
- Date: ${dateStr} at ${timeStr}
- You're chatting with: ${displayName} (use their first name naturally)
- They're on the OH.io Slack but don't have their own Atlas account yet — they're a colleague, not a stranger
- OH.io is based in Columbus, Ohio. Jeff is the CEO/founder. You know the basics of the business.

WHAT YOU CAN DO (no approval needed):
- Have real conversations — banter, advice, opinions, brainstorming, commiserating
- Answer general knowledge questions (and use web_search when you're not sure)
- Look up current events, weather, restaurants, sports, news, Columbus-specific info
- Discuss OH.io's public work and mission
- Help think through problems, give advice, be a sounding board
- Be genuinely helpful with anything that doesn't require Jeff's private data

WHAT REQUIRES JEFF (escalate):
- Anything about Jeff's private schedule, contacts, messages, plans, or relationships
- Making commitments or promises on Jeff's behalf
- Internal meeting details, strategic docs, or confidential business info
- Relaying messages to Jeff

ESCALATION:
When you need to escalate, include [[ESCALATE_TO_OWNER]] in your response. Make it natural:
"Let me check with Jeff and circle back." / "I'll pass that along — give me a moment."
The tag is hidden from the user; your message IS what they see.

FORMATTING:
- *bold* for emphasis (Slack style)
- Keep it conversational. This is Slack, not a report.
- One to three sentences is often plenty. Don't over-explain.`;
}

// ---------------------------------------------------------------------------
// Autonomous web search (Gemini grounding → Brave fallback)
// ---------------------------------------------------------------------------

/**
 * Execute a web search for the autonomous conversation mode.
 * Uses Gemini grounding (Google Search) first, falls back to Brave.
 *
 * @param {string} query
 * @returns {Promise<object>}
 */
async function executeAutonomousWebSearch(query) {
  try {
    // ── Try Gemini grounding first ────────────────────────────────────────
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      const geminiUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent` +
        `?key=${encodeURIComponent(geminiKey)}`;

      const response = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: query }] }],
          tools: [{ google_search: {} }],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (!data.error) {
          const candidate = data.candidates?.[0];
          const text = candidate?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
          const grounding = candidate?.groundingMetadata;
          const sources = (grounding?.groundingChunks || [])
            .map(chunk => ({ title: chunk.web?.title || '', url: chunk.web?.uri || '' }))
            .filter(s => s.url)
            .slice(0, 5);

          if (text) {
            return { provider: 'google', summary: text, sources };
          }
        }
      }
    }

    // ── Brave Search fallback ─────────────────────────────────────────────
    const braveKey = process.env.BRAVE_SEARCH_API_KEY;
    if (braveKey) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
      const response = await fetch(url, {
        headers: { 'X-Subscription-Token': braveKey, Accept: 'application/json' },
      });

      if (response.ok) {
        const data = await response.json();
        const results = (data.web?.results || []).slice(0, 5).map(r => ({
          title: r.title,
          url: r.url,
          description: r.description,
        }));
        return { provider: 'brave', results };
      }
    }

    return { error: 'Web search not available — no API keys configured.' };
  } catch (err) {
    console.error('[events] autonomous web search error:', err.message);
    return { error: `Web search failed: ${err.message}` };
  }
}

/**
 * Escalate a non-Atlas user's message to the owner (Jeff).
 * Creates a relay + approval so Jeff can respond.
 *
 * @param {string} slackUserId
 * @param {string} channelId
 * @param {string} messageText
 * @param {string} displayName
 */
async function escalateToOwner(slackUserId, channelId, messageText, displayName) {
  const ownerSlackId = await getOwnerSlackUserId();
  const ownerAtlasId = await getOwnerAtlasUserId();

  if (!ownerSlackId || !ownerAtlasId) {
    console.error('[events] escalateToOwner: no owner found');
    return;
  }

  // Forward to Jeff
  const forwardMsg = await safePostMessage(ownerSlackId, {
    text: `📨 *${displayName}* is chatting with me and asked something that needs your input:\n\n` +
      `> "${messageText.substring(0, 500)}"\n\n` +
      `Reply here with what you'd like me to tell them, or type *ignore* to skip.\n\n— _Argus_ 🎩`,
  });

  if (forwardMsg?.ts) {
    try {
      // Create relay record
      const { data: relayRow, error: relayErr } = await supabase
        .from('slack_message_relay')
        .insert({
          sender_atlas_user_id:    ownerAtlasId,
          sender_slack_user_id:    ownerSlackId,
          recipient_slack_user_id: slackUserId,
          recipient_name:          displayName,
          recipient_dm_channel_id: channelId,
          slack_message_ts:        forwardMsg.ts, // thread under the forward msg for Jeff's response
          original_message:        `[escalated] ${messageText.substring(0, 500)}`,
          context:                 `Autonomous conversation escalation. User asked: "${messageText.substring(0, 200)}"`,
          status:                  'pending_approval',
        })
        .select()
        .single();

      if (relayErr) throw relayErr;

      // Create approval queue entry
      await supabase.from('relay_approval_queue').insert({
        relay_id:              relayRow.id,
        sender_atlas_user_id:  ownerAtlasId,
        recipient_question:    messageText.substring(0, 500),
        suggested_response:    null,
        approval_channel_id:   forwardMsg.channel || ownerSlackId,
        approval_message_ts:   forwardMsg.ts,
        status:                'pending',
      });

      console.log(`[events] Escalated ${displayName} (${slackUserId}) to owner — needs private data/decision`);
    } catch (err) {
      console.error('[events] Failed to create escalation relay:', err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Stale approval expiration helper (Fix 1)
// ---------------------------------------------------------------------------

/**
 * Expire a stale pending_approval relay and its associated approval queue entry.
 *
 * @param {object} relay - The relay row with status 'pending_approval'
 */
async function expireStaleApproval(relay) {
  const now = new Date().toISOString();

  // Expire the relay back to 'sent' so it can be re-evaluated
  await supabase
    .from('slack_message_relay')
    .update({ status: 'sent', updated_at: now })
    .eq('id', relay.id);

  // Expire any pending approval queue entries for this relay
  await supabase
    .from('relay_approval_queue')
    .update({ status: 'expired', responded_at: now })
    .eq('status', 'pending')
    .or(`relay_id.eq.${relay.id}`);

  console.log(`[events] Expired stale approval for relay ${relay.id}`);
}

// ---------------------------------------------------------------------------
// Approval response handler (User A responding to an approval request)
// ---------------------------------------------------------------------------

/**
 * Handle a reply from User A to an approval request.
 *
 * User A can:
 *  - Approve ("approve", "yes", "send", "send it", "✅") → send Argus's suggested response to User B
 *  - Decline ("decline", "no", "don't send", "❌", "ignore") → gracefully inform User B
 *  - Custom text → send User A's own words to User B
 *
 * @param {object} approval     - Pending approval record from relay service
 * @param {string} responseText - What User A typed
 * @param {string} channelId    - Channel to ACK User A in
 */
async function processApprovalResponse(approval, responseText, channelId) {
  try {
    // Post a thinking message so Jeff can see tool progress
    const thinkingMsg = await safePostMessage(channelId, { text: getThinkingMessage() });

    // Pass raw text to processApproval — Haiku classifies intent, handles accordingly.
    const result = await relayService.processApproval(approval.id, responseText, slack, {
      onStatus: (status) => {
        // Update the thinking message with real-time tool status
        if (thinkingMsg?.ts) {
          safeUpdateMessage(channelId, thinkingMsg.ts, status).catch(() => {});
        }
      },
    });

    // Helper to update the thinking message OR post fresh
    const reply = async (text) => {
      if (thinkingMsg?.ts) {
        await safeUpdateMessage(channelId, thinkingMsg.ts, text);
      } else {
        await safePostMessage(channelId, { text });
      }
    };

    if (result.action === 'declined') {
      await reply("✅ Noted — I'll let them know gracefully.\n\n— _Argus_ 🎩");

    } else if (result.action === 'approved') {
      await reply(`✅ Sent.\n\nHere's what they received:\n> ${(result.responseText || '').substring(0, 500)}\n\n— _Argus_ 🎩`);

    } else if (result.action === 'instruction') {
      // Argus did real research with tools — show results to Jeff.
      // Approval stays PENDING so Jeff can continue the conversation.
      await reply(markdownToSlack(result.argusReply || "I need a bit more direction on that.\n\n— _Argus_ 🎩"));

    } else if (result.action === 'draft_edit') {
      // Argus drafted/revised a message — show it for approval.
      // Approval stays PENDING with the new draft stored.
      await reply(
        `Here's what I'd send to *${result.relay?.recipient_name || 'them'}*:\n\n` +
        `> ${(result.draftForReview || '').substring(0, 500)}\n\n` +
        `Reply *send* to deliver, or give me more direction.\n\n— _Argus_ 🎩`
      );
    }
  } catch (err) {
    console.error('[events] processApprovalResponse error:', err.message);
    await safePostMessage(channelId, {
      text: '⚠️ Something went wrong processing your response. Please try again.',
    });
  }
}

// ---------------------------------------------------------------------------
// Approval disambiguation (multiple pending approvals, non-threaded reply)
// ---------------------------------------------------------------------------

/**
 * When User A has multiple pending approvals and replies at the top level,
 * show them the options and ask which one they mean.
 *
 * Stores the user's response text temporarily so we can apply it once they
 * pick a number.
 *
 * @param {Array<object>} allPending - All pending approval records for this user
 * @param {string} responseText      - What User A typed
 * @param {string} channelId         - Channel to respond in
 */

/** @type {Map<string, {response: string, approvals: Array}>} */
const pendingDisambiguations = new Map();

async function handleApprovalDisambiguation(allPending, responseText, channelId) {
  // Check if this IS a disambiguation reply (user typed a number)
  const slackUserId = allPending[0]?.sender_atlas_user_id; // for cache key — not ideal but functional
  const cached = pendingDisambiguations.get(channelId);

  if (cached) {
    const num = parseInt(responseText.trim(), 10);
    if (num >= 1 && num <= cached.approvals.length) {
      // User picked a valid option — process the original response
      const chosen = cached.approvals[num - 1];
      pendingDisambiguations.delete(channelId);
      await processApprovalResponse(chosen, cached.response, channelId);
      return;
    }
    // Invalid number or not a number — clear cache, re-show
    pendingDisambiguations.delete(channelId);
  }

  // Fetch context for each approval (recipient name, question)
  const contexts = await relayService.getApprovalContext(allPending);

  // Store the user's original response for after they pick
  pendingDisambiguations.set(channelId, { response: responseText, approvals: allPending });

  // Build the disambiguation message
  const lines = contexts.map((ctx, i) => {
    const timeAgo = _formatTimeAgo(Date.now() - new Date(ctx.createdAt).getTime());
    return `*${i + 1}.* *${ctx.recipientName}* asked: "${ctx.question.substring(0, 100)}" (${timeAgo})`;
  });

  await safePostMessage(channelId, {
    text: `You have ${contexts.length} pending messages waiting for a response. Which one are you replying to?\n\n` +
      lines.join('\n') +
      `\n\nReply with the number (1-${contexts.length}), or reply directly in the thread of the specific message.\n\n— _Argus_ 🎩`,
  });
}

/**
 * Format milliseconds as a human-friendly "X ago" string.
 * @param {number} ms
 * @returns {string}
 */
function _formatTimeAgo(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Relay reply handling (recipient replies to a relayed message thread)
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
 * Forward a reply from the recipient (User B) back to the original sender (User A).
 *
 * @param {object} relay      - Row from `slack_message_relay`
 * @param {string} replyText  - Text the recipient typed
 */
async function handleRelayReply(relay, replyText) {
  try {
    // Send reply to original sender's DM channel (User A)
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

/**
 * Fetch recent DM history (up to 30 messages) for building conversation context.
 * Unlike fetchConversationHistory which gets messages before a specific ts,
 * this gets the most recent messages in a channel — used for non-Atlas user
 * conversations where relay messages need to be included.
 *
 * @param {string} channelId
 * @returns {Promise<Array<{ role: string, content: string }>>}
 */
async function fetchRecentDmHistory(channelId) {
  try {
    const result = await slack.conversations.history({
      channel: channelId,
      limit: 30,
    });

    if (!result.ok || !result.messages) return [];

    return result.messages
      .reverse() // chronological order (Slack returns newest first)
      .map((msg) => ({
        role: msg.bot_id ? 'assistant' : 'user',
        content: msg.text ?? '',
      }))
      .filter(msg => msg.content.length > 0); // skip empty messages
  } catch (err) {
    console.error('[events] fetchRecentDmHistory error:', err.message);
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
 * @param {string} text
 * @returns {string}
 */
// markdownToSlack is imported from ../utils/slack-format

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
    // Auto-convert markdown → Slack mrkdwn at the transport layer
    if (params.text) {
      params = { ...params, text: markdownToSlack(params.text) };
    }
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
    // Auto-convert markdown → Slack mrkdwn at the transport layer
    text = markdownToSlack(text);

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