'use strict';

/**
 * search-beeper.js
 * Search Beeper messages in Supabase with ILIKE on text.
 * Always scoped to atlasUserId.
 */

const supabase = require('../utils/supabase');

/**
 * @param {string} atlasUserId
 * @param {{
 *   query?: string,
 *   person_name?: string,
 *   start_date?: string,
 *   end_date?: string,
 *   limit?: number
 * }} params
 * @returns {Promise<object>}
 */
async function searchBeeperMessages(atlasUserId, {
  query,
  person_name,
  start_date,
  end_date,
  limit = 30,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };

    const effectiveLimit = Math.min(limit || 30, 100);

    // Resolve person_name to person_id if needed
    let resolvedPersonId = null;
    if (person_name) {
      const { data: people } = await supabase
        .from('people')
        .select('id')
        .eq('atlas_user_id', atlasUserId)
        .ilike('name', `%${person_name}%`)
        .limit(1);
      if (people && people.length > 0) resolvedPersonId = people[0].id;
    }

    let q = supabase
      .from('beeper_messages')
      .select('id, text, sender, service, timestamp, chat_id, person_id')
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

    if (error) return { error: `DB error searching Beeper: ${error.message}` };

    const messages = (data || []).map(m => ({
      id: m.id,
      text: m.text ? m.text.substring(0, 500) : null,
      sender: m.sender || 'Unknown',
      service: m.service || null,
      timestamp: m.timestamp,
    }));

    return {
      found: messages.length,
      query: query || null,
      person_name: person_name || null,
      messages,
    };
  } catch (err) {
    return { error: `searchBeeperMessages failed: ${err.message}` };
  }
}

module.exports = searchBeeperMessages;
