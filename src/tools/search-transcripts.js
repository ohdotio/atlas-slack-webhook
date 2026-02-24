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
      .select('id, title, recorded_at, duration_seconds, transcript_full, summary, people_matched, source')
      .eq('atlas_user_id', atlasUserId)
      .order('recorded_at', { ascending: false })
      .limit(effectiveLimit);

    if (query) {
      q = q.or(`title.ilike.%${query}%,transcript_full.ilike.%${query}%,summary.ilike.%${query}%`);
    }

    if (person_name) {
      q = q.ilike('people_matched', `%${person_name}%`);
    }

    if (start_date) {
      q = q.gte('recorded_at', start_date);
    }

    if (end_date) {
      q = q.lte('recorded_at', end_date);
    }

    const { data, error } = await q;

    if (error) return { error: `DB error searching transcripts: ${error.message}` };

    const transcripts = (data || []).map(t => ({
      id: t.id,
      title: t.title || '(untitled)',
      date: t.recorded_at,
      duration_seconds: t.duration_seconds || null,
      summary: t.summary ? t.summary.substring(0, 1000) : null,
      people_matched: t.people_matched || [],
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
