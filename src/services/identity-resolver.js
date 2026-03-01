'use strict';

/**
 * identity-resolver.js — Unified person identity resolution.
 *
 * Resolves any external identifier (Slack user ID, phone number, email) to a
 * person_id in the Atlas people table. This is the foundation for cross-channel
 * conversation context — the same person chatting on Slack and iMessage gets
 * the same history, memories, and context.
 *
 * Resolution is cached per-deploy (people don't change identity mid-session).
 */

const supabase = require('../utils/supabase');

// ── Cache ─────────────────────────────────────────────────────────────────────
// Maps identifier → person_id. Cleared on deploy (Railway restart).
const cache = new Map();

// Owner's atlas_user_id — resolved once and cached.
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
 * Resolve a Slack user ID to a person_id.
 *
 * @param {string} slackUserId - e.g. "U09CDJ5E3ML"
 * @returns {Promise<string|null>} person_id (slug like "missy-perdue") or null
 */
async function resolveBySlackId(slackUserId) {
  if (!slackUserId) return null;

  const cacheKey = `slack:${slackUserId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const ownerAtlasUserId = await getOwnerAtlasUserId();
  if (!ownerAtlasUserId) return null;

  const { data } = await supabase
    .from('people')
    .select('id')
    .eq('atlas_user_id', ownerAtlasUserId)
    .eq('slack_id', slackUserId)
    .eq('archived', 0)
    .eq('hidden', 0)
    .maybeSingle();

  const personId = data?.id || null;
  cache.set(cacheKey, personId);
  return personId;
}

/**
 * Resolve a phone number to a person_id.
 *
 * @param {string} phone - E.164 format, e.g. "+14197047571"
 * @returns {Promise<string|null>}
 */
async function resolveByPhone(phone) {
  if (!phone) return null;

  const cacheKey = `phone:${phone}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const ownerAtlasUserId = await getOwnerAtlasUserId();
  if (!ownerAtlasUserId) return null;

  const { data } = await supabase
    .from('people')
    .select('id')
    .eq('atlas_user_id', ownerAtlasUserId)
    .eq('phone', phone)
    .eq('archived', 0)
    .eq('hidden', 0)
    .maybeSingle();

  const personId = data?.id || null;
  cache.set(cacheKey, personId);
  return personId;
}

/**
 * Resolve an email address to a person_id.
 *
 * @param {string} email
 * @returns {Promise<string|null>}
 */
async function resolveByEmail(email) {
  if (!email) return null;

  const cacheKey = `email:${email.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const ownerAtlasUserId = await getOwnerAtlasUserId();
  if (!ownerAtlasUserId) return null;

  const { data } = await supabase
    .from('people')
    .select('id')
    .eq('atlas_user_id', ownerAtlasUserId)
    .ilike('email', email)
    .eq('archived', 0)
    .eq('hidden', 0)
    .maybeSingle();

  const personId = data?.id || null;
  cache.set(cacheKey, personId);
  return personId;
}

/**
 * Resolve any identifier to a person_id. Tries Slack ID, then phone, then email.
 *
 * @param {object} identifiers
 * @param {string} [identifiers.slackUserId]
 * @param {string} [identifiers.phone]
 * @param {string} [identifiers.email]
 * @returns {Promise<string|null>}
 */
async function resolvePerson({ slackUserId, phone, email } = {}) {
  return (
    (await resolveBySlackId(slackUserId)) ||
    (await resolveByPhone(phone)) ||
    (await resolveByEmail(email)) ||
    null
  );
}

module.exports = {
  resolvePerson,
  resolveBySlackId,
  resolveByPhone,
  resolveByEmail,
};
