'use strict';

/**
 * get-war-room.js
 * Query war_room_situations for active situations.
 * Supports optional person_name filter.
 * Always scoped to atlasUserId.
 */

const supabase = require('../utils/supabase');

/**
 * @param {string} atlasUserId
 * @param {{
 *   person_name?: string,
 *   include_resolved?: boolean
 * }} params
 * @returns {Promise<object>}
 */
async function getWarRoom(atlasUserId, {
  person_name,
  include_resolved = false,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };

    let q = supabase
      .from('war_room_situations')
      .select('id, person_id, person_name, situation_type, excerpt, score, detected_at, resolved_at, dismissed_at, snoozed_until')
      .eq('atlas_user_id', atlasUserId)
      .order('score', { ascending: false });

    if (!include_resolved) {
      q = q.is('resolved_at', null).is('dismissed_at', null);
      // Exclude snoozed items (snoozed_until in the future)
      // We'll filter these in JS since Supabase doesn't easily do "is null OR < now"
    }

    if (person_name) {
      q = q.ilike('person_name', `%${person_name}%`);
    }

    const { data, error } = await q.limit(50);

    if (error) return { error: `DB error fetching war room: ${error.message}` };

    let situations = data || [];

    // Filter out snoozed items (snoozed_until in the future)
    if (!include_resolved) {
      const now = new Date().toISOString();
      situations = situations.filter(s =>
        !s.snoozed_until || s.snoozed_until < now
      );
    }

    const mapped = situations.map(s => ({
      id: s.id,
      person_name: s.person_name || 'Unknown',
      person_id: s.person_id,
      type: s.situation_type,
      excerpt: s.excerpt,
      score: s.score,
      detected_at: s.detected_at,
      resolved_at: s.resolved_at || null,
      dismissed_at: s.dismissed_at || null,
      snoozed_until: s.snoozed_until || null,
    }));

    return {
      found: mapped.length,
      filter: person_name || 'all active',
      situations: mapped,
    };
  } catch (err) {
    return { error: `getWarRoom failed: ${err.message}` };
  }
}

module.exports = getWarRoom;
