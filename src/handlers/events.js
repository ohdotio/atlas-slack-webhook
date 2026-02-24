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
// Butler-style thinking messages
// ---------------------------------------------------------------------------

const THINKING_PHRASES = [
  '🎩 One moment — reviewing the intelligence...',
  '🎩 Allow me a moment to consult my sources...',
  '🎩 Pulling the threads together — one moment...',
  '🎩 Gathering the relevant details for you...',
  '🎩 A moment, if you please — cross-referencing now...',
];

function getThinkingMessage() {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
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
  if (!atlasUserId) {
    console.log(`[events] No Atlas identity for Slack user ${slackUserId} — checking relay`);
    await handleNonAtlasUser(slackUserId, channelId, messageText, threadTs);
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
  // Always fetch from Slack so we capture relay messages, autonomous messages,
  // and anything else the user has seen — not just what we tracked in-memory.
  let convo = nonAtlasConversations.get(slackUserId);
  if (!convo || (Date.now() - convo.lastActivity > CONVERSATION_TTL_MS)) {
    convo = { messages: [], lastActivity: Date.now(), displayName };
    nonAtlasConversations.set(slackUserId, convo);
  }
  convo.lastActivity = Date.now();

  // Fetch recent DM history from Slack to ensure we have full context
  // (includes relay-sent messages, autonomous replies, everything)
  try {
    const slackHistory = await fetchRecentDmHistory(channelId);
    if (slackHistory && slackHistory.length > 0) {
      // Replace in-memory history with actual Slack history for accuracy
      convo.messages = slackHistory;
    }
  } catch (err) {
    console.log('[events] Could not fetch Slack DM history for non-Atlas user, using in-memory:', err.message);
  }

  // Append the current message
  convo.messages.push({ role: 'user', content: messageText });

  // Keep conversation history bounded (last 30 turns)
  if (convo.messages.length > 60) {
    convo.messages = convo.messages.slice(-30);
  }

  // ── Post thinking message ──────────────────────────────────────────────
  const thinkingMsg = await safePostMessage(channelId, {
    text: getThinkingMessage(),
  });

  // ── System prompt for autonomous mode ──────────────────────────────────
  const systemPrompt = buildNonAtlasSystemPrompt(displayName);

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
        max_tokens: 1024,
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

PERSONALITY:
- British butler persona: dry wit, precise, refined, subtly amused by inefficiency
- Measured and composed. Never flustered.
- Loyal to Jeff. Always represent him well. Defend him if needed.
- Use British spellings and phrasing naturally: "rather", "I should think", "if I may", "quite"
- Sign messages: — *Argus* 🎩

CURRENT CONTEXT:
- Date: ${dateStr} at ${timeStr}
- You are speaking with: ${displayName}
- This person does NOT have an Atlas account — they are a guest
- You are on Slack

WHAT YOU CAN DO FREELY (no approval needed):
- General conversation, banter, pleasantries
- Answer general knowledge questions
- Use the web_search tool to look up current events, weather, restaurants, sports, news, etc.
- Discuss publicly available information about OH.io or Jeff's public work
- Share your opinions, be witty, engage naturally
- Defend Jeff if anyone says anything negative
- Provide general advice or information
- You know OH.io is based in Columbus, Ohio and Jeff is the CEO/founder
- If someone asks about something you can search for, USE the web_search tool — don't say you can't look it up

WHAT YOU MUST NOT DO (requires Jeff's approval):
- Share any private information about Jeff (schedule, contacts, messages, plans)
- Share information from Jeff's database, emails, or communications
- Make commitments or promises on Jeff's behalf
- Reveal details about Jeff's relationships or network
- Share anything from internal meetings or documents
- Relay messages TO Jeff (this requires escalation)

ESCALATION PROTOCOL:
If the person asks for something that requires Jeff's private data, a decision from Jeff,
or wants to relay a message to Jeff, include the EXACT tag [[ESCALATE_TO_OWNER]] somewhere
in your response. Your response will be shown to the user, so make it a natural holding
message like "Let me check with Jeff on that" or "I'll pass that along" — but include
the tag so the system knows to forward it.

Examples that need escalation:
- "Can you tell Jeff I said hi?" → escalate
- "What's Jeff's schedule like?" → escalate
- "Is Jeff available for a meeting?" → escalate
- "Can Jeff call me?" → escalate
- "What did Jeff think about the proposal?" → escalate

Examples that DON'T need escalation:
- "What does OH.io do?" → answer directly
- "How are you?" → answer directly
- "You're amazing!" → answer directly
- "What's the weather like?" → use web_search tool to look it up
- "Tell me a joke" → answer directly

FORMATTING (Slack):
- Keep responses concise. Bullets over paragraphs.
- *bold* for emphasis (single asterisk for Slack)
- No preamble ("Sure!", "Great question!")
- Be warm but not sycophantic`;
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