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

    // start_time is stored as epoch milliseconds — convert date strings
    const startMs = new Date(effectiveStart + 'T00:00:00').getTime();
    const endMs = new Date(effectiveEnd + 'T23:59:59').getTime();

    let q = supabase
      .from('calendar_events')
      .select('id, summary, start_time, end_time, location, attendees, description, organizer_name, meeting_url, response_status')
      .eq('atlas_user_id', atlasUserId)
      .gte('start_time', startMs)
      .lte('start_time', endMs)
      .order('start_time', { ascending: true });

    const { data, error } = await q;

    if (error) return { error: `DB error fetching calendar: ${error.message}` };

    let events = data || [];

    // Apply keyword filter on summary/attendees if query given
    if (query) {
      const lc = query.toLowerCase();
      events = events.filter(e => {
        const titleMatch = (e.summary || '').toLowerCase().includes(lc);
        const attendeesStr = Array.isArray(e.attendees)
          ? e.attendees.join(' ').toLowerCase()
          : String(e.attendees || '').toLowerCase();
        return titleMatch || attendeesStr.includes(lc);
      });
    }

    const fmtTime = (ms) => {
      if (!ms) return null;
      return new Date(ms).toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
        timeZone: 'America/New_York',
      });
    };

    const mapped = events.map(e => ({
      id: e.id,
      title: e.summary || '(no title)',
      start_time: fmtTime(e.start_time),
      end_time: fmtTime(e.end_time),
      start_epoch: e.start_time,
      location: e.location || null,
      attendees: e.attendees || [],
      organizer: e.organizer_name || null,
      meeting_url: e.meeting_url || null,
      response_status: e.response_status || null,
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
