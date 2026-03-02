'use strict';

/**
 * cross-user.js
 *
 * Handles cross-user data access:
 *   1. Match a name to an Atlas user in the `user` table
 *   2. Notify the data owner via Slack DM
 *
 * The data owner then uses their normal Argus conversation to decide
 * what to share and directs Argus accordingly (e.g., "send Seth a
 * summary of my calendar this week"). No special threading or brokering
 * needed — the owner's existing Argus session IS the workspace.
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

// ── Notify data owner ─────────────────────────────────────────────────────

/**
 * Resolve the Slack user ID for an Atlas user.
 */
async function getOwnerSlackId(atlasUserId) {
  const { data } = await supabase
    .from('user_slack_identities')
    .select('slack_user_id')
    .eq('atlas_user_id', atlasUserId)
    .limit(1)
    .maybeSingle();

  if (data?.slack_user_id) return data.slack_user_id;

  // Fallback to env var (single-owner bootstrap)
  return process.env.OWNER_SLACK_USER_ID || null;
}

/**
 * Notify the data owner that someone is asking about their data.
 * Simple DM — no threading, no brokering. The owner uses their
 * normal Argus conversation to handle it.
 *
 * @param {object} params
 * @param {string} params.targetAtlasUserId
 * @param {string} params.requestorName
 * @param {string} params.question
 * @param {string} params.dataType
 * @param {string} params.surface - 'slack' or 'sendblue'
 */
async function notifyDataOwner({ targetAtlasUserId, requestorName, question, dataType, surface }) {
  const ownerSlackId = await getOwnerSlackId(targetAtlasUserId);
  if (!ownerSlackId) {
    console.warn(`[cross-user] No Slack ID for Atlas user ${targetAtlasUserId}`);
    return;
  }

  const dataTypeLabels = {
    calendar: 'calendar / schedule',
    email: 'email',
    contacts: 'contacts',
    schedule: 'calendar / schedule',
    general: 'information',
  };
  const dataLabel = dataTypeLabels[dataType] || dataType || 'information';
  const surfaceLabel = surface === 'sendblue' ? 'via iMessage' : 'on Slack';

  const text =
    `🎩 *${requestorName}* is asking about your ${dataLabel} ${surfaceLabel}:\n\n` +
    `> _"${question}"_\n\n` +
    `I'm still chatting with them. If you'd like to share something, just tell me ` +
    `(e.g., _"send ${requestorName.split(/\s+/)[0]} a summary of my calendar this week"_).`;

  try {
    await slack.chat.postMessage({ channel: ownerSlackId, text });
    console.log(`[cross-user] Notified data owner (${ownerSlackId}) — ${requestorName} asked about ${dataLabel}`);
  } catch (err) {
    console.error(`[cross-user] Failed to notify owner:`, err.message);
  }
}

module.exports = {
  matchAtlasUser,
  notifyDataOwner,
};
