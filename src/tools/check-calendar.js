'use strict';

/**
 * check-calendar.js
 * Query calendar events from Supabase for a date range.
 * Always scoped to atlasUserId.
 * Defaults to today + 7 days if no dates given.
 */

const supabase = require('../utils/supabase');

/**
 * @param {string} atlasUserId
 * @param {{
 *   start_date?: string,
 *   end_date?: string,
 *   query?: string
 * }} params
 * @returns {Promise<object>}
 */
async function checkCalendar(atlasUserId, {
  start_date,
  end_date,
  query,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };

    // Default to today + 7 days if no dates provided
    const now = new Date();
    const effectiveStart = start_date || now.toISOString().split('T')[0];
    const effectiveEnd = end_date || (() => {
      const d = new Date(now);
      d.setDate(d.getDate() + 7);
      return d.toISOString().split('T')[0];
    })();

    let q = supabase
      .from('calendar_events')
      .select('id, title, start_time, end_time, location, attendees, description')
      .eq('atlas_user_id', atlasUserId)
      .gte('start_time', effectiveStart)
      .lte('start_time', effectiveEnd + 'T23:59:59Z')
      .order('start_time', { ascending: true });

    const { data, error } = await q;

    if (error) return { error: `DB error fetching calendar: ${error.message}` };

    let events = data || [];

    // Apply keyword filter on title/attendees if query given
    if (query) {
      const lc = query.toLowerCase();
      events = events.filter(e => {
        const titleMatch = (e.title || '').toLowerCase().includes(lc);
        const attendeesStr = Array.isArray(e.attendees)
          ? e.attendees.join(' ').toLowerCase()
          : String(e.attendees || '').toLowerCase();
        return titleMatch || attendeesStr.includes(lc);
      });
    }

    const mapped = events.map(e => ({
      id: e.id,
      title: e.title || '(no title)',
      start_time: e.start_time,
      end_time: e.end_time,
      location: e.location || null,
      attendees: e.attendees || [],
      description: e.description ? e.description.substring(0, 300) : null,
    }));

    return {
      found: mapped.length,
      start_date: effectiveStart,
      end_date: effectiveEnd,
      query: query || null,
      events: mapped,
    };
  } catch (err) {
    return { error: `checkCalendar failed: ${err.message}` };
  }
}

module.exports = checkCalendar;
