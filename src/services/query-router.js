'use strict';

/**
 * query-router.js — Multi-user query routing for Atlas Slack bot.
 *
 * Determines:
 *   1. WHO the question is about (data owner)
 *   2. Whether the requestor has permission to access that data
 *   3. What action to take (direct access, escalate, clarify, autonomous)
 *
 * Flow:
 *   classifyIntent() → resolveDataOwner() → checkPermission() → route decision
 */

const supabase = require('../utils/supabase');

/**
 * Route a user's message to the appropriate handler.
 *
 * @param {object} params
 * @param {string} params.message          - The user's message text
 * @param {string} params.requestorSlackId - Slack user ID of the person asking
 * @param {string|null} params.requestorAtlasId - Atlas user ID (null if non-Atlas)
 * @param {string} params.requestorName    - Display name
 * @returns {Promise<RoutingDecision>}
 *
 * @typedef {object} RoutingDecision
 * @property {'self_query'|'cross_user_query'|'autonomous'|'clarify'|'escalate'} action
 * @property {string|null} dataOwnerAtlasId    - Atlas user ID to query data from
 * @property {string|null} dataOwnerName       - Human-readable name
 * @property {string|null} dataOwnerSlackId    - For sending escalation DMs
 * @property {string[]} dataTypes              - What data types are needed
 * @property {string|null} clarificationPrompt - If action='clarify', what to ask
 * @property {string|null} permissionReason    - Why permission was granted/denied
 * @property {number} confidence               - 0.0 - 1.0
 */
async function routeQuery({
  message,
  requestorSlackId,
  requestorAtlasId,
  requestorName,
}) {
  const { classifyIntent, getAtlasUserList } = require('./intent-classifier');
  const { checkPermission } = require('./permission-check');

  // ── Get list of all Atlas users for the classifier ────────────────────
  let atlasUsers;
  try {
    atlasUsers = await getAtlasUserList(supabase);
  } catch (err) {
    console.error('[router] Failed to get Atlas user list:', err.message);
    atlasUsers = [];
  }

  const requestorIsAtlasUser = !!requestorAtlasId;

  // ── Classify the intent ───────────────────────────────────────────────
  let intent;
  try {
    intent = await classifyIntent(
      message,
      requestorName,
      requestorIsAtlasUser,
      atlasUsers.map(u => ({ name: u.name, email: u.email }))
    );
  } catch (err) {
    console.error('[router] Intent classification failed:', err.message);
    // Fallback: treat as general/autonomous
    return {
      action: 'autonomous',
      dataOwnerAtlasId: null,
      dataOwnerName: null,
      dataOwnerSlackId: null,
      dataTypes: [],
      clarificationPrompt: null,
      permissionReason: 'Classification failed — defaulting to autonomous',
      confidence: 0,
    };
  }

  console.log('[router] Intent:', JSON.stringify(intent));

  // ── General questions → autonomous (no data routing needed) ───────────
  if (intent.type === 'general') {
    return {
      action: 'autonomous',
      dataOwnerAtlasId: null,
      dataOwnerName: null,
      dataOwnerSlackId: null,
      dataTypes: intent.data_types || [],
      clarificationPrompt: null,
      permissionReason: null,
      confidence: intent.confidence,
    };
  }

  // ── Self-query: requestor asking about their own data ─────────────────
  if (intent.type === 'self_query') {
    if (!requestorAtlasId) {
      // Non-Atlas user saying "my calendar" — they don't have data synced
      return {
        action: 'autonomous',
        dataOwnerAtlasId: null,
        dataOwnerName: null,
        dataOwnerSlackId: null,
        dataTypes: intent.data_types || [],
        clarificationPrompt: null,
        permissionReason: 'Non-Atlas user self-query — no synced data',
        confidence: intent.confidence,
      };
    }
    return {
      action: 'self_query',
      dataOwnerAtlasId: requestorAtlasId,
      dataOwnerName: requestorName,
      dataOwnerSlackId: requestorSlackId,
      dataTypes: intent.data_types || [],
      clarificationPrompt: null,
      permissionReason: 'Self-query — direct access',
      confidence: intent.confidence,
    };
  }

  // ── Other-person query or action: need to resolve the data owner ──────
  if (intent.type === 'other_query' || intent.type === 'action') {
    // Low confidence → ask for clarification
    if (intent.confidence < 0.7 || !intent.data_owner_name) {
      const candidates = _findPossibleOwners(intent.data_owner_name, atlasUsers);

      let clarificationPrompt;
      if (candidates.length === 0) {
        clarificationPrompt = "I'm not quite sure whose data you're asking about. Could you be more specific?";
      } else if (candidates.length === 1) {
        clarificationPrompt = `Just to confirm — are you asking about ${candidates[0].name}?`;
      } else {
        const options = candidates.map((c, i) => `${i + 1}. *${c.name}*`).join('\n');
        clarificationPrompt = `A few people could be relevant here:\n${options}\n\nWho did you have in mind?`;
      }

      return {
        action: 'clarify',
        dataOwnerAtlasId: null,
        dataOwnerName: intent.data_owner_name,
        dataOwnerSlackId: null,
        dataTypes: intent.data_types || [],
        clarificationPrompt,
        permissionReason: `Low confidence (${intent.confidence}) — asking for clarification`,
        confidence: intent.confidence,
      };
    }

    // High confidence → resolve the data owner to an Atlas user
    const owner = _resolveOwner(intent.data_owner_name, atlasUsers);
    if (!owner) {
      // Named person isn't an Atlas user — can't route to their data
      // Fall through to autonomous (or escalate to admin if it seems like a data request)
      return {
        action: 'autonomous',
        dataOwnerAtlasId: null,
        dataOwnerName: intent.data_owner_name,
        dataOwnerSlackId: null,
        dataTypes: intent.data_types || [],
        clarificationPrompt: null,
        permissionReason: `${intent.data_owner_name} is not an Atlas user — no synced data available`,
        confidence: intent.confidence,
      };
    }

    // ── Check permissions ─────────────────────────────────────────────────
    const permResult = await checkPermission(supabase, {
      requestorSlackId,
      dataOwnerAtlasId: owner.atlasId,
      dataType: (intent.data_types && intent.data_types[0]) || 'all',
    });

    if (permResult.allowed) {
      // Direct access granted (self, admin, or standing permission)
      const actionType = permResult.scope === 'self' ? 'self_query' : 'cross_user_query';
      return {
        action: actionType,
        dataOwnerAtlasId: owner.atlasId,
        dataOwnerName: owner.name,
        dataOwnerSlackId: owner.slackId,
        dataTypes: intent.data_types || [],
        clarificationPrompt: null,
        permissionReason: permResult.reason,
        confidence: intent.confidence,
      };
    }

    // Permission not granted → escalate to data owner
    return {
      action: 'escalate',
      dataOwnerAtlasId: owner.atlasId,
      dataOwnerName: owner.name,
      dataOwnerSlackId: owner.slackId,
      dataTypes: intent.data_types || [],
      clarificationPrompt: null,
      permissionReason: permResult.reason,
      confidence: intent.confidence,
    };
  }

  // ── Fallback ──────────────────────────────────────────────────────────
  return {
    action: 'autonomous',
    dataOwnerAtlasId: null,
    dataOwnerName: null,
    dataOwnerSlackId: null,
    dataTypes: [],
    clarificationPrompt: null,
    permissionReason: 'Unrecognized intent type — defaulting to autonomous',
    confidence: 0,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Find Atlas users whose name fuzzy-matches the given name.
 */
function _findPossibleOwners(name, atlasUsers) {
  if (!name) return atlasUsers.slice(0, 5); // Show up to 5 if totally ambiguous

  const lower = name.toLowerCase().trim();
  return atlasUsers.filter(u => {
    const uName = (u.name || '').toLowerCase();
    const uEmail = (u.email || '').toLowerCase();
    const firstName = uName.split(/\s+/)[0];
    // Match on full name, first name, or email prefix
    return uName.includes(lower) || lower.includes(firstName) || uEmail.startsWith(lower);
  });
}

/**
 * Resolve a name to a specific Atlas user. Returns the best match or null.
 */
function _resolveOwner(name, atlasUsers) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();

  // Exact name match
  let match = atlasUsers.find(u => (u.name || '').toLowerCase() === lower);
  if (match) return match;

  // First name match (only if unique)
  const firstNameMatches = atlasUsers.filter(u => {
    const firstName = (u.name || '').toLowerCase().split(/\s+/)[0];
    return firstName === lower;
  });
  if (firstNameMatches.length === 1) return firstNameMatches[0];

  // Email prefix match
  match = atlasUsers.find(u => (u.email || '').toLowerCase().split('@')[0] === lower);
  if (match) return match;

  // Partial match (contains)
  const partialMatches = atlasUsers.filter(u => (u.name || '').toLowerCase().includes(lower));
  if (partialMatches.length === 1) return partialMatches[0];

  return null;
}

module.exports = { routeQuery };
