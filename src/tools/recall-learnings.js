'use strict';

/**
 * recall-learnings.js
 * Query argus_learnings by atlas_user_id with optional filters.
 * Includes confidence-aware prefixes and expiry for non-confirmed learnings.
 */

const supabase = require('../utils/supabase');

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

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
      .select('id, category, person_name, person_id, content, source, confidence, created_at')
      .eq('atlas_user_id', atlasUserId)
      .eq('active', 1)
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

    // Filter out expired non-confirmed learnings (90+ days old)
    const ninetyDaysAgo = Date.now() - NINETY_DAYS_MS;
    learnings = learnings.filter(l => {
      const conf = l.confidence || 'inferred';
      if (conf === 'user_confirmed') return true; // never expires
      return l.created_at > ninetyDaysAgo;
    });

    // Apply free-text search if query provided
    if (query) {
      const lc = query.toLowerCase();
      learnings = learnings.filter(l =>
        (l.content || '').toLowerCase().includes(lc) ||
        (l.person_name || '').toLowerCase().includes(lc) ||
        (l.category || '').toLowerCase().includes(lc)
      );
    }

    const mapped = learnings.map(l => {
      const conf = l.confidence || 'inferred';
      const prefix = conf === 'inferred' ? '⚠️ (inferred — treat as hypothesis) ' :
                     conf === 'observed' ? '📊 (observed in data) ' :
                     '✅ (user confirmed) ';
      return {
        id: l.id,
        category: l.category,
        person_name: l.person_name || null,
        content: prefix + l.content,
        confidence: conf,
        source: l.source || null,
        created_at: l.created_at,
      };
    });

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
