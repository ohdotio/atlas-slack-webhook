'use strict';

/**
 * search-imessages.js
 * Search iMessage messages in Supabase with ILIKE on text.
 * Always scoped to atlasUserId.
 */

const supabase = require('../utils/supabase');

/**
 * @param {string} atlasUserId
 * @param {{
 *   query?: string,
 *   person_name?: string,
 *   person_id?: string,
 *   start_date?: string,
 *   end_date?: string,
 *   limit?: number
 * }} params
 * @returns {Promise<object>}
 */
async function searchImessages(atlasUserId, {
  query,
  person_name,
  person_id,
  start_date,
  end_date,
  limit = 30,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };

    const effectiveLimit = Math.min(limit || 30, 100);

    // Resolve person_name to person_id if needed
    let resolvedPersonId = person_id || null;
    if (!resolvedPersonId && person_name) {
      const { data: people } = await supabase
        .from('people')
        .select('id')
        .eq('atlas_user_id', atlasUserId)
        .ilike('name', `%${person_name}%`)
        .limit(1);
      if (people && people.length > 0) resolvedPersonId = people[0].id;
    }

    let q = supabase
      .from('imessage_messages')
      .select('id, text, sender_name, is_from_me, timestamp, chat_identifier, person_id')
      .eq('atlas_user_id', atlasUserId)
      .order('timestamp', { ascending: false })
      .limit(effectiveLimit);

    if (query) {
      q = q.ilike('text', `%${query}%`);
    }

    if (resolvedPersonId) {
      q = q.eq('person_id', resolvedPersonId);
    }

    if (start_date) {
      q = q.gte('timestamp', start_date);
    }

    if (end_date) {
      q = q.lte('timestamp', end_date);
    }

    const { data, error } = await q;

    if (error) return { error: `DB error searching iMessages: ${error.message}` };

    const messages = (data || []).map(m => ({
      id: m.id,
      text: m.text ? m.text.substring(0, 500) : null,
      sender_name: m.sender_name || (m.is_from_me ? 'Me' : 'Unknown'),
      is_from_me: m.is_from_me || false,
      timestamp: m.timestamp,
      chat_identifier: m.chat_identifier || null,
    }));

    return {
      found: messages.length,
      query: query || null,
      person_id: resolvedPersonId,
      messages,
    };
  } catch (err) {
    return { error: `searchImessages failed: ${err.message}` };
  }
}

module.exports = searchImessages;
