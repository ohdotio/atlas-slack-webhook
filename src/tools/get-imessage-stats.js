'use strict';

/**
 * get-imessage-stats.js
 * Query imessage_messages for stats (count by person, recent activity).
 * Always scoped to atlasUserId.
 */

const supabase = require('../utils/supabase');

/**
 * @param {string} atlasUserId
 * @param {{
 *   date_start?: string,
 *   date_end?: string,
 *   group_by?: string,
 *   direction?: string
 * }} params
 * @returns {Promise<object>}
 */
async function getImessageStats(atlasUserId, {
  date_start,
  date_end,
  group_by = 'day',
  direction = 'all',
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };

    // Default to last 14 days
    const now = new Date();
    const effectiveEnd = date_end || now.toISOString().split('T')[0];
    const effectiveStart = date_start || (() => {
      const d = new Date(now);
      d.setDate(d.getDate() - 14);
      return d.toISOString().split('T')[0];
    })();

    let q = supabase
      .from('imessage_messages')
      .select('id, sender_name, is_from_me, date, handle_id')
      .eq('atlas_user_id', atlasUserId)
      .gte('date', effectiveStart)
      .lte('date', effectiveEnd + 'T23:59:59')
      .order('date', { ascending: false });

    if (direction === 'inbound') {
      q = q.eq('is_from_me', false);
    } else if (direction === 'outbound') {
      q = q.eq('is_from_me', true);
    }

    const { data, error } = await q.limit(5000);

    if (error) return { error: `DB error fetching iMessage stats: ${error.message}` };

    const messages = data || [];

    // ── Compute stats ─────────────────────────────────────────────────────
    const totalCount = messages.length;
    const inbound = messages.filter(m => !m.is_from_me).length;
    const outbound = messages.filter(m => m.is_from_me).length;

    // Group by person
    const byPerson = {};
    for (const m of messages) {
      const name = m.sender_name || m.handle_id || 'Unknown';
      if (!byPerson[name]) byPerson[name] = { inbound: 0, outbound: 0, total: 0 };
      if (m.is_from_me) {
        byPerson[name].outbound++;
      } else {
        byPerson[name].inbound++;
      }
      byPerson[name].total++;
    }

    // Group by time period
    const byPeriod = {};
    for (const m of messages) {
      if (!m.date) continue;
      let key;
      const d = m.date.substring(0, 10); // YYYY-MM-DD
      if (group_by === 'week') {
        const dt = new Date(d);
        const dayOfWeek = dt.getDay();
        const weekStart = new Date(dt);
        weekStart.setDate(dt.getDate() - dayOfWeek);
        key = weekStart.toISOString().split('T')[0];
      } else if (group_by === 'month') {
        key = d.substring(0, 7); // YYYY-MM
      } else if (group_by === 'person') {
        key = m.sender_name || m.handle_id || 'Unknown';
      } else {
        key = d; // day
      }
      if (!byPeriod[key]) byPeriod[key] = 0;
      byPeriod[key]++;
    }

    // Top contacts sorted by volume
    const topContacts = Object.entries(byPerson)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 20)
      .map(([name, stats]) => ({ name, ...stats }));

    return {
      date_range: { start: effectiveStart, end: effectiveEnd },
      direction_filter: direction,
      group_by,
      total_messages: totalCount,
      inbound,
      outbound,
      top_contacts: topContacts,
      by_period: byPeriod,
    };
  } catch (err) {
    return { error: `getImessageStats failed: ${err.message}` };
  }
}

module.exports = getImessageStats;
