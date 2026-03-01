'use strict';

/**
 * conversation-store.js — Persistent cross-channel conversation history.
 *
 * Stores and retrieves conversation turns in Supabase's argus_conversations
 * table, keyed by person_id. This means a person chatting on Slack and then
 * switching to iMessage gets full continuity — Argus remembers what was said
 * on both channels.
 *
 * Falls back gracefully if the person_id/source columns haven't been migrated
 * yet (uses the old in-memory approach).
 */

const supabase = require('../utils/supabase');

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_HISTORY_MESSAGES = 40;    // Max messages to pull for context
const MAX_STORED_MESSAGES = 200;    // Max messages to keep per person (prune oldest)
const OWNER_ATLAS_USER_ID_CACHE = { value: null };

async function getOwnerAtlasUserId() {
  if (OWNER_ATLAS_USER_ID_CACHE.value) return OWNER_ATLAS_USER_ID_CACHE.value;
  const { data } = await supabase
    .from('user_slack_identities')
    .select('atlas_user_id')
    .limit(1)
    .maybeSingle();
  if (data?.atlas_user_id) {
    OWNER_ATLAS_USER_ID_CACHE.value = data.atlas_user_id;
  }
  return OWNER_ATLAS_USER_ID_CACHE.value;
}

// ── Schema check (cached) ────────────────────────────────────────────────────
// We need to know if the person_id/source columns exist yet.
let _schemaReady = null;

async function isSchemaReady() {
  if (_schemaReady !== null) return _schemaReady;
  try {
    const { error } = await supabase
      .from('argus_conversations')
      .select('person_id, source')
      .limit(0);
    _schemaReady = !error;
  } catch {
    _schemaReady = false;
  }
  if (!_schemaReady) {
    console.warn('[conversation-store] Schema not migrated yet — person_id/source columns missing. Run migration 001.');
  }
  return _schemaReady;
}

/**
 * Fetch recent conversation history for a person across all channels.
 *
 * @param {string} personId - person_id from the people table
 * @param {object} [opts]
 * @param {number} [opts.limit=40] - Max messages to return
 * @returns {Promise<Array<{ role: string, content: string, source: string }>>}
 */
async function getHistory(personId, { limit = MAX_HISTORY_MESSAGES } = {}) {
  if (!personId || !(await isSchemaReady())) return [];

  try {
    const atlasUserId = await getOwnerAtlasUserId();
    if (!atlasUserId) return [];

    const { data, error } = await supabase
      .from('argus_conversations')
      .select('role, content, source, created_at')
      .eq('atlas_user_id', atlasUserId)
      .eq('person_id', personId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[conversation-store] getHistory error:', error.message);
      return [];
    }

    // Reverse to chronological order (DB returns newest first)
    return (data || []).reverse().map(row => ({
      role: row.role,
      content: row.content,
      source: row.source || 'unknown',
    }));
  } catch (err) {
    console.error('[conversation-store] getHistory error:', err.message);
    return [];
  }
}

/**
 * Append a message to the conversation store.
 *
 * @param {string} personId
 * @param {string} role - 'user' | 'assistant'
 * @param {string} content
 * @param {string} source - 'slack' | 'imessage' | 'sms' | 'app'
 * @returns {Promise<void>}
 */
async function appendMessage(personId, role, content, source = 'slack') {
  if (!personId || !(await isSchemaReady())) return;
  if (!content || content.trim().length === 0) return;

  try {
    const atlasUserId = await getOwnerAtlasUserId();
    if (!atlasUserId) return;

    const sessionId = `${source}_${Date.now()}`;

    const { error } = await supabase
      .from('argus_conversations')
      .insert({
        atlas_user_id: atlasUserId,
        person_id: personId,
        session_id: sessionId,
        role,
        content,
        source,
        channel: source,
        created_at: new Date().toISOString(),
      });

    if (error) {
      console.error('[conversation-store] appendMessage error:', error.message);
    }
  } catch (err) {
    console.error('[conversation-store] appendMessage error:', err.message);
  }
}

/**
 * Save a full exchange (user message + assistant reply) in one call.
 *
 * @param {string} personId
 * @param {string} userMessage
 * @param {string} assistantReply
 * @param {string} source
 * @returns {Promise<void>}
 */
async function saveExchange(personId, userMessage, assistantReply, source = 'slack') {
  if (!personId || !(await isSchemaReady())) return;

  await appendMessage(personId, 'user', userMessage, source);
  if (assistantReply) {
    await appendMessage(personId, 'assistant', assistantReply, source);
  }

  // Prune old messages (keep most recent MAX_STORED_MESSAGES per person)
  pruneOldMessages(personId).catch(err =>
    console.warn('[conversation-store] prune error:', err.message)
  );
}

/**
 * Prune old messages for a person to keep the table manageable.
 * @param {string} personId
 */
async function pruneOldMessages(personId) {
  try {
    const atlasUserId = await getOwnerAtlasUserId();
    if (!atlasUserId) return;

    // Get the created_at of the Nth most recent message
    const { data } = await supabase
      .from('argus_conversations')
      .select('created_at')
      .eq('atlas_user_id', atlasUserId)
      .eq('person_id', personId)
      .order('created_at', { ascending: false })
      .range(MAX_STORED_MESSAGES, MAX_STORED_MESSAGES);

    if (!data || data.length === 0) return; // Under the limit

    const cutoff = data[0].created_at;

    await supabase
      .from('argus_conversations')
      .delete()
      .eq('atlas_user_id', atlasUserId)
      .eq('person_id', personId)
      .lt('created_at', cutoff);
  } catch (err) {
    console.error('[conversation-store] pruneOldMessages error:', err.message);
  }
}

/**
 * Format cross-channel history for injection into the system prompt.
 * Tags messages with their source channel so Argus can reference naturally.
 *
 * @param {Array<{ role: string, content: string, source: string }>} history
 * @returns {Array<{ role: string, content: string }>} Formatted for Claude messages array
 */
function formatHistoryForPrompt(history) {
  if (!history || history.length === 0) return [];

  return history.map(msg => {
    // Tag cross-channel messages so Argus knows the source
    const tag = msg.source && msg.source !== 'slack'
      ? `[via ${msg.source === 'imessage' ? 'iMessage' : msg.source}] `
      : '';

    return {
      role: msg.role,
      content: msg.role === 'user' ? `${tag}${msg.content}` : msg.content,
    };
  });
}

module.exports = {
  getHistory,
  appendMessage,
  saveExchange,
  formatHistoryForPrompt,
};
