'use strict';

/**
 * check-calendar.js
 * Query calendar events via live Google Calendar API.
 * Uses service account with domain-wide delegation to impersonate the user.
 * Falls back to Supabase if Google API fails.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');
const supabase = require('../utils/supabase');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/**
 * @param {string} atlasUserId
 * @param {object} params
 * @param {{ userEmail: string }} context
 */
async function checkCalendar(atlasUserId, params = {}, context = {}) {
  const {
    start_date, date_start,
    end_date, date_end,
    query,
  } = params;

  // Normalize parameter names (tool schema uses date_start/date_end)
  const effectiveStart = start_date || date_start || new Date().toISOString().split('T')[0];
  const effectiveEnd = end_date || date_end || (() => {
    const d = new Date(effectiveStart);
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  })();

  const userEmail = context.userEmail;

  // Try live Google Calendar API first
  if (userEmail) {
    try {
      return await fetchFromGoogleCalendar(userEmail, effectiveStart, effectiveEnd, query);
    } catch (err) {
      console.warn(`[check-calendar] Google Calendar API failed, falling back to Supabase: ${err.message}`);
    }
  }

  // Fallback: Supabase
  return await fetchFromSupabase(atlasUserId, effectiveStart, effectiveEnd, query);
}

async function fetchFromGoogleCalendar(userEmail, startDate, endDate, query) {
  const auth = await getAuthClient(userEmail, SCOPES);
  const calendar = google.calendar({ version: 'v3', auth });

  const timeMin = new Date(startDate + 'T00:00:00').toISOString();
  const timeMax = new Date(endDate + 'T23:59:59').toISOString();

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });

  let events = res.data.items || [];

  // Apply keyword filter if query given
  if (query) {
    const lc = query.toLowerCase();
    events = events.filter(e => {
      const titleMatch = (e.summary || '').toLowerCase().includes(lc);
      const attendeeMatch = (e.attendees || []).some(a =>
        (a.displayName || a.email || '').toLowerCase().includes(lc)
      );
      return titleMatch || attendeeMatch;
    });
  }

  const fmtTime = (dt) => {
    if (!dt) return null;
    const ts = dt.dateTime || dt.date;
    if (!ts) return null;
    return new Date(ts).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York',
    });
  };

  const mapped = events.map(e => ({
    id: e.id,
    title: e.summary || '(no title)',
    start_time: fmtTime(e.start),
    end_time: fmtTime(e.end),
    start_epoch: e.start?.dateTime ? new Date(e.start.dateTime).getTime() : null,
    location: e.location || null,
    attendees: (e.attendees || []).map(a => a.displayName || a.email).filter(Boolean),
    organizer: e.organizer?.displayName || e.organizer?.email || null,
    meeting_url: e.hangoutLink || e.conferenceData?.entryPoints?.[0]?.uri || null,
    response_status: (e.attendees || []).find(a => a.self)?.responseStatus || null,
    description: e.description ? e.description.substring(0, 300) : null,
  }));

  return {
    found: mapped.length,
    start_date: startDate,
    end_date: endDate,
    query: query || null,
    source: 'google_calendar_api',
    events: mapped,
  };
}

async function fetchFromSupabase(atlasUserId, startDate, endDate, query) {
  try {
    const startMs = new Date(startDate + 'T00:00:00').getTime();
    const endMs = new Date(endDate + 'T23:59:59').getTime();

    const { data, error } = await supabase
      .from('calendar_events')
      .select('id, summary, start_time, end_time, location, attendees, description, organizer_name, meeting_url, response_status')
      .eq('atlas_user_id', atlasUserId)
      .gte('start_time', startMs)
      .lte('start_time', endMs)
      .order('start_time', { ascending: true });

    if (error) return { error: `DB error: ${error.message}` };

    let events = data || [];

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
      start_date: startDate,
      end_date: endDate,
      query: query || null,
      source: 'supabase_cache',
      events: mapped,
    };
  } catch (err) {
    return { error: `checkCalendar fallback failed: ${err.message}` };
  }
}

module.exports = checkCalendar;
