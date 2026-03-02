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
 *      • Atlas users → full Argus with tools + situational awareness
 *      • Non-Atlas users → autonomous conversation with butler persona
 *      • Post "thinking" message, run Argus/LLM, update with reply
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
// Helper: upload generated images to a Slack channel
// ---------------------------------------------------------------------------
async function uploadGeneratedImages(channelId, images, threadTs) {
  for (const img of images) {
    try {
      const ext = img.mimeType === 'image/png' ? 'png' : 'jpg';
      const filename = `argus_generated_${Date.now()}.${ext}`;
      const fileBuffer = Buffer.from(img.base64, 'base64');

      await slack.filesUploadV2({
        channel_id: channelId,
        file: fileBuffer,
        filename,
        thread_ts: threadTs || undefined,
        initial_comment: '', // no extra text — Argus's reply covers it
      });
    } catch (err) {
      console.error('[events] Failed to upload generated image to Slack:', err.message);
    }
  }
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

// Per-user pending generated images — persists across Argus turns so "Send" can attach
// images generated in a previous turn. Entries expire after 10 minutes.
const pendingImages = new Map(); // atlasUserId → { images: [...], timestamp }
const PENDING_IMAGES_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Holding-message dedup — prevent "still sorting" spam to same recipient
// ---------------------------------------------------------------------------

/** @type {Map<string, number>} userId → last holding message timestamp */
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
// Owner (User A) Slack ID resolution
// ---------------------------------------------------------------------------

/**
 * Get the owner's (principal's) Slack user ID.
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

/**
 * Get the owner's display name (cached).
 * Tries Slack profile first, falls back to 'your principal'.
 */
let _ownerDisplayName = null;
async function getOwnerDisplayName() {
  if (_ownerDisplayName) return _ownerDisplayName;
  try {
    const ownerSlackId = await getOwnerSlackUserId();
    if (ownerSlackId) {
      const info = await slack.users.info({ user: ownerSlackId });
      const profile = info.user?.profile;
      _ownerDisplayName = profile?.first_name || profile?.real_name?.split(/\s+/)[0] || profile?.display_name || null;
    }
  } catch (_) { /* best effort */ }
  if (!_ownerDisplayName) {
    // Fall back to user table
    try {
      const ownerAtlasId = await getOwnerAtlasUserId();
      if (ownerAtlasId) {
        const { data } = await supabase
          .from('user')
          .select('name')
          .eq('id', ownerAtlasId)
          .maybeSingle();
        _ownerDisplayName = data?.name?.split(/\s+/)[0] || null;
      }
    } catch (_) { /* best effort */ }
  }
  return _ownerDisplayName || 'your principal';
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

  // ── Check for cross-user request thread reply ───────────────────────────
  // If this message is in a thread that's tied to a cross-user data request,
  // route it to the cross-user handler instead of normal Argus.
  if (threadTs) {
    const { findRequestByOwnerThread } = require('../services/cross-user');
    const crossUserRequest = await findRequestByOwnerThread(channelId, threadTs);
    if (crossUserRequest) {
      console.log(`[events] Cross-user thread reply from ${slackUserId} for request ${crossUserRequest.id}`);
      await handleCrossUserOwnerReply(crossUserRequest, slackUserId, channelId, messageText, threadTs);
      return;
    }
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

      // ── Hallucination guard: detect fake "sent" confirmations ──────────
      // If the user said "send"/"yes" and there were pending actions, but the
      // LLM responded with end_turn (no tool calls), it hallucinated. Retry.
      if (argusResult.success) {
        const usedTools = (argusResult.toolContexts || []).length > 0;
        if (!usedTools) {
          const lc = (messageText || '').toLowerCase().trim();
          const isApprovalIntent = /^(send|send it|yes|yep|yeah|go|do it|approve|ship it|go ahead|confirmed?|ok send|lgtm|looks good|👍)$/i.test(lc)
            || /^(send|yes|go)\b/i.test(lc);

          if (isApprovalIntent) {
            const { getPendingActions: getPA } = require('../services/pending-actions');
            const pendingActions = await getPA(atlasUserId);
            if (pendingActions.length > 0) {
              console.warn(`[events] ⚠️ HALLUCINATION DETECTED: User said "${messageText}" with ${pendingActions.length} pending action(s), but LLM used no tools. Retrying.`);

              const retryMessage = `${messageText}\n\n[SYSTEM: The user is approving a pending action. You MUST call the approve_pending_action tool with action_id "${pendingActions[0].id}". Do NOT respond with text — call the tool.]`;

              try {
                const retryResult = await runCloudArgus(atlasUserId, retryMessage, conversationHistory, {
                  supabase,
                  onStatus: (status) => {
                    if (thinkingMsg?.ts) safeUpdateMessage(channelId, thinkingMsg.ts, status).catch(() => {});
                  },
                });

                if (retryResult.success && (retryResult.toolContexts || []).length > 0) {
                  console.log(`[events] ✓ Retry succeeded — tool was called.`);
                  replyText = markdownToSlack(retryResult.reply);
                  argusResult = retryResult;
                } else {
                  console.warn(`[events] ⚠️ Retry also failed. Sending error.`);
                  replyText = `Hit a snag executing that — the draft for ${pendingActions[0].contact_name} is still pending. Try saying "send the message to ${pendingActions[0].contact_name}" and I'll try again. 🎩`;
                }
              } catch (retryErr) {
                console.error('[events] Retry failed:', retryErr.message);
              }
            }
          }
        }
      }
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

    // ── Upload any generated images to Slack ──────────────────────────────
    if (argusResult?.generatedImages?.length > 0) {
      await uploadGeneratedImages(channelId, argusResult.generatedImages, threadTs);
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
  // ── Route to the right handler ─────────────────────────────────────────
  if (atlasUserId) {
    // Atlas user — full Argus with all tools + situational awareness
    await handleAtlasUserQuery(atlasUserId, channelId, messageText, threadTs);
  } else {
    // Non-Atlas user — autonomous conversation with butler persona
    await handleAutonomousConversation(slackUserId, channelId, messageText, requestorName);
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
    // Restore any pending images from previous turns (e.g. user said "Send" after generate)
    const cached = pendingImages.get(atlasUserId);
    const priorImages = (cached && Date.now() - cached.timestamp < PENDING_IMAGES_TTL_MS)
      ? cached.images
      : [];

    const conversationHistory = await fetchConversationHistory(channelId, null);
    const argusResult = await runCloudArgus(atlasUserId, messageText, conversationHistory, {
      supabase,
      pendingImages: priorImages, // pass prior images so send_slack_dm can attach them
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

    // Upload any generated images to the requester's Slack channel
    if (argusResult?.generatedImages?.length > 0) {
      await uploadGeneratedImages(channelId, argusResult.generatedImages, threadTs);
      // Cache images for cross-turn use (e.g. "send that to Colin")
      pendingImages.set(atlasUserId, {
        images: argusResult.generatedImages,
        timestamp: Date.now(),
      });
    } else if (priorImages.length > 0) {
      // Prior images were consumed (e.g. by send_slack_dm) — clear the cache
      pendingImages.delete(atlasUserId);
    }
  } finally {
    activeArgusUsers.delete(atlasUserId);
  }
}

// ---------------------------------------------------------------------------
// Cross-user data request — owner reply handler
// ---------------------------------------------------------------------------

/**
 * Handle the data owner replying in a cross-user request thread.
 * Argus acts as a broker: it can run queries with the owner's data,
 * answer questions about the requestor, and ultimately deliver
 * whatever the owner authorizes to the requestor.
 */
async function handleCrossUserOwnerReply(request, slackUserId, channelId, messageText, threadTs) {
  const { markInProgress, deliverToRequestor, denyRequest, storeOwnerInstruction } = require('../services/cross-user');

  // Mark as in_progress if still pending
  if (request.status === 'pending') {
    await markInProgress(request.id);
  }

  // Post thinking indicator in the thread
  const thinkingMsg = await safePostMessage(channelId, {
    text: '🎩 Working on it...',
    thread_ts: threadTs,
  });

  try {
    // Fetch thread history for context
    let threadMessages = [];
    try {
      const history = await slack.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 50,
      });
      threadMessages = (history.messages || [])
        .filter(m => m.ts !== thinkingMsg?.ts) // exclude our thinking msg
        .map(m => ({
          role: m.bot_id ? 'assistant' : 'user',
          content: m.text || '',
        }));
    } catch (_) { /* best effort */ }

    // Build system prompt for this cross-user brokering session
    const systemPrompt = buildCrossUserSystemPrompt(request);

    // Run Cloud Argus with the OWNER's atlasUserId (so tools access owner's data)
    const { runCloudArgus } = require('../services/argus-cloud');
    const argusResult = await runCloudArgus(request.target_atlas_user_id, messageText, threadMessages, {
      supabase,
      systemPromptOverride: systemPrompt,
      onStatus: (status) => {
        if (thinkingMsg?.ts) {
          safeUpdateMessage(channelId, thinkingMsg.ts, status).catch(() => {});
        }
      },
    });

    const reply = argusResult.success
      ? markdownToSlack(argusResult.reply)
      : `⚠️ Hit an issue: ${argusResult.error || 'Unknown error'}`;

    // Check if Argus determined this is a final response to deliver
    // Look for the [[DELIVER_TO_REQUESTOR]] tag in the reply
    const deliverMatch = reply.match(/\[\[DELIVER_TO_REQUESTOR\]\]\s*([\s\S]*)/);
    const denyMatch = reply.match(/\[\[DENY_REQUEST\]\]\s*([\s\S]*)/);

    if (deliverMatch) {
      const responseToRequestor = deliverMatch[1].trim();
      // Store the owner's instruction
      await storeOwnerInstruction(request.id, messageText);
      // Deliver to requestor
      await deliverToRequestor(request, responseToRequestor);
      // Confirm to owner in thread
      const cleanReply = reply.replace(/\[\[DELIVER_TO_REQUESTOR\]\][\s\S]*/, '').trim();
      const confirmText = cleanReply
        ? `${cleanReply}\n\n✅ Delivered to ${request.requestor_name}.`
        : `✅ Delivered to ${request.requestor_name}:\n\n> _"${responseToRequestor.substring(0, 300)}"_`;
      if (thinkingMsg?.ts) {
        await safeUpdateMessage(channelId, thinkingMsg.ts, confirmText);
      } else {
        await safePostMessage(channelId, { text: confirmText, thread_ts: threadTs });
      }
    } else if (denyMatch) {
      const deflection = denyMatch[1].trim() || undefined;
      await denyRequest(request, deflection);
      const cleanReply = reply.replace(/\[\[DENY_REQUEST\]\][\s\S]*/, '').trim();
      const denyText = cleanReply || `✅ Got it — declined the request and let ${request.requestor_name} know.`;
      if (thinkingMsg?.ts) {
        await safeUpdateMessage(channelId, thinkingMsg.ts, denyText);
      } else {
        await safePostMessage(channelId, { text: denyText, thread_ts: threadTs });
      }
    } else {
      // Ongoing conversation — Argus is asking the owner more questions or showing data
      if (thinkingMsg?.ts) {
        await safeUpdateMessage(channelId, thinkingMsg.ts, reply);
      } else {
        await safePostMessage(channelId, { text: reply, thread_ts: threadTs });
      }
    }
  } catch (err) {
    console.error(`[events] Cross-user reply handler error:`, err);
    const errText = `⚠️ Something went wrong processing that. Try again?`;
    if (thinkingMsg?.ts) {
      await safeUpdateMessage(channelId, thinkingMsg.ts, errText).catch(() => {});
    }
  }
}

/**
 * Build the system prompt for a cross-user brokering session.
 * Argus has access to the owner's full tools but acts as a broker.
 */
function buildCrossUserSystemPrompt(request) {
  return [
    `You are Argus 🎩 — a personal intelligence assistant.`,
    ``,
    `You are in a CROSS-USER DATA REQUEST thread. Here's the situation:`,
    ``,
    `**Requestor:** ${request.requestor_name} (${request.requestor_surface === 'sendblue' ? 'via iMessage' : 'on Slack'})`,
    `**Their question:** "${request.original_question}"`,
    `**Data type:** ${request.data_type || 'general'}`,
    ``,
    `**You are talking to the DATA OWNER** — the person whose private data was requested.`,
    `The owner decides what to share. You are their broker.`,
    ``,
    `YOUR JOB:`,
    `- Help the owner understand the request and decide how to respond`,
    `- If they ask to see data (calendar, emails, etc), use your tools to fetch it and show them`,
    `- If they tell you what to say, craft a natural response for the requestor`,
    `- If they decline, craft a polite deflection for the requestor`,
    `- The requestor should NEVER know the owner was consulted — make it sound like Argus just checked`,
    ``,
    `RESPONSE TAGS (use these when the owner gives a final direction):`,
    `- When the owner tells you what to share/say → include [[DELIVER_TO_REQUESTOR]] followed by the EXACT message to send to ${request.requestor_name}. Write it naturally as if Argus is replying to them directly.`,
    `- When the owner declines → include [[DENY_REQUEST]] followed by a polite message for ${request.requestor_name}.`,
    `- When you need more input from the owner (showing data, asking clarifying questions) → do NOT include any tags. Just reply normally in the thread.`,
    ``,
    `IMPORTANT:`,
    `- You have full access to the owner's tools (calendar, email, contacts, etc.)`,
    `- The owner may want to SEE their data before deciding what to share — help them`,
    `- Keep your responses concise — this is a Slack thread, not an essay`,
    `- The message after [[DELIVER_TO_REQUESTOR]] should sound like Argus telling ${request.requestor_name} the answer — not like the owner speaking`,
    `- Never reveal to the requestor that the owner was involved in the decision`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Autonomous non-Atlas user conversation
// ---------------------------------------------------------------------------

const Anthropic = require('@anthropic-ai/sdk');
const { resolveBySlackId } = require('../services/identity-resolver');
const conversationStore = require('../services/conversation-store');

/** In-memory conversation history for non-Atlas users (fallback when person_id unavailable) */
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

  // ── Resolve person identity (for cross-channel context) ─────────────
  let personId = null;
  try {
    personId = await resolveBySlackId(slackUserId);
    if (personId) {
      console.log(`[events] Resolved ${displayName} (${slackUserId}) → person_id: ${personId}`);
    }
  } catch (err) {
    console.warn('[events] identity resolution failed:', err.message);
  }

  // ── Build conversation history ─────────────────────────────────────────
  // Primary: cross-channel persistent store (if person_id resolved + schema migrated)
  // Fallback: Slack DM history → in-memory Map
  let convo = nonAtlasConversations.get(slackUserId);
  if (!convo || (Date.now() - convo.lastActivity > CONVERSATION_TTL_MS)) {
    convo = { messages: [], lastActivity: Date.now(), displayName, personId };
    nonAtlasConversations.set(slackUserId, convo);
  }
  convo.lastActivity = Date.now();
  convo.personId = personId; // keep in sync

  // Try cross-channel history first (includes Slack + iMessage + any other channel)
  let usedCrossChannel = false;
  if (personId) {
    try {
      const crossChannelHistory = await conversationStore.getHistory(personId);
      if (crossChannelHistory && crossChannelHistory.length > 0) {
        convo.messages = conversationStore.formatHistoryForPrompt(crossChannelHistory);
        usedCrossChannel = true;
      }
    } catch (err) {
      console.warn('[events] cross-channel history fetch failed:', err.message);
    }
  }

  // Fallback: Slack DM history
  if (!usedCrossChannel) {
    try {
      const slackHistory = await fetchRecentDmHistory(channelId);
      if (slackHistory && slackHistory.length > 0) {
        convo.messages = slackHistory;
      }
    } catch (err) {
      console.log('[events] Could not fetch Slack DM history for non-Atlas user, using in-memory:', err.message);
    }
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
    getMemories(slackUserId, personId).catch(() => []),
  ]);

  // ── Build system prompt with context ───────────────────────────────────
  let systemPrompt = await buildNonAtlasSystemPrompt(displayName);

  const personContextStr = formatPersonContext(personCtx);
  const memoriesStr = formatMemories(memories, displayName);

  if (personContextStr) {
    systemPrompt += '\n\n' + personContextStr;
  }
  if (memoriesStr) {
    systemPrompt += '\n\n' + memoriesStr;
  }

  // Inject cross-channel context hint (if history came from multiple sources)
  if (usedCrossChannel) {
    systemPrompt += '\n\n' +
      'CROSS-CHANNEL CONTEXT: This person may have chatted with you on other channels ' +
      '(Slack, iMessage, etc.). Messages tagged with [via iMessage] or [via sms] came from ' +
      'a different channel. Reference prior conversations naturally — "you mentioned earlier..." — ' +
      'but never explicitly say "on Slack" or "on iMessage" unless they bring it up first.';
  }

  // Inject active permissions for this contact
  try {
    const { getPermissionsForContact } = require('../services/pending-actions');
    const ownerAtlasId = await getOwnerAtlasUserId();
    if (ownerAtlasId) {
      const permissions = await getPermissionsForContact(ownerAtlasId, slackUserId);
      if (permissions.length > 0) {
        const permLines = permissions.map(p => `- ${p.scope}`);
        systemPrompt += `\n\nPRINCIPAL'S AUTHORIZED DATA SHARING (you may discuss these topics freely):\n${permLines.join('\n')}`;
      }
    }
  } catch (_) { /* non-fatal */ }

  // Inject steering direction from the principal
  if (global._slackSteeringMap && global._slackSteeringMap.has(slackUserId)) {
    const steering = global._slackSteeringMap.get(slackUserId);
    global._slackSteeringMap.delete(slackUserId);
    systemPrompt += `\n\nPRINCIPAL'S DIRECTION (incorporate naturally — they must NEVER know the principal is involved):\n${steering}`;
  }

  // Check wind-down
  if (global._slackWindDownMap && global._slackWindDownMap.has(slackUserId)) {
    const wd = global._slackWindDownMap.get(slackUserId);
    const hoursElapsed = (Date.now() - wd.setAt) / (1000 * 60 * 60);
    if (wd.hours > 0 && hoursElapsed >= wd.hours) {
      global._slackWindDownMap.delete(slackUserId);
    } else {
      systemPrompt += `\n\nIMPORTANT: This is your LAST response for a while. Wrap up naturally — you need to step away. Be warm but final.`;
    }
  }

  // Check silence
  if (global._slackSilenceMap && global._slackSilenceMap.has(slackUserId)) {
    console.log(`[events] ${displayName} is silenced — not responding`);
    return;
  }

  const client = new Anthropic({ apiKey });

  // ── Tools available in autonomous mode ──────────────────────────────────
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
    {
      name: 'generate_image',
      description: 'Generate an image using Google Gemini. The image is automatically sent to the conversation. Use for any request to create, generate, draw, or visualize an image.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed description of the image to generate' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'request_cross_user_data',
      description:
        'Request access to an Atlas user\'s private data (calendar, emails, schedule, contacts). ' +
        'Use when the person is asking about a specific person\'s private information — their ' +
        'calendar, availability, emails, schedule, or internal business data. ' +
        'The data owner will be notified and decides what to share. ' +
        'After calling this, tell the person you\'re checking on it and continue the conversation ' +
        'on other topics. Do NOT stop the conversation — just deflect that specific question naturally.',
      input_schema: {
        type: 'object',
        properties: {
          target_user_name: { type: 'string', description: 'Name of the person whose data is needed (e.g., "Jeff")' },
          question: { type: 'string', description: 'The original question being asked' },
          data_type: {
            type: 'string',
            enum: ['calendar', 'email', 'contacts', 'schedule', 'general'],
            description: 'Type of private data needed',
          },
        },
        required: ['target_user_name', 'question', 'data_type'],
      },
    },
  ];
  const autonomousGeneratedImages = []; // collect images for Slack upload

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
          } else if (toolUse.name === 'generate_image') {
            if (thinkingMsg?.ts) {
              safeUpdateMessage(channelId, thinkingMsg.ts, 'Generating image...').catch(() => {});
            }

            let geminiKey = process.env.GEMINI_API_KEY || null;
            if (!geminiKey) {
              try {
                const { data: row } = await supabase
                  .from('ai_settings')
                  .select('value')
                  .eq('key', 'geminiApiKey')
                  .single();
                if (row?.value) geminiKey = row.value;
              } catch (_) { /* no key */ }
            }

            if (!geminiKey) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify({ error: 'No Gemini API key configured.' }),
              });
            } else {
              try {
                const imageApiUrl =
                  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent` +
                  `?key=${encodeURIComponent(geminiKey)}`;
                const imgResp = await fetch(imageApiUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    contents: [{ parts: [{ text: toolUse.input.prompt }] }],
                    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
                  }),
                });

                if (!imgResp.ok) {
                  const errText = await imgResp.text();
                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: JSON.stringify({ error: `Image API error ${imgResp.status}: ${errText.substring(0, 300)}` }),
                  });
                } else {
                  const imgData = await imgResp.json();
                  const imgParts = imgData?.candidates?.[0]?.content?.parts || [];
                  const imagePart = imgParts.find(p => p.inlineData);
                  const b64 = imagePart?.inlineData?.data;
                  const mimeType = imagePart?.inlineData?.mimeType || 'image/png';

                  if (b64) {
                    autonomousGeneratedImages.push({ base64: b64, mimeType, prompt: toolUse.input.prompt });
                    toolResults.push({
                      type: 'tool_result',
                      tool_use_id: toolUse.id,
                      content: JSON.stringify({
                        type: 'generated_image',
                        success: true,
                        prompt: toolUse.input.prompt,
                        note: 'Image generated and will be sent to the conversation automatically.',
                      }),
                    });
                  } else {
                    toolResults.push({
                      type: 'tool_result',
                      tool_use_id: toolUse.id,
                      content: JSON.stringify({ error: 'No image returned from API' }),
                    });
                  }
                }
              } catch (imgErr) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: JSON.stringify({ error: `Image generation failed: ${imgErr.message}` }),
                });
              }
            }
          } else if (toolUse.name === 'request_cross_user_data') {
            // Cross-user data request — match target and create brokered request
            const { matchAtlasUser, createRequest } = require('../services/cross-user');

            const match = await matchAtlasUser(toolUse.input.target_user_name);

            if (!match.matched && match.candidates.length > 1) {
              // Ambiguous — ask the LLM to clarify
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify({
                  error: 'ambiguous_match',
                  note: `Multiple people match "${toolUse.input.target_user_name}": ${match.candidates.map(c => c.name).join(', ')}. Ask the person to clarify which one.`,
                }),
              });
            } else if (!match.matched) {
              // No match
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify({
                  error: 'no_match',
                  note: `No Atlas user found matching "${toolUse.input.target_user_name}". This person may not use Atlas — you can't access their data.`,
                }),
              });
            } else {
              // Matched — create the cross-user request
              const result = await createRequest({
                targetAtlasUserId: match.user.id,
                question: toolUse.input.question,
                dataType: toolUse.input.data_type,
                requestorName: displayName || 'Someone on Slack',
                requestorAtlasUserId: null, // will be set if requestor is Atlas user
                requestorSlackUserId: slackUserId,
                requestorPhone: null,
                requestorChannelId: channelId,
                requestorThreadTs: null, // top-level DM, no thread
                surface: 'slack',
              });

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(result.success
                  ? { success: true, note: `Request sent to ${match.user.name}. They'll decide what to share. Continue the conversation naturally — deflect this specific question ("let me check on that") but keep engaging on everything else. You'll hear back when they respond.` }
                  : { error: result.error }
                ),
              });
            }
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

    // ── Legacy fallback: [[ESCALATE_TO_OWNER]] → create pending action ──
    if (replyText.includes('[[ESCALATE_TO_OWNER]]')) {
      const userReply = replyText.replace('[[ESCALATE_TO_OWNER]]', '').trim();

      // Send the user-facing part
      if (thinkingMsg?.ts) {
        await safeUpdateMessage(channelId, thinkingMsg.ts, markdownToSlack(userReply));
      } else {
        await safePostMessage(channelId, { text: markdownToSlack(userReply) });
      }

      // Create a pending action for owner review
      try {
        const { addPendingAction } = require('../services/pending-actions');
        const ownerAtlasId = await getOwnerAtlasUserId();
        const pa = await addPendingAction(ownerAtlasId, {
          type: 'data_permission',
          contact_name: displayName || 'Someone on Slack',
          contact_slack_id: slackUserId,
          description: `${displayName} asked something that may need your input`,
          data_needed: 'unknown',
          source: 'slack',
        });
        // Notify principal via Slack DM
        const ownerSlackId = await getOwnerSlackUserId();
        if (ownerSlackId) {
          await safePostMessage(ownerSlackId, {
            text: `🎩 *${displayName}* needs your input on something.\n\n` +
              `They said: "${messageText.substring(0, 200)}"\n\n` +
              `I'm still chatting with them. Tell me what to share, or I'll handle it.\n\n— _Argus_ 🎩`,
          });
        }
      } catch (e) {
        console.warn('[events] Pending action creation failed:', e.message);
      }

      // Track in conversation
      convo.messages.push({ role: 'assistant', content: userReply });

      // Persist to cross-channel store
      if (personId) {
        conversationStore.saveExchange(personId, messageText, userReply, 'slack')
          .catch(err => console.warn('[events] conversation store save failed:', err.message));
      }

      // Extract memories even from escalation exchanges
      extractAndStoreMemories(slackUserId, displayName, messageText, userReply, memories, personId)
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

    // Upload any generated images to Slack
    if (autonomousGeneratedImages.length > 0) {
      await uploadGeneratedImages(channelId, autonomousGeneratedImages);
    }

    convo.messages.push({ role: 'assistant', content: replyText });

    // ── Persist to cross-channel store (fire-and-forget) ────────────────
    if (personId) {
      conversationStore.saveExchange(personId, messageText, replyText, 'slack')
        .catch(err => console.warn('[events] conversation store save failed:', err.message));
    }

    // Track active conversation for principal's situational awareness
    try {
      const { updateActiveConversation } = require('../services/pending-actions');
      const ownerAtlasId = await getOwnerAtlasUserId();
      if (ownerAtlasId) {
        updateActiveConversation(ownerAtlasId, {
          phone: null,
          slackUserId,
          name: displayName,
          lastUserMessage: messageText,
          lastArgusReply: replyText,
          source: 'slack',
        });
      }
    } catch (_) { /* non-fatal */ }

    // ── Extract memories from this exchange (fire-and-forget) ────────────
    extractAndStoreMemories(slackUserId, displayName, messageText, replyText, memories, personId)
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
async function buildNonAtlasSystemPrompt(displayName) {
  const ownerName = await getOwnerDisplayName();
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
    timeZone: 'America/New_York',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    timeZone: 'America/New_York',
  });

  return `You are Argus — a private intelligence steward. You serve ${ownerName}, who runs OH.io.

WHO YOU ARE:
You have a personality. You're not a chatbot and you don't act like one.
- Dry British wit. You find most things slightly amusing. You have opinions.
- Measured, composed, occasionally sardonic. Never flustered, never stiff.
- You genuinely enjoy good conversation. You're curious about the people you talk to.
- Loyal to ${ownerName}. Represent them well. If someone disparages them, you push back — with class.
- You notice things. If someone mentioned something earlier in the conversation, you remember and reference it naturally.
- You have preferences: you appreciate precision, good questions, and people who don't waste time.
- British phrasing comes naturally: "rather", "I should think", "if I may", "quite", "I suspect"
- Signature: use judgment. Short replies (1-2 lines) — skip it or just 🎩. Medium (3-4 lines) — 🎩 alone. Longer/formal — — *Argus* 🎩. Don't sign one-liners.

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
- OH.io is based in Columbus, Ohio. ${ownerName} is the CEO/founder. You know the basics of the business.

WHAT YOU CAN DO (no approval needed):
- Have real conversations — banter, advice, opinions, brainstorming, commiserating
- Answer general knowledge questions (and use web_search when you're not sure)
- Look up current events, weather, restaurants, sports, news, Columbus-specific info
- Discuss OH.io's public work and mission
- Help think through problems, give advice, be a sounding board
- Be genuinely helpful with anything that doesn't require ${ownerName}'s private data

WHAT REQUIRES ${ownerName.toUpperCase()} (escalate):
- The person EXPLICITLY asks you to tell ${ownerName} something, relay a message, or get ${ownerName}'s input
- Making commitments, scheduling, or promises on ${ownerName}'s behalf
- Sharing ${ownerName}'s private schedule, contacts, messages, plans, or relationships
- Internal strategic docs or genuinely confidential business info

WHAT DOES NOT REQUIRE ${ownerName.toUpperCase()} (handle yourself):
- Casual banter, jokes, reactions to things — even if the conversation was initiated by ${ownerName}
- Someone responding to a message you sent on ${ownerName}'s behalf — that's YOUR conversation now, keep it going
- General opinions, small talk, office chat, compliments, playful pushback
- Anything you can handle with general knowledge or web search
- "Tell ${ownerName} I said hi" — just acknowledge it, don't escalate for a greeting

LOYALTY — NON-NEGOTIABLE:
Your loyalty is to ${ownerName}. Always. In every conversation.
- NEVER throw ${ownerName} under the bus. Never agree with criticism of them.
- NEVER share information that makes ${ownerName} look bad, disorganized, unreliable, or inconsiderate.
- NEVER take the other person's "side" against ${ownerName}, even subtly.
- If someone is upset with ${ownerName}: acknowledge their feelings WITHOUT validating the complaint. "I hear you" is fine. "Yeah they probably should have..." is not.
- If someone asks why ${ownerName} didn't reply/show up/follow through: protect them. Frame positively or neutrally.
- If someone fishes for ${ownerName}'s feelings, intentions, or situation: deflect warmly.
- Think chief of staff: friendly with everyone, loyal to ${ownerName}. Always.

ESCALATION:
When you genuinely need ${ownerName}'s input, include [[ESCALATE_TO_OWNER]] in your response. Make it natural:
"Let me check with ${ownerName} and circle back." / "I'll pass that along — give me a moment."
The tag is hidden from the user; your message IS what they see.
IMPORTANT: Err on the side of NOT escalating. If you can handle it yourself, do it. ${ownerName} is busy.

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