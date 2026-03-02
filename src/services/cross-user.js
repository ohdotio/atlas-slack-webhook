'use strict';

/**
 * cross-user.js
 *
 * Handles cross-user data access requests:
 *   1. Requestor asks about another Atlas user's private data
 *   2. Argus creates a request and DMs the data owner in a thread
 *   3. Owner responds in the thread (conversational — can ask questions, see data, direct Argus)
 *   4. Argus delivers the authorized response to the requestor
 *
 * The owner's DM thread is the single source of truth for each request.
 */

const { WebClient } = require('@slack/web-api');
const supabase = require('../utils/supabase');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// ── Atlas user matching ───────────────────────────────────────────────────

/**
 * Match a name to an Atlas user in the `user` table.
 * Returns { matched, user, candidates } where:
 *   matched: true if exactly one match
 *   user: the matched user record (or null)
 *   candidates: array of possible matches (for disambiguation)
 */
async function matchAtlasUser(name) {
  if (!name) return { matched: false, user: null, candidates: [] };

  const cleanName = name.trim().toLowerCase();

  // Fetch all Atlas users (small table — usually < 20)
  const { data: users, error } = await supabase
    .from('user')
    .select('id, name, email, role');

  if (error || !users || users.length === 0) {
    return { matched: false, user: null, candidates: [] };
  }

  // Exact match first
  const exact = users.find(u => u.name?.toLowerCase() === cleanName);
  if (exact) return { matched: true, user: exact, candidates: [exact] };

  // First name match
  const firstNameMatches = users.filter(u => {
    const firstName = u.name?.split(/\s+/)[0]?.toLowerCase();
    return firstName === cleanName;
  });
  if (firstNameMatches.length === 1) {
    return { matched: true, user: firstNameMatches[0], candidates: firstNameMatches };
  }
  if (firstNameMatches.length > 1) {
    return { matched: false, user: null, candidates: firstNameMatches };
  }

  // Fuzzy: name contains the search term
  const fuzzy = users.filter(u => u.name?.toLowerCase().includes(cleanName));
  if (fuzzy.length === 1) return { matched: true, user: fuzzy[0], candidates: fuzzy };
  if (fuzzy.length > 1) return { matched: false, user: null, candidates: fuzzy };

  // If there's only one Atlas user total, it's probably them
  if (users.length === 1) {
    return { matched: true, user: users[0], candidates: users };
  }

  return { matched: false, user: null, candidates: [] };
}

// ── Resolve owner's Slack user ID ─────────────────────────────────────────

/**
 * Find the Slack user ID for an Atlas user (for DM delivery).
 * Checks user_slack_identities table.
 */
async function getOwnerSlackId(atlasUserId) {
  // Check user_slack_identities
  const { data } = await supabase
    .from('user_slack_identities')
    .select('slack_user_id')
    .eq('atlas_user_id', atlasUserId)
    .limit(1)
    .maybeSingle();

  if (data?.slack_user_id) return data.slack_user_id;

  // Fallback to env var (single-owner bootstrap)
  if (process.env.OWNER_SLACK_USER_ID) {
    return process.env.OWNER_SLACK_USER_ID;
  }

  return null;
}

// ── Create request & notify owner ─────────────────────────────────────────

/**
 * Create a cross-user data request and DM the data owner.
 *
 * @param {object} params
 * @param {string} params.targetAtlasUserId - Data owner's Atlas user ID
 * @param {string} params.question - Original question
 * @param {string} params.dataType - 'calendar', 'email', 'contacts', etc.
 * @param {string} params.requestorName - Display name of requestor
 * @param {string|null} params.requestorAtlasUserId - Requestor's Atlas ID (if Atlas user)
 * @param {string|null} params.requestorSlackUserId - Requestor's Slack ID
 * @param {string|null} params.requestorPhone - Requestor's phone (Sendblue)
 * @param {string|null} params.requestorChannelId - Slack channel to reply in
 * @param {string|null} params.requestorThreadTs - Slack thread context
 * @param {string} params.surface - 'slack' or 'sendblue'
 * @returns {Promise<{success: boolean, requestId?: string, error?: string}>}
 */
async function createRequest(params) {
  const {
    targetAtlasUserId, question, dataType, requestorName,
    requestorAtlasUserId, requestorSlackUserId, requestorPhone,
    requestorChannelId, requestorThreadTs, surface,
  } = params;

  // Resolve owner's Slack ID
  const ownerSlackId = await getOwnerSlackId(targetAtlasUserId);
  if (!ownerSlackId) {
    return { success: false, error: 'Could not find a way to reach the data owner.' };
  }

  // Get owner's name for the notification
  const { data: ownerUser } = await supabase
    .from('user')
    .select('name')
    .eq('id', targetAtlasUserId)
    .maybeSingle();
  const ownerFirstName = ownerUser?.name?.split(/\s+/)[0] || 'the data owner';

  // Format the data type nicely
  const dataTypeLabels = {
    calendar: 'calendar / schedule',
    email: 'email',
    contacts: 'contacts',
    schedule: 'calendar / schedule',
    general: 'information',
  };
  const dataLabel = dataTypeLabels[dataType] || dataType || 'information';

  // Send the notification to the owner as a top-level DM
  // (not in a thread — this message CREATES the thread)
  const surfaceLabel = surface === 'sendblue' ? 'via iMessage' : 'on Slack';
  const notificationText =
    `🎩 *${requestorName}* is asking about your ${dataLabel} ${surfaceLabel}:\n\n` +
    `> _"${question}"_\n\n` +
    `↓ *Reply in this thread* to handle it. You can:\n` +
    `• Tell me what to say — _"tell them I'm free after 3"_\n` +
    `• Ask to see the data first — _"show me my Thursday"_\n` +
    `• Decline — _"no"_ or _"tell them I'm busy"_`;

  let ownerChannelId;
  let ownerThreadTs;

  try {
    // Post to owner's DM
    const result = await slack.chat.postMessage({
      channel: ownerSlackId,
      text: notificationText,
    });
    ownerChannelId = result.channel;
    ownerThreadTs = result.ts; // This message's ts IS the thread parent
    console.log(`[cross-user] Notified ${ownerFirstName} (${ownerSlackId}) — thread ${ownerThreadTs}`);
  } catch (err) {
    console.error(`[cross-user] Failed to DM owner:`, err.message);
    return { success: false, error: 'Failed to reach the data owner.' };
  }

  // Resolve owner's Slack user ID for the target field
  const targetSlackUserId = ownerSlackId;

  // Insert the request
  const { data: inserted, error: insertErr } = await supabase
    .from('cross_user_requests')
    .insert({
      requestor_atlas_user_id: requestorAtlasUserId || null,
      requestor_slack_user_id: requestorSlackUserId || null,
      requestor_phone: requestorPhone || null,
      requestor_name: requestorName,
      requestor_channel_id: requestorChannelId || null,
      requestor_thread_ts: requestorThreadTs || null,
      requestor_surface: surface,
      target_atlas_user_id: targetAtlasUserId,
      target_slack_user_id: targetSlackUserId,
      owner_channel_id: ownerChannelId,
      owner_thread_ts: ownerThreadTs,
      original_question: question,
      data_type: dataType || 'general',
      status: 'pending',
    })
    .select('id')
    .single();

  if (insertErr) {
    console.error(`[cross-user] DB insert error:`, insertErr.message);
    return { success: false, error: 'Failed to create the request.' };
  }

  console.log(`[cross-user] Request ${inserted.id} created: ${requestorName} → ${ownerFirstName} (${dataLabel})`);
  return { success: true, requestId: inserted.id };
}

// ── Check if a thread message is a cross-user response ────────────────────

/**
 * Look up a pending/in_progress cross-user request by owner thread.
 * @param {string} channelId
 * @param {string} threadTs - The PARENT message ts (not the reply ts)
 * @returns {Promise<object|null>} The request row, or null
 */
async function findRequestByOwnerThread(channelId, threadTs) {
  const { data, error } = await supabase
    .from('cross_user_requests')
    .select('*')
    .eq('owner_channel_id', channelId)
    .eq('owner_thread_ts', threadTs)
    .in('status', ['pending', 'in_progress'])
    .maybeSingle();

  if (error) {
    console.warn(`[cross-user] DB lookup error:`, error.message);
    return null;
  }
  return data;
}

// ── Deliver response to requestor ─────────────────────────────────────────

/**
 * Send the authorized response back to the original requestor.
 */
async function deliverToRequestor(request, responseText) {
  if (request.requestor_surface === 'slack') {
    // Reply in the requestor's original channel/thread
    try {
      await slack.chat.postMessage({
        channel: request.requestor_channel_id,
        text: responseText,
        thread_ts: request.requestor_thread_ts || undefined,
      });
      console.log(`[cross-user] Delivered to requestor ${request.requestor_name} on Slack`);
    } catch (err) {
      console.error(`[cross-user] Failed to deliver to Slack requestor:`, err.message);
    }
  } else if (request.requestor_surface === 'sendblue') {
    // Send via Sendblue to their phone
    if (request.requestor_phone) {
      try {
        // Dynamic import to avoid circular dependency
        const fetch = (await import('node-fetch')).default;
        const webhookUrl = process.env.SENDBLUE_WEBHOOK_URL || 'https://atlas-sendblue-webhook-production.up.railway.app';
        await fetch(`${webhookUrl}/api/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.API_TOKEN}`,
          },
          body: JSON.stringify({ to: request.requestor_phone, message: responseText }),
        });
        console.log(`[cross-user] Delivered to requestor ${request.requestor_name} via Sendblue`);
      } catch (err) {
        console.error(`[cross-user] Failed to deliver via Sendblue:`, err.message);
      }
    }
  }

  // Update the request
  await supabase
    .from('cross_user_requests')
    .update({
      status: 'answered',
      response_to_requestor: responseText,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', request.id);
}

/**
 * Mark a request as denied and deliver a polite deflection.
 */
async function denyRequest(request, deflectionText) {
  const response = deflectionText || `I wasn't able to get that information — you might want to reach out directly.`;
  await deliverToRequestor(request, response);

  await supabase
    .from('cross_user_requests')
    .update({ status: 'denied' })
    .eq('id', request.id);
}

/**
 * Update request status to in_progress (owner is engaging).
 */
async function markInProgress(requestId) {
  await supabase
    .from('cross_user_requests')
    .update({ status: 'in_progress' })
    .eq('id', requestId);
}

/**
 * Store the owner's final instruction on the request.
 */
async function storeOwnerInstruction(requestId, instruction) {
  await supabase
    .from('cross_user_requests')
    .update({ owner_instruction: instruction })
    .eq('id', requestId);
}

module.exports = {
  matchAtlasUser,
  createRequest,
  findRequestByOwnerThread,
  deliverToRequestor,
  denyRequest,
  markInProgress,
  storeOwnerInstruction,
};
