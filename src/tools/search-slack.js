'use strict';

/**
 * search-slack.js
 * Search Slack messages in Supabase with ILIKE on text.
 * Always scoped to atlasUserId.
 */

const supabase = require('../utils/supabase');

/**
 * @param {string} atlasUserId
 * @param {{
 *   query?: string,
 *   person_name?: string,
 *   channel?: string,
 *   start_date?: string,
 *   end_date?: string,
 *   limit?: number
 * }} params
 * @returns {Promise<object>}
 */
async function searchSlackMessages(atlasUserId, {
  query,
  person_name,
  channel,
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
      .from('slack_messages')
      .select('id, text, from_user_name, from_user_id, channel_name, channel_id, timestamp, person_id')
      .eq('atlas_user_id', atlasUserId)
      .order('timestamp', { ascending: false })
      .limit(effectiveLimit);

    if (query) {
      q = q.ilike('text', `%${query}%`);
    }

    if (resolvedPersonId) {
      q = q.eq('person_id', resolvedPersonId);
    }

    if (channel) {
      q = q.ilike('channel_name', `%${channel}%`);
    }

    if (start_date) {
      q = q.gte('timestamp', start_date);
    }

    if (end_date) {
      q = q.lte('timestamp', end_date);
    }

    const { data, error } = await q;

    if (error) return { error: `DB error searching Slack: ${error.message}` };

    const messages = (data || []).map(m => ({
      id: m.id,
      text: m.text ? m.text.substring(0, 500) : null,
      sender: m.from_user_name || m.from_user_id || 'Unknown',
      channel: m.channel_name || m.channel_id || null,
      timestamp: m.timestamp,
      person_id: m.person_id || null,
    }));

    return {
      found: messages.length,
      query: query || null,
      person_name: person_name || null,
      channel: channel || null,
      messages,
    };
  } catch (err) {
    return { error: `searchSlackMessages failed: ${err.message}` };
  }
}

module.exports = searchSlackMessages;
