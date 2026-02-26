'use strict';

/**
 * delete-calendar-event.js
 * Delete a Google Calendar event by ID.
 * Uses service account impersonation.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/**
 * @param {string} atlasUserId
 * @param {{
 *   event_id: string,
 *   confirmed?: boolean
 * }} params
 * @param {{ userEmail: string }} context
 * @returns {Promise<object>}
 */
async function deleteCalendarEvent(atlasUserId, {
  event_id,
  confirmed = false,
} = {}, context = {}) {
  try {
    if (!event_id) return { error: 'event_id is required' };

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    const auth = await getAuthClient(userEmail, SCOPES);
    const calendar = google.calendar({ version: 'v3', auth });

    // Fetch event details first (for confirmation display)
    let event;
    try {
      const result = await calendar.events.get({
        calendarId: 'primary',
        eventId: event_id,
      });
      event = result.data;
    } catch (fetchErr) {
      return { error: `Event not found: ${fetchErr.message}` };
    }

    if (!confirmed) {
      return {
        type: 'calendar_event_delete',
        needs_confirmation: true,
        draft: {
          event_id,
          title: event.summary || '(no title)',
          start: event.start?.dateTime || event.start?.date,
          end: event.end?.dateTime || event.end?.date,
          attendees: (event.attendees || []).map(a => a.email),
        },
        message: 'Please confirm you want to delete this event. Say "delete it" or "yes" to confirm.',
      };
    }

    // ── Confirmed: delete the event ──────────────────────────────────────
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: event_id,
      sendUpdates: (event.attendees && event.attendees.length > 0) ? 'all' : 'none',
    });

    return {
      success: true,
      deleted_event_id: event_id,
      title: event.summary || '(no title)',
      message: 'Event deleted successfully.',
    };
  } catch (err) {
    console.error('[delete-calendar-event] Error:', err.message);
    return { error: `deleteCalendarEvent failed: ${err.message}` };
  }
}

module.exports = deleteCalendarEvent;
