'use strict';

/**
 * Identity resolution service.
 *
 * Maps a Slack user (slack_user_id + slack_team_id) to an Atlas user id by:
 *   1. Checking the `user_slack_identities` table (fast path).
 *   2. Fetching the user's email from Slack and matching against `user` table.
 *   3. Auto-creating the `user_slack_identities` row on first match.
 *
 * Results are cached in-memory for 5 minutes to reduce DB + Slack API load.
 */

const { WebClient } = require('@slack/web-api');
const supabase = require('../utils/supabase');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * @typedef {{ atlasUserId: string; cachedAt: number }} CacheEntry
 */

/** @type {Map<string, CacheEntry>} */
const identityCache = new Map();

/**
 * Build a cache key for a (slackUserId, slackTeamId) pair.
 * @param {string} slackUserId
 * @param {string} slackTeamId
 * @returns {string}
 */
function cacheKey(slackUserId, slackTeamId) {
  return `${slackTeamId}:${slackUserId}`;
}

/**
 * Resolve a Slack user to an Atlas user id.
 *
 * @param {string} slackUserId  - Slack user id (e.g. "U01234567")
 * @param {string} slackTeamId  - Slack workspace / team id (e.g. "T01234567")
 * @returns {Promise<string|null>} Atlas user id, or null if unresolvable.
 */
async function resolveIdentity(slackUserId, slackTeamId) {
  // ── 1. In-memory cache ────────────────────────────────────────────────────
  const key = cacheKey(slackUserId, slackTeamId);
  const cached = identityCache.get(key);

  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.atlasUserId;
  }

  // ── 2. `user_slack_identities` table lookup ───────────────────────────────
  const { data: identity, error: identityErr } = await supabase
    .from('user_slack_identities')
    .select('atlas_user_id')
    .eq('slack_user_id', slackUserId)
    .eq('slack_team_id', slackTeamId)
    .maybeSingle();

  if (identityErr) {
    console.error('[identity] DB error on user_slack_identities lookup:', identityErr.message);
  }

  if (identity?.atlas_user_id) {
    _cacheIdentity(key, identity.atlas_user_id);
    return identity.atlas_user_id;
  }

  // ── 3. Fetch email from Slack ─────────────────────────────────────────────
  let email;
  let displayName;
  try {
    const info = await slack.users.info({ user: slackUserId });
    email = info.user?.profile?.email;
    displayName = info.user?.profile?.display_name || info.user?.real_name;
  } catch (err) {
    console.error('[identity] slack.users.info error:', err.message);
    return null;
  }

  if (!email) {
    console.warn(`[identity] No email for Slack user ${slackUserId}`);
    return null;
  }

  // ── 4. Match email against Atlas `user` table ─────────────────────────────
  const { data: atlasUser, error: userErr } = await supabase
    .from('user')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (userErr) {
    console.error('[identity] DB error on user lookup:', userErr.message);
    return null;
  }

  if (!atlasUser?.id) {
    console.warn(`[identity] No Atlas user found for email ${email}`);
    return null;
  }

  const atlasUserId = atlasUser.id;

  // ── 5. Auto-create `user_slack_identities` row ────────────────────────────
  const { error: insertErr } = await supabase.from('user_slack_identities').insert({
    slack_user_id: slackUserId,
    slack_team_id: slackTeamId,
    atlas_user_id: atlasUserId,
    slack_display_name: displayName ?? null,
    slack_dm_channel_id: null, // populated lazily when we open a DM
  });

  if (insertErr) {
    // Non-fatal: another request may have inserted concurrently (race).
    console.warn('[identity] Could not insert user_slack_identities row:', insertErr.message);
  }

  _cacheIdentity(key, atlasUserId);
  return atlasUserId;
}

/**
 * Store a resolved identity in the in-memory cache.
 * @param {string} key
 * @param {string} atlasUserId
 */
function _cacheIdentity(key, atlasUserId) {
  identityCache.set(key, { atlasUserId, cachedAt: Date.now() });
}

module.exports = { resolveIdentity };
