'use strict';

/**
 * search-emails.js
 * Search emails in Supabase with ILIKE on subject + snippet.
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
async function searchEmails(atlasUserId, {
  query,
  person_name,
  person_id,
  start_date,
  end_date,
  limit = 20,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };

    const effectiveLimit = Math.min(limit || 20, 50);

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
      .from('emails')
      .select('id, subject, from_email, from_name, to_emails, snippet, received_at, person_id, direction')
      .eq('atlas_user_id', atlasUserId)
      .order('received_at', { ascending: false })
      .limit(effectiveLimit);

    if (query) {
      q = q.or(`subject.ilike.%${query}%,snippet.ilike.%${query}%`);
    }

    if (resolvedPersonId) {
      q = q.eq('person_id', resolvedPersonId);
    }

    if (start_date) {
      q = q.gte('received_at', start_date);
    }

    if (end_date) {
      q = q.lte('received_at', end_date);
    }

    const { data, error } = await q;

    if (error) return { error: `DB error searching emails: ${error.message}` };

    const emails = (data || []).map(e => ({
      id: e.id,
      subject: e.subject || '(no subject)',
      from: e.from_name ? `${e.from_name} <${e.from_email}>` : e.from_email,
      to: e.to_emails || null,
      date: e.received_at,
      direction: e.direction || null,
      snippet: e.snippet ? e.snippet.substring(0, 500) : null,
    }));

    return {
      found: emails.length,
      query: query || null,
      person_id: resolvedPersonId,
      emails,
    };
  } catch (err) {
    return { error: `searchEmails failed: ${err.message}` };
  }
}

module.exports = searchEmails;
