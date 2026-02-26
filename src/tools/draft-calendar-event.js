'use strict';

/**
 * draft-calendar-event.js
 * Draft a calendar event for user review (returns draft, doesn't auto-create).
 * On confirmation, creates via Google Calendar API using service account.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const COLOR_MAP = {
  lavender: '1', sage: '2', grape: '3', flamingo: '4',
  banana: '5', tangerine: '6', peacock: '7', graphite: '8',
  blueberry: '9', basil: '10', tomato: '11',
};

/**
 * @param {string} atlasUserId
 * @param {{
 *   title: string,
 *   start_time: string,
 *   duration_minutes: number,
 *   attendees?: string,
 *   location?: string,
 *   description?: string,
 *   color?: string,
 *   calendarId?: string,
 *   confirmed?: boolean
 * }} params
 * @param {{ userEmail: string }} context
 * @returns {Promise<object>}
 */
async function draftCalendarEvent(atlasUserId, {
  title,
  start_time,
  duration_minutes,
  attendees,
  location,
  description,
  color,
  calendarId = 'primary',
  confirmed = false,
} = {}, context = {}) {
  try {
    if (!title) return { error: 'title is required' };
    if (!start_time) return { error: 'start_time is required (ISO 8601)' };
    if (!duration_minutes) return { error: 'duration_minutes is required' };

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    const startDate = new Date(start_time);
    const endDate = new Date(startDate.getTime() + duration_minutes * 60_000);

    const attendeeList = attendees
      ? attendees.split(',').map(e => e.trim()).filter(Boolean)
      : [];

    const colorId = color ? (COLOR_MAP[color.toLowerCase()] || color) : undefined;

    // Build the event object for preview
    const eventDraft = {
      title,
      start: startDate.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
        timeZone: 'America/New_York',
      }),
      end: endDate.toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit',
        timeZone: 'America/New_York',
      }),
      start_iso: startDate.toISOString(),
      end_iso: endDate.toISOString(),
      duration_minutes,
      attendees: attendeeList,
      location: location || null,
      description: description || null,
      color: color || null,
      calendar: calendarId,
    };

    // If not confirmed, return draft for review
    if (!confirmed) {
      return {
        type: 'calendar_event_draft',
        needs_confirmation: true,
        draft: eventDraft,
        message: 'Please review this event draft. Say "create it" or "yes" to confirm.',
      };
    }

    // ── Confirmed: create the event via Google Calendar API ──────────────
    const auth = await getAuthClient(userEmail, SCOPES);
    const calendar = google.calendar({ version: 'v3', auth });

    const eventBody = {
      summary: title,
      start: { dateTime: startDate.toISOString(), timeZone: 'America/New_York' },
      end: { dateTime: endDate.toISOString(), timeZone: 'America/New_York' },
    };

    if (attendeeList.length > 0) {
      eventBody.attendees = attendeeList.map(email => ({ email }));
    }
    if (location) eventBody.location = location;
    if (description) eventBody.description = description;
    if (colorId) eventBody.colorId = colorId;

    const result = await calendar.events.insert({
      calendarId,
      requestBody: eventBody,
      sendUpdates: attendeeList.length > 0 ? 'all' : 'none',
    });

    return {
      success: true,
      event_id: result.data.id,
      html_link: result.data.htmlLink,
      title,
      start: eventDraft.start,
      end: eventDraft.end,
      attendees: attendeeList,
    };
  } catch (err) {
    console.error('[draft-calendar-event] Error:', err.message);
    return { error: `draftCalendarEvent failed: ${err.message}` };
  }
}

module.exports = draftCalendarEvent;
