'use strict';

/**
 * check-availability.js
 * Check free/busy availability for one or more people via Google Calendar FreeBusy API.
 * Uses service account impersonation.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/**
 * @param {string} atlasUserId
 * @param {{
 *   emails: string,
 *   date: string,
 *   time_start?: string,
 *   time_end?: string,
 *   timezone?: string
 * }} params
 * @param {{ userEmail: string }} context
 * @returns {Promise<object>}
 */
async function checkAvailability(atlasUserId, {
  emails,
  date,
  time_start = '09:00',
  time_end = '17:00',
  timezone = 'America/New_York',
} = {}, context = {}) {
  try {
    if (!emails) return { error: 'emails is required (comma-separated)' };
    if (!date) return { error: 'date is required (YYYY-MM-DD)' };

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    const auth = await getAuthClient(userEmail, SCOPES);
    const calendar = google.calendar({ version: 'v3', auth });

    const emailList = emails.split(',').map(e => e.trim()).filter(Boolean);

    const timeMin = `${date}T${time_start}:00`;
    const timeMax = `${date}T${time_end}:00`;

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(`${timeMin}`).toISOString(),
        timeMax: new Date(`${timeMax}`).toISOString(),
        timeZone: timezone,
        items: emailList.map(email => ({ id: email })),
      },
    });

    const calendars = response.data.calendars || {};
    const results = {};

    const windowStart = new Date(`${timeMin}`);
    const windowEnd = new Date(`${timeMax}`);

    for (const email of emailList) {
      const cal = calendars[email];
      if (!cal) {
        results[email] = { error: 'Calendar not found or no access' };
        continue;
      }
      if (cal.errors && cal.errors.length > 0) {
        results[email] = { error: cal.errors[0].reason || 'Unknown error' };
        continue;
      }

      const busyBlocks = (cal.busy || []).map(b => ({
        start: new Date(b.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
        end: new Date(b.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
        start_iso: b.start,
        end_iso: b.end,
      }));

      // Calculate free windows
      const freeWindows = [];
      let cursor = windowStart.getTime();
      const busySorted = (cal.busy || [])
        .map(b => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
        .sort((a, b) => a.start - b.start);

      for (const block of busySorted) {
        if (block.start > cursor) {
          freeWindows.push({
            start: new Date(cursor).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
            end: new Date(block.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
            duration_minutes: Math.round((block.start - cursor) / 60_000),
          });
        }
        cursor = Math.max(cursor, block.end);
      }
      if (cursor < windowEnd.getTime()) {
        freeWindows.push({
          start: new Date(cursor).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
          end: new Date(windowEnd).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
          duration_minutes: Math.round((windowEnd.getTime() - cursor) / 60_000),
        });
      }

      results[email] = {
        busy_blocks: busyBlocks,
        free_windows: freeWindows,
        total_busy_minutes: busySorted.reduce((sum, b) => sum + Math.round((b.end - b.start) / 60_000), 0),
      };
    }

    return {
      date,
      window: `${time_start} – ${time_end}`,
      timezone,
      availability: results,
    };
  } catch (err) {
    console.error('[check-availability] Error:', err.message);
    return { error: `checkAvailability failed: ${err.message}` };
  }
}

module.exports = checkAvailability;
