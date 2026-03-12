'use strict';

/**
 * unified-history.js — Write conversation turns to argus_conversations.
 *
 * Every surface (sendblue, voice, slack, electron) writes here so that:
 *   1. Daily summary job can read ALL conversations per user
 *   2. Cross-surface context can be injected into system prompts
 *   3. One canonical conversation history table for all channels
 *
 * Fire-and-forget — never blocks the response to the user.
 */

const supabase = require('../utils/supabase');

// ID generation: offset to avoid collision with Electron's SQLite autoincrement
const ID_OFFSET = 20_000_000;
let _counter = 0;
function nextId() {
  return ID_OFFSET + Math.floor(Date.now() / 1000) * 100 + (_counter++ % 100);
}

/**
 * Resolve a phone number to a person_id in the people table.
 * Returns null if no match found.
 */
async function resolvePersonId(atlasUserId, phone) {
  if (!phone || !atlasUserId) return null;
  try {
    const cleanPhone = phone.replace('+', '');
    const { data } = await supabase
      .from('people')
      .select('id')
      .eq('atlas_user_id', atlasUserId)
      .ilike('phone', `%${cleanPhone}%`)
      .limit(1)
      .maybeSingle();
    return data?.id ? String(data.id) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Write a user+assistant exchange to argus_conversations.
 *
 * @param {object} params
 * @param {string} params.atlasUserId - Owner's atlas user ID
 * @param {string} params.userMessage - What the user said
 * @param {string} params.assistantReply - What Argus replied
 * @param {string} params.source - 'sendblue' | 'voice' | 'slack' | 'app'
 * @param {string} [params.personId] - person_id if known
 * @param {string} [params.phone] - phone number (used to resolve personId if not provided)
 */
async function logExchange({ atlasUserId, userMessage, assistantReply, source, personId, phone }) {
  if (!atlasUserId || !userMessage) return;

  try {
    // Resolve person_id from phone if not provided
    let pid = personId || null;
    if (!pid && phone) {
      pid = await resolvePersonId(atlasUserId, phone);
    }

    const sessionId = `${source}_${Date.now()}`;
    const now = new Date().toISOString();

    const rows = [];

    // User message — extract text from multimodal content
    const userText = typeof userMessage === 'string'
      ? userMessage
      : (Array.isArray(userMessage)
        ? userMessage.filter(p => p.type === 'text').map(p => p.text).join(' ')
        : String(userMessage));

    if (userText.trim()) {
      rows.push({
        id: nextId(),
        atlas_user_id: atlasUserId,
        person_id: pid || 'me',
        session_id: sessionId,
        role: 'user',
        content: userText.substring(0, 10000),
        source,
        channel: source,
        created_at: now,
      });
    }

    // Assistant reply
    if (assistantReply && assistantReply.trim()) {
      rows.push({
        id: nextId(),
        atlas_user_id: atlasUserId,
        person_id: pid || 'me',
        session_id: sessionId,
        role: 'assistant',
        content: assistantReply.substring(0, 10000),
        source,
        channel: source,
        created_at: now,
      });
    }

    if (rows.length > 0) {
      const { error } = await supabase
        .from('argus_conversations')
        .insert(rows);

      if (error) {
        console.warn(`[unified-history] Insert failed (${source}):`, error.message);
      }
    }
  } catch (err) {
    console.warn(`[unified-history] logExchange error (${source}):`, err.message);
  }
}

/**
 * Fetch recent conversation turns from OTHER surfaces for cross-channel context.
 *
 * @param {string} atlasUserId
 * @param {string} currentSource - The surface making the request (excluded from results)
 * @param {number} [limit=15] - Max turns to return
 * @returns {Promise<string>} Formatted context block for system prompt injection, or ''
 */
async function getCrossChannelContext(atlasUserId, currentSource, limit = 15) {
  if (!atlasUserId) return '';

  try {
    let query = supabase
      .from('argus_conversations')
      .select('role, content, source, created_at')
      .eq('atlas_user_id', atlasUserId)
      .neq('source', currentSource)
      .order('created_at', { ascending: false })
      .limit(limit);

    const { data, error } = await query;

    if (error || !data || data.length === 0) return '';

    // Reverse to chronological
    const turns = data.reverse();

    const lines = turns.map(t => {
      const src = { sendblue: 'iMessage', voice: 'Voice', slack: 'Slack', app: 'Desktop' }[t.source] || t.source;
      const who = t.role === 'user' ? 'You' : 'Argus';
      let ts = '';
      if (t.created_at) {
        ts = new Date(t.created_at).toLocaleString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
        });
      }
      return `[${src}${ts ? ' ' + ts : ''}] ${who}: ${(t.content || '').substring(0, 1000)}`;
    });

    return `\n\nRECENT ARGUS CONVERSATIONS ON OTHER CHANNELS:\nThe principal may reference these. Use this context naturally — don't mention you "looked it up."\n\n${lines.join('\n')}`;
  } catch (err) {
    console.warn(`[unified-history] getCrossChannelContext error:`, err.message);
    return '';
  }
}

module.exports = { logExchange, resolvePersonId, getCrossChannelContext };
