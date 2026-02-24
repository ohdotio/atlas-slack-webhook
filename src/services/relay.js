'use strict';

/**
 * relay.js — Slack Message Relay Service
 *
 * Manages the full lifecycle of a relay session:
 *   1. Creating relay records when the bot sends a DM on User A's behalf
 *   2. Finding active relays for incoming messages (threaded or recent)
 *   3. Evaluating whether Argus can answer User B directly or needs approval
 *   4. Managing the approval loop (request → process → send / decline)
 *   5. Expiring stale records
 *
 * Design notes:
 *   - All DB access via the shared Supabase singleton.
 *   - Slack WebClient is passed in (never instantiated here).
 *   - Anthropic API key comes from the caller; we use claude-haiku-3 for speed.
 *   - Argus-facing voice: British butler — measured, precise, slightly formal.
 *   - User A-facing voice: clean, short, actionable.
 */

const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../utils/supabase');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long (ms) a non-threaded message is still considered "recent" for relay matching. */
const RECENT_RELAY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Threshold (ms) after which User A's reply is considered "late" and needs confirmation. */
const LATE_RESPONSE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** Claude model for the lightweight evaluator call. */
const EVALUATOR_MODEL = 'claude-haiku-4-5';

// ---------------------------------------------------------------------------
// createRelay
// ---------------------------------------------------------------------------

/**
 * Create a relay record after the bot sends a DM to User B on User A's behalf.
 *
 * @param {object} params
 * @param {string} params.senderAtlasUserId    - User A's Atlas user id
 * @param {string} [params.senderSlackUserId]  - User A's Slack user id
 * @param {string} params.recipientSlackUserId - User B's Slack user id
 * @param {string} [params.recipientName]      - User B's display name
 * @param {string} params.recipientDmChannelId - DM channel id with User B
 * @param {string} params.messageTs            - ts of the bot's message to User B
 * @param {string} [params.originalMessage]    - The message text that was sent
 * @param {string} [params.relayContext]       - Relay context (topic, intent, etc.)
 * @returns {Promise<object>} The created relay row.
 */
async function createRelay({
  senderAtlasUserId,
  senderSlackUserId,
  recipientSlackUserId,
  recipientName,
  recipientDmChannelId,
  messageTs,
  originalMessage,
  relayContext,
}) {
  const { data, error } = await supabase
    .from('slack_message_relay')
    .insert({
      sender_atlas_user_id: senderAtlasUserId,
      sender_slack_user_id: senderSlackUserId ?? null,
      recipient_slack_user_id: recipientSlackUserId,
      recipient_name: recipientName ?? null,
      recipient_dm_channel_id: recipientDmChannelId,
      slack_message_ts: messageTs,
      original_message: originalMessage ?? null,
      context: relayContext ?? null,   // primary context field
      status: 'sent',
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error('[relay] createRelay error:', error.message);
    throw new Error(`Failed to create relay record: ${error.message}`);
  }

  console.log(`[relay] Created relay ${data.id} for recipient ${recipientSlackUserId}`);
  return data;
}

// ---------------------------------------------------------------------------
// findActiveRelay
// ---------------------------------------------------------------------------

/**
 * Find an active relay for an incoming message from User B.
 *
 * Checks in priority order:
 *   1. Threaded reply: relay where `slack_message_ts` matches `threadTs`
 *      and `recipient_slack_user_id` matches the user — any non-expired status.
 *   2. Recent non-threaded: most recent relay for this recipient created
 *      within the last 24 hours that is still open (sent | active | pending_approval).
 *
 * @param {string} recipientSlackUserId - The Slack user id of the replying user
 * @param {string|null} threadTs        - Thread parent ts from the event, or null
 * @returns {Promise<object|null>} The relay row, or null if none found.
 */
async function findActiveRelay(recipientSlackUserId, threadTs) {
  // ── 1. Threaded reply ──────────────────────────────────────────────────────
  if (threadTs) {
    const { data: threaded, error: threadErr } = await supabase
      .from('slack_message_relay')
      .select('*')
      .eq('recipient_slack_user_id', recipientSlackUserId)
      .eq('slack_message_ts', threadTs)
      .not('status', 'in', '("expired","closed","replied")')
      .maybeSingle();

    if (threadErr) {
      console.error('[relay] findActiveRelay (threaded) error:', threadErr.message);
    }

    if (threaded) {
      console.log(`[relay] Found threaded relay ${threaded.id} for ts=${threadTs}`);
      return threaded;
    }
  }

  // ── 2. Recent non-threaded ─────────────────────────────────────────────────
  const windowStart = new Date(Date.now() - RECENT_RELAY_WINDOW_MS).toISOString();

  const { data: recent, error: recentErr } = await supabase
    .from('slack_message_relay')
    .select('*')
    .eq('recipient_slack_user_id', recipientSlackUserId)
    .in('status', ['sent', 'active', 'pending_approval'])
    .gte('created_at', windowStart)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recentErr) {
    console.error('[relay] findActiveRelay (recent) error:', recentErr.message);
    return null;
  }

  if (recent) {
    console.log(`[relay] Found recent relay ${recent.id} for recipient ${recipientSlackUserId}`);
  }

  return recent ?? null;
}

// ---------------------------------------------------------------------------
// evaluateReply
// ---------------------------------------------------------------------------

/**
 * Evaluate User B's reply to determine how Argus should respond.
 *
 * Uses a lightweight Claude Haiku call. Returns one of:
 *   - `answer_directly` — Argus can respond from relay context alone.
 *   - `needs_approval`  — Requires User A's knowledge or a decision.
 *   - `acknowledge`     — Simple ack (thanks / got it) — summarise for User A.
 *
 * @param {object} relay          - The relay row from `slack_message_relay`
 * @param {string} userMessage    - User B's reply text
 * @param {string} anthropicApiKey
 * @returns {Promise<{
 *   action: 'answer_directly' | 'needs_approval' | 'acknowledge',
 *   response?: string,
 *   summary?: string,
 * }>}
 */
async function evaluateReply(relay, userMessage, anthropicApiKey) {
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const systemPrompt = `You are a relay evaluator for Argus, a personal intelligence assistant. \
Your job is to classify an incoming message from a contact (User B) who received a message \
sent on behalf of someone (User A) via Argus.

You will receive:
- original_message: what User A sent to User B
- relay_context: optional context about the relay (topic, intent)
- user_message: what User B has just replied

Classify the reply into exactly one of these actions:

"answer_directly" — Argus can respond factually from the context alone, \
  without needing User A's input. Example: User B asks "what time?" and the \
  original message mentioned 8:30 AM.

"needs_approval" — User B is asking something that requires User A's private \
  information, a decision, or a commitment. Examples: "Can we push to 9?", \
  "Where should we meet?", "Is Tuesday OK instead?"

"acknowledge" — User B is simply acknowledging receipt: "thanks", "got it", \
  "sounds good", "will do", "ok", "👍", etc. No response needed; just summarise \
  for User A.

Respond with a JSON object only — no prose, no markdown fencing. Schema:

{
  "action": "answer_directly" | "needs_approval" | "acknowledge",
  "response": "<response to send User B — only if action is answer_directly>",
  "suggested_response": "<draft reply for User A to approve — only if action is needs_approval>",
  "summary": "<1-sentence summary for User A — always include>"
}`;

  const userContent = JSON.stringify({
    original_message: relay.original_message ?? '',
    relay_context: relay.context ?? '',
    user_message: userMessage,
  });

  let raw;
  try {
    const response = await client.messages.create({
      model: EVALUATOR_MODEL,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });
    raw = response.content?.[0]?.text ?? '';
  } catch (err) {
    console.error('[relay] evaluateReply Anthropic error:', err.message);
    // Fail safe: escalate to needs_approval
    return {
      action: 'needs_approval',
      summary: `User B replied: "${userMessage}"`,
    };
  }

  let parsed;
  try {
    // Strip optional markdown fences if the model wraps it anyway
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (_) {
    console.warn('[relay] evaluateReply could not parse JSON response:', raw);
    return {
      action: 'needs_approval',
      summary: `User B replied: "${userMessage}"`,
    };
  }

  const action = parsed.action;
  if (!['answer_directly', 'needs_approval', 'acknowledge'].includes(action)) {
    console.warn('[relay] evaluateReply unknown action:', action);
    return {
      action: 'needs_approval',
      summary: parsed.summary ?? `User B replied: "${userMessage}"`,
    };
  }

  return {
    action,
    response: parsed.response ?? undefined,
    suggested_response: parsed.suggested_response ?? undefined,
    summary: parsed.summary ?? `User B replied: "${userMessage}"`,
  };
}

// ---------------------------------------------------------------------------
// requestApproval
// ---------------------------------------------------------------------------

/**
 * Request approval from User A by DMing them and creating a queue entry.
 *
 * @param {object} relay              - Row from `slack_message_relay`
 * @param {string} recipientQuestion  - What User B asked
 * @param {string|null} suggestedResponse - Argus's draft response (may be null)
 * @param {import('@slack/web-api').WebClient} slackClient
 * @returns {Promise<object>} The created approval queue row.
 */
async function requestApproval(relay, recipientQuestion, suggestedResponse, slackClient) {
  // Determine User A's DM channel for approval messages
  const approvalChannelId = await _ensureDmChannel(relay.sender_slack_user_id, slackClient);
  if (!approvalChannelId) {
    throw new Error(`[relay] Cannot find DM channel for User A (${relay.sender_slack_user_id})`);
  }

  const recipientName = relay.recipient_name ?? 'Your contact';
  const hasSuggested = suggestedResponse && suggestedResponse.trim().length > 0;

  const messageText =
    `📨 *${recipientName}* has a question about your earlier message:\n\n` +
    `> "${recipientQuestion}"\n\n` +
    (hasSuggested
      ? `I'd suggest responding with:\n> "${suggestedResponse}"\n\n`
      : '') +
    `Reply with:\n` +
    `• ✅ *approve*${hasSuggested ? ' — send as-is' : ' — use your own words below'}\n` +
    `• Or type your own response to send instead\n` +
    `• ❌ *decline* — I'll let them know gracefully`;

  // Post the approval message to User A
  let approvalMessageTs;
  try {
    const result = await slackClient.chat.postMessage({
      channel: approvalChannelId,
      text: messageText,
    });
    approvalMessageTs = result.ts ?? null;
  } catch (err) {
    console.error('[relay] requestApproval postMessage error:', err.message);
    throw err;
  }

  // Write to relay_approval_queue
  const { data, error } = await supabase
    .from('relay_approval_queue')
    .insert({
      relay_id: relay.id,
      sender_atlas_user_id: relay.sender_atlas_user_id,
      recipient_question: recipientQuestion,
      suggested_response: suggestedResponse ?? null,
      approval_channel_id: approvalChannelId,
      approval_message_ts: approvalMessageTs ?? null,
      status: 'pending',
    })
    .select()
    .single();

  if (error) {
    console.error('[relay] requestApproval DB insert error:', error.message);
    throw new Error(`Failed to create approval queue entry: ${error.message}`);
  }

  // Update relay status to pending_approval
  await supabase
    .from('slack_message_relay')
    .update({ status: 'pending_approval', updated_at: new Date().toISOString() })
    .eq('id', relay.id);

  console.log(`[relay] Approval requested: queue=${data.id}, relay=${relay.id}`);
  return data;
}

// ---------------------------------------------------------------------------
// processApproval
// ---------------------------------------------------------------------------

/**
 * Process User A's response to an approval request.
 *
 * Recognises:
 *   - "approve" / "yes" / "✅" → send suggested_response as-is
 *   - "decline" / "no" / "❌" → decline gracefully to User B
 *   - Anything else             → treat as a custom response to send
 *
 * @param {string} approvalId     - UUID of the relay_approval_queue row
 * @param {string} userResponse   - Raw text User A replied with
 * @param {import('@slack/web-api').WebClient} slackClient
 * @returns {Promise<{ sent: boolean, action: 'approved'|'modified'|'declined', responseText?: string }>}
 */
async function processApproval(approvalId, userResponse, slackClient) {
  // Fetch the approval queue entry + joined relay
  const { data: approval, error: approvalErr } = await supabase
    .from('relay_approval_queue')
    .select('*, relay:relay_id(*)')
    .eq('id', approvalId)
    .single();

  if (approvalErr || !approval) {
    throw new Error(`[relay] processApproval: cannot find approval ${approvalId}: ${approvalErr?.message}`);
  }

  if (approval.status !== 'pending') {
    console.warn(`[relay] processApproval: approval ${approvalId} is already ${approval.status}`);
    return { sent: false, action: approval.status };
  }

  const relay = approval.relay;
  const trimmed = userResponse.trim().toLowerCase();

  // ── Classify User A's response ─────────────────────────────────────────
  // Broad approve: anything that signals "yes, go ahead, do it"
  const isApprove = /^(approve[d]?|yes|yep|yeah|yea|ya|sure|ok|okay|go ahead|send it|send|do it|✅|👍|go for it|approved|affirmative|absolutely|definitely|please|share|share it)$/i.test(trimmed);
  // Broad decline: anything that signals "no, don't, stop"
  const isDecline = /^(decline[d]?|no|nah|nope|❌|👎|don't send|don't|pass|skip|cancel|ignore|nevermind|never mind|forget it|drop it)$/i.test(trimmed);

  let action;
  let responseText;

  if (isDecline) {
    action = 'declined';
    responseText = null;
  } else if (isApprove) {
    action = 'approved';
    responseText = approval.suggested_response ?? null;

    // If we have no suggested response, we can't just send "yes" to the user.
    // Generate one from the context.
    if (!responseText) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        responseText = await _generateResponseFromContext(approval, relay, apiKey);
      }
      if (!responseText) {
        responseText = "Noted — I'll follow up on that shortly.\n\n— _Argus_ 🎩";
      }
    }
  } else {
    // ── NOT a simple approve/decline — this is an instruction from User A.
    // User A said something like "share info", "tell her the meeting is at 3",
    // "let him know I'm running late", etc.
    //
    // We MUST NOT send these words verbatim to User B. Instead, use an LLM
    // to draft a proper Argus-style response based on User A's instructions.
    action = 'modified';

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      responseText = await _draftFromInstructions(userResponse, approval, relay, apiKey);
    } else {
      // Fallback: can't draft without API key
      responseText = userResponse;
    }
  }

  // Persist the decision
  const now = new Date().toISOString();
  await supabase
    .from('relay_approval_queue')
    .update({
      status: action,
      approved_response: responseText ?? null,
      responded_at: now,
    })
    .eq('id', approvalId);

  if (action === 'declined') {
    // Notify User B gracefully
    await _sendToRecipient(
      relay,
      `I'm afraid the details on that aren't available to me at present. ` +
      `Should anything change, I'll be sure to let you know promptly.\n\n— _Argus_ 🎩`,
      slackClient
    );

    await supabase
      .from('slack_message_relay')
      .update({ status: 'replied', reply_text: '[declined]', updated_at: now })
      .eq('id', relay.id);

    return { sent: true, action: 'declined' };
  }

  // Send the drafted/approved response to User B
  await _sendToRecipient(relay, responseText, slackClient);

  await supabase
    .from('slack_message_relay')
    .update({ status: 'replied', reply_text: responseText, replied_at: now, updated_at: now })
    .eq('id', relay.id);

  console.log(`[relay] Approval processed: ${action} for relay ${relay.id}`);
  return { sent: true, action, responseText };
}

// ---------------------------------------------------------------------------
// findPendingApproval
// ---------------------------------------------------------------------------

/**
 * Find a pending approval queue entry for User A.
 *
 * Matches on:
 *   1. Threaded: approval_message_ts matches threadTs (User A replying in a thread)
 *   2. Most recent pending: most recent pending approval for this User A (by Slack user id)
 *      where approval.sender_atlas_user_id resolves to slackUserId.
 *
 * @param {string} slackUserId  - User A's Slack user id
 * @param {string|null} threadTs
 * @returns {Promise<object|null>}
 */
async function findPendingApproval(slackUserId, threadTs) {
  // ── 1. Threaded reply ──────────────────────────────────────────────────────
  if (threadTs) {
    const { data: threaded, error: threadErr } = await supabase
      .from('relay_approval_queue')
      .select('*')
      .eq('approval_message_ts', threadTs)
      .eq('status', 'pending')
      .maybeSingle();

    if (threadErr) {
      console.error('[relay] findPendingApproval (threaded) error:', threadErr.message);
    }

    if (threaded) {
      console.log(`[relay] Found threaded pending approval ${threaded.id}`);
      return threaded;
    }
  }

  // ── 2. Most recent pending via approval_channel lookup ────────────────────
  // Lookup via approval_channel_id — first resolve slackUserId → DM channel
  // We match on the approval_channel_id being the DM channel between bot and User A.
  // Since we stored approval_channel_id when creating the request, we look up
  // all pending approvals for channels that the user owns.

  const { data: rows, error: rowsErr } = await supabase
    .from('relay_approval_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(10);

  if (rowsErr) {
    console.error('[relay] findPendingApproval (recent) error:', rowsErr.message);
    return null;
  }

  if (!rows || rows.length === 0) return null;

  // Filter by matching sender Slack user id via user_slack_identities
  // We stored sender_atlas_user_id in the queue, so join through that.
  const { data: identity, error: identErr } = await supabase
    .from('user_slack_identities')
    .select('atlas_user_id')
    .eq('slack_user_id', slackUserId)
    .limit(1)
    .maybeSingle();

  if (identErr) {
    console.error('[relay] findPendingApproval identity lookup error:', identErr.message);
  }

  if (!identity?.atlas_user_id) {
    console.warn('[relay] findPendingApproval: no Atlas identity for Slack user', slackUserId);
    return null;
  }

  const matches = rows.filter((r) => r.sender_atlas_user_id === identity.atlas_user_id);

  if (matches.length === 0) return null;

  if (matches.length === 1) {
    console.log(`[relay] Found pending approval ${matches[0].id} for atlas user ${identity.atlas_user_id}`);
    return matches[0];
  }

  // Multiple pending approvals — return the most recent one but flag it
  console.log(`[relay] Found ${matches.length} pending approvals for atlas user ${identity.atlas_user_id} — returning most recent`);
  matches[0]._multipleCount = matches.length;
  matches[0]._allPending = matches;
  return matches[0];
}

// ---------------------------------------------------------------------------
// getApprovalContext — fetch relay details for approval disambiguation
// ---------------------------------------------------------------------------

/**
 * Fetch relay context (recipient name, question) for a list of approval records.
 * Used when User A has multiple pending approvals and needs to pick one.
 *
 * @param {Array<object>} approvals - Approval queue rows
 * @returns {Promise<Array<{id: string, recipientName: string, question: string, createdAt: string}>>}
 */
async function getApprovalContext(approvals) {
  const results = [];
  for (const a of approvals) {
    let recipientName = 'Unknown';

    if (a.relay_id) {
      const { data: relay } = await supabase
        .from('slack_message_relay')
        .select('recipient_name')
        .eq('id', a.relay_id)
        .maybeSingle();

      if (relay?.recipient_name) recipientName = relay.recipient_name;
    }

    results.push({
      id: a.id,
      recipientName,
      question: a.recipient_question ?? '(no question recorded)',
      createdAt: a.created_at,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// checkPendingForRecipient
// ---------------------------------------------------------------------------

/**
 * Check whether User B has a message relay currently stuck in `pending_approval`.
 * Used to show User B a holding message rather than leaving them in silence.
 *
 * @param {string} recipientSlackUserId
 * @returns {Promise<object|null>} The relay row, or null.
 */
async function checkPendingForRecipient(recipientSlackUserId) {
  const { data, error } = await supabase
    .from('slack_message_relay')
    .select('*')
    .eq('recipient_slack_user_id', recipientSlackUserId)
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[relay] checkPendingForRecipient error:', error.message);
    return null;
  }

  return data ?? null;
}

// ---------------------------------------------------------------------------
// isLateResponse
// ---------------------------------------------------------------------------

/**
 * Determine whether User A is responding "late" (>1hr after the approval was requested).
 * If so, the caller should send User A a confirmation message before proceeding.
 *
 * @param {string} approvalId - UUID of the relay_approval_queue row
 * @returns {Promise<{ isLate: boolean, approval?: object, confirmationText?: string }>}
 */
async function isLateResponse(approvalId) {
  const { data: approval, error } = await supabase
    .from('relay_approval_queue')
    .select('*, relay:relay_id(recipient_name)')
    .eq('id', approvalId)
    .single();

  if (error || !approval) {
    console.error('[relay] isLateResponse lookup error:', error?.message);
    return { isLate: false };
  }

  const createdAt = new Date(approval.created_at).getTime();
  const elapsed = Date.now() - createdAt;

  if (elapsed < LATE_RESPONSE_THRESHOLD_MS) {
    return { isLate: false, approval };
  }

  // Build a human-friendly "time ago" string
  const agoText = _formatTimeAgo(elapsed);

  const recipientName = approval.relay?.recipient_name ?? 'your contact';
  const confirmationText =
    `Just confirming — you're responding to *${recipientName}*'s question from ${agoText}:\n` +
    `"${approval.recipient_question}"\n\n` +
    `Still want to proceed? Reply *yes* to send your response, or *cancel* to discard.`;

  return { isLate: true, approval, confirmationText };
}

// ---------------------------------------------------------------------------
// expireStale
// ---------------------------------------------------------------------------

/**
 * Mark overdue relays and approval queue entries as expired.
 * Should be called periodically (e.g., every hour via a cron-style interval).
 *
 * @returns {Promise<{ expiredRelays: number, expiredApprovals: number }>}
 */
async function expireStale() {
  const now = new Date().toISOString();

  // Expire relays past their expires_at
  const { count: expiredRelays, error: relayErr } = await supabase
    .from('slack_message_relay')
    .update({ status: 'expired', updated_at: now })
    .in('status', ['sent', 'active', 'pending_approval'])
    .lt('expires_at', now)
    .select('id', { count: 'exact', head: true });

  if (relayErr) {
    console.error('[relay] expireStale relays error:', relayErr.message);
  }

  // Expire approval queue entries older than 7 days
  const approvalCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { count: expiredApprovals, error: approvalErr } = await supabase
    .from('relay_approval_queue')
    .update({ status: 'expired', responded_at: now })
    .eq('status', 'pending')
    .lt('created_at', approvalCutoff)
    .select('id', { count: 'exact', head: true });

  if (approvalErr) {
    console.error('[relay] expireStale approvals error:', approvalErr.message);
  }

  const counts = {
    expiredRelays: expiredRelays ?? 0,
    expiredApprovals: expiredApprovals ?? 0,
  };

  if (counts.expiredRelays > 0 || counts.expiredApprovals > 0) {
    console.log(`[relay] expireStale: ${counts.expiredRelays} relays, ${counts.expiredApprovals} approvals expired`);
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a DM channel exists between the bot and the given Slack user.
 * Caches the result in-memory to avoid repeated conversations.open calls.
 *
 * @param {string} slackUserId
 * @param {import('@slack/web-api').WebClient} slackClient
 * @returns {Promise<string|null>} Channel id, or null on failure.
 */
const _dmChannelCache = new Map();

async function _ensureDmChannel(slackUserId, slackClient) {
  if (!slackUserId) return null;

  if (_dmChannelCache.has(slackUserId)) {
    return _dmChannelCache.get(slackUserId);
  }

  try {
    const result = await slackClient.conversations.open({ users: slackUserId });
    const channelId = result.channel?.id ?? null;
    if (channelId) {
      _dmChannelCache.set(slackUserId, channelId);
    }
    return channelId;
  } catch (err) {
    console.error('[relay] _ensureDmChannel error:', err.message);
    return null;
  }
}

/**
 * Send a message to User B in their DM channel.
 * Threads under the original bot message when available.
 * For escalated conversations (autonomous mode), sends as a new message
 * since there's no specific bot message to thread under.
 *
 * @param {object} relay
 * @param {string} text
 * @param {import('@slack/web-api').WebClient} slackClient
 */
async function _sendToRecipient(relay, text, slackClient) {
  try {
    const msgParams = {
      channel: relay.recipient_dm_channel_id,
      text,
    };

    // Only thread if this relay has a valid bot message in the recipient's DM
    // Escalated relays store the forward-to-owner ts, which is in Jeff's DM, not User B's
    const isEscalated = relay.original_message?.startsWith('[escalated]') ||
                        relay.original_message?.startsWith('[forwarded]');
    if (!isEscalated && relay.slack_message_ts) {
      msgParams.thread_ts = relay.slack_message_ts;
    }

    await slackClient.chat.postMessage(msgParams);
  } catch (err) {
    console.error(`[relay] _sendToRecipient error (relay ${relay.id}):`, err.message);
    throw err;
  }
}

/**
 * Format a millisecond duration as a human-friendly "X ago" string.
 * @param {number} ms
 * @returns {string}
 */
function _formatTimeAgo(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

// ---------------------------------------------------------------------------
// LLM drafting helpers (for approval responses)
// ---------------------------------------------------------------------------

/**
 * Draft a proper Argus-style response from User A's instructions.
 *
 * Instead of sending User A's words verbatim (e.g., "share info" or
 * "tell her the meeting is at 3"), we use an LLM to write a proper
 * message as Argus would deliver it to User B.
 *
 * @param {string} instructions    - What User A typed (their instructions)
 * @param {object} approval        - The approval queue row
 * @param {object} relay           - The relay row (joined)
 * @param {string} anthropicApiKey
 * @returns {Promise<string>}
 */
async function _draftFromInstructions(instructions, approval, relay, anthropicApiKey) {
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const recipientName = relay?.recipient_name ?? 'the recipient';
  const originalQuestion = approval.recipient_question ?? '';
  const originalMessage = relay?.original_message ?? '';

  const systemPrompt = `You are Argus, a private intelligence steward with a refined British butler persona.

Your employer has given you instructions on how to respond to someone named ${recipientName}.

Context:
- Original message sent to ${recipientName}: "${originalMessage}"
- ${recipientName} asked: "${originalQuestion}"
- Your employer's instructions: "${instructions}"

Write a response TO ${recipientName} that:
1. Follows your employer's instructions (the spirit of what they want communicated)
2. Is written in your Argus voice (refined, British, measured, slightly witty)
3. Does NOT reveal that you're relaying instructions from your employer
4. Sounds natural and conversational, not robotic
5. Is concise — 1-3 sentences typically
6. Signs off with: — *Argus* 🎩

IMPORTANT: Write ONLY the message to send. No preamble, no explanation, just the message.`;

  try {
    const response = await client.messages.create({
      model: EVALUATOR_MODEL,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Draft the response based on the instructions: "${instructions}"` }],
    });

    const text = response.content?.[0]?.text?.trim();
    if (text && text.length > 5) {
      console.log(`[relay] Drafted response from instructions: "${instructions}" → "${text.substring(0, 100)}..."`);
      return text;
    }
  } catch (err) {
    console.error('[relay] _draftFromInstructions error:', err.message);
  }

  // Fallback: wrap the instructions minimally rather than sending verbatim
  return `${instructions}\n\n— _Argus_ 🎩`;
}

/**
 * Generate a response from context when User A approves but there's no
 * suggested response available.
 *
 * @param {object} approval
 * @param {object} relay
 * @param {string} anthropicApiKey
 * @returns {Promise<string|null>}
 */
async function _generateResponseFromContext(approval, relay, anthropicApiKey) {
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const recipientName = relay?.recipient_name ?? 'the recipient';
  const originalQuestion = approval.recipient_question ?? '';
  const originalMessage = relay?.original_message ?? '';

  const systemPrompt = `You are Argus, a private intelligence steward with a refined British butler persona.

Your employer has approved sharing information with ${recipientName}, but no specific draft was prepared.

Context:
- Original message sent to ${recipientName}: "${originalMessage}"
- ${recipientName} asked: "${originalQuestion}"
- Your employer approved responding

Write a helpful, natural response to ${recipientName}'s question based on the context available.
Be concise (1-3 sentences). Sign off with: — *Argus* 🎩
Write ONLY the message to send.`;

  try {
    const response = await client.messages.create({
      model: EVALUATOR_MODEL,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Respond to: "${originalQuestion}"` }],
    });

    const text = response.content?.[0]?.text?.trim();
    if (text && text.length > 5) return text;
  } catch (err) {
    console.error('[relay] _generateResponseFromContext error:', err.message);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createRelay,
  findActiveRelay,
  evaluateReply,
  requestApproval,
  processApproval,
  findPendingApproval,
  getApprovalContext,
  checkPendingForRecipient,
  isLateResponse,
  expireStale,
};
