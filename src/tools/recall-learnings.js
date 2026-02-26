'use strict';

/**
 * recall-learnings.js
 * Query argus_learnings by atlas_user_id with optional filters.
 */

const supabase = require('../utils/supabase');

/**
 * @param {string} atlasUserId
 * @param {{
 *   person_name?: string,
 *   category?: string,
 *   query?: string
 * }} params
 * @returns {Promise<object>}
 */
async function recallLearnings(atlasUserId, {
  person_name,
  category,
  query,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };

    let q = supabase
      .from('argus_learnings')
      .select('id, category, person_name, person_id, content, source, created_at')
      .eq('atlas_user_id', atlasUserId)
      .eq('active', true)
      .order('created_at', { ascending: false });

    if (person_name) {
      q = q.ilike('person_name', `%${person_name}%`);
    }

    if (category) {
      q = q.eq('category', category.toLowerCase());
    }

    const { data, error } = await q.limit(50);

    if (error) return { error: `DB error fetching learnings: ${error.message}` };

    let learnings = data || [];

    // Apply free-text search if query provided
    if (query) {
      const lc = query.toLowerCase();
      learnings = learnings.filter(l =>
        (l.content || '').toLowerCase().includes(lc) ||
        (l.person_name || '').toLowerCase().includes(lc) ||
        (l.category || '').toLowerCase().includes(lc)
      );
    }

    const mapped = learnings.map(l => ({
      id: l.id,
      category: l.category,
      person_name: l.person_name || null,
      content: l.content,
      source: l.source || null,
      created_at: l.created_at,
    }));

    return {
      found: mapped.length,
      filters: {
        person_name: person_name || null,
        category: category || null,
        query: query || null,
      },
      learnings: mapped,
    };
  } catch (err) {
    return { error: `recallLearnings failed: ${err.message}` };
  }
}

module.exports = recallLearnings;
