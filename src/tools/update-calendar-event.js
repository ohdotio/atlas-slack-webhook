'use strict';

/**
 * update-calendar-event.js
 * Update an existing Google Calendar event by ID.
 * Uses service account impersonation.
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
 *   event_id: string,
 *   title?: string,
 *   start_time?: string,
 *   duration_minutes?: number,
 *   description?: string,
 *   location?: string,
 *   attendees?: string,
 *   color?: string,
 *   confirmed?: boolean
 * }} params
 * @param {{ userEmail: string }} context
 * @returns {Promise<object>}
 */
async function updateCalendarEvent(atlasUserId, {
  event_id,
  title,
  start_time,
  duration_minutes,
  description,
  location,
  attendees,
  color,
  confirmed = false,
} = {}, context = {}) {
  try {
    if (!event_id) return { error: 'event_id is required' };

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    const auth = await getAuthClient(userEmail, SCOPES);
    const calendar = google.calendar({ version: 'v3', auth });

    // Fetch current event
    const existing = await calendar.events.get({
      calendarId: 'primary',
      eventId: event_id,
    });

    const event = existing.data;
    const changes = {};

    if (title !== undefined) changes.summary = title;
    if (description !== undefined) changes.description = description;
    if (location !== undefined) changes.location = location;
    if (color !== undefined) {
      changes.colorId = COLOR_MAP[color.toLowerCase()] || color;
    }
    if (attendees !== undefined) {
      const attendeeList = attendees.split(',').map(e => e.trim()).filter(Boolean);
      changes.attendees = attendeeList.map(email => ({ email }));
    }
    if (start_time !== undefined) {
      const startDate = new Date(start_time);
      const dur = duration_minutes || (() => {
        const existingStart = new Date(event.start.dateTime || event.start.date);
        const existingEnd = new Date(event.end.dateTime || event.end.date);
        return Math.round((existingEnd - existingStart) / 60_000);
      })();
      const endDate = new Date(startDate.getTime() + dur * 60_000);
      changes.start = { dateTime: startDate.toISOString(), timeZone: 'America/New_York' };
      changes.end = { dateTime: endDate.toISOString(), timeZone: 'America/New_York' };
    } else if (duration_minutes !== undefined && event.start?.dateTime) {
      const existingStart = new Date(event.start.dateTime);
      const endDate = new Date(existingStart.getTime() + duration_minutes * 60_000);
      changes.end = { dateTime: endDate.toISOString(), timeZone: 'America/New_York' };
    }

    if (Object.keys(changes).length === 0) {
      return { error: 'No changes specified. Provide title, start_time, duration_minutes, description, location, attendees, or color.' };
    }

    // Execute directly — Claude handles confirmation in conversation before calling this tool
    const updatedBody = { ...event, ...changes };
    // Remove read-only fields
    delete updatedBody.id;
    delete updatedBody.etag;
    delete updatedBody.htmlLink;
    delete updatedBody.created;
    delete updatedBody.updated;
    delete updatedBody.creator;
    delete updatedBody.organizer;
    delete updatedBody.iCalUID;
    delete updatedBody.sequence;
    delete updatedBody.kind;

    const result = await calendar.events.update({
      calendarId: 'primary',
      eventId: event_id,
      requestBody: updatedBody,
      sendUpdates: changes.attendees ? 'all' : 'none',
    });

    return {
      success: true,
      event_id: result.data.id,
      html_link: result.data.htmlLink,
      title: result.data.summary,
      updated_fields: Object.keys(changes),
    };
  } catch (err) {
    console.error('[update-calendar-event] Error:', err.message);
    return { error: `updateCalendarEvent failed: ${err.message}` };
  }
}

module.exports = updateCalendarEvent;
