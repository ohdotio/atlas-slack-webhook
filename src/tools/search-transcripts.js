'use strict';

/**
 * search-transcripts.js
 * Search meeting transcriptions in Supabase.
 * ILIKE on title, content, and summary.
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
async function searchTranscripts(atlasUserId, {
  query,
  person_name,
  start_date,
  end_date,
  limit = 10,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };

    const effectiveLimit = Math.min(limit || 10, 50);

    // Build OR filter for text search across title, content, summary
    // Supabase's .or() supports PostgREST filter syntax
    let q = supabase
      .from('transcriptions')
      .select('id, title, date, duration, content, summary, attendees, source')
      .eq('atlas_user_id', atlasUserId)
      .order('date', { ascending: false })
      .limit(effectiveLimit);

    if (query) {
      q = q.or(`title.ilike.%${query}%,content.ilike.%${query}%,summary.ilike.%${query}%`);
    }

    // Filter by attendees if person_name given (attendees is typically an array or text)
    if (person_name) {
      // Attempt ilike on the attendees field (works if stored as text; arrays need a different approach)
      q = q.ilike('attendees', `%${person_name}%`);
    }

    if (start_date) {
      q = q.gte('date', start_date);
    }

    if (end_date) {
      q = q.lte('date', end_date);
    }

    const { data, error } = await q;

    if (error) return { error: `DB error searching transcripts: ${error.message}` };

    const transcripts = (data || []).map(t => ({
      id: t.id,
      title: t.title || '(untitled)',
      date: t.date,
      duration: t.duration || null,
      summary: t.summary ? t.summary.substring(0, 1000) : null,
      attendees: t.attendees || [],
      source: t.source || null,
    }));

    return {
      found: transcripts.length,
      query: query || null,
      person_name: person_name || null,
      transcripts,
    };
  } catch (err) {
    return { error: `searchTranscripts failed: ${err.message}` };
  }
}

module.exports = searchTranscripts;
