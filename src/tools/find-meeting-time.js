'use strict';

/**
 * find-meeting-time.js
 * Find mutual free slots where all attendees are available.
 * Uses Google Calendar FreeBusy API via service account impersonation.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/**
 * @param {string} atlasUserId
 * @param {{
 *   emails: string,
 *   duration_minutes: number,
 *   date_start: string,
 *   date_end?: string,
 *   time_earliest?: string,
 *   time_latest?: string,
 *   timezone?: string
 * }} params
 * @param {{ userEmail: string }} context
 * @returns {Promise<object>}
 */
async function findMeetingTime(atlasUserId, {
  emails,
  duration_minutes,
  date_start,
  date_end,
  time_earliest = '09:00',
  time_latest = '17:00',
  timezone = 'America/New_York',
} = {}, context = {}) {
  try {
    if (!emails) return { error: 'emails is required (comma-separated)' };
    if (!duration_minutes) return { error: 'duration_minutes is required' };
    if (!date_start) return { error: 'date_start is required (YYYY-MM-DD)' };

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    const effectiveDateEnd = date_end || date_start;

    const auth = await getAuthClient(userEmail, SCOPES);
    const calendar = google.calendar({ version: 'v3', auth });

    const emailList = emails.split(',').map(e => e.trim()).filter(Boolean);
    // Always include the user's own calendar
    if (!emailList.includes(userEmail)) {
      emailList.push(userEmail);
    }

    const timeMin = new Date(`${date_start}T${time_earliest}:00`);
    const timeMax = new Date(`${effectiveDateEnd}T${time_latest}:00`);

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: timezone,
        items: emailList.map(email => ({ id: email })),
      },
    });

    const calendars = response.data.calendars || {};

    // Merge all busy blocks across all attendees
    const allBusy = [];
    const errors = [];
    for (const email of emailList) {
      const cal = calendars[email];
      if (!cal) {
        errors.push(`${email}: calendar not found`);
        continue;
      }
      if (cal.errors && cal.errors.length > 0) {
        errors.push(`${email}: ${cal.errors[0].reason}`);
        continue;
      }
      for (const block of (cal.busy || [])) {
        allBusy.push({
          start: new Date(block.start).getTime(),
          end: new Date(block.end).getTime(),
        });
      }
    }

    // Sort and merge overlapping busy blocks
    allBusy.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const block of allBusy) {
      if (merged.length > 0 && block.start <= merged[merged.length - 1].end) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, block.end);
      } else {
        merged.push({ ...block });
      }
    }

    // Find free slots across all days in range
    const durationMs = duration_minutes * 60_000;
    const slots = [];
    const currentDate = new Date(date_start);
    const endDate = new Date(effectiveDateEnd);

    while (currentDate <= endDate && slots.length < 10) {
      const dayStr = currentDate.toISOString().split('T')[0];
      const dayStart = new Date(`${dayStr}T${time_earliest}:00`).getTime();
      const dayEnd = new Date(`${dayStr}T${time_latest}:00`).getTime();

      // Get busy blocks that overlap with this day
      const dayBusy = merged.filter(b => b.start < dayEnd && b.end > dayStart);

      let cursor = dayStart;
      for (const block of dayBusy) {
        const gapStart = cursor;
        const gapEnd = Math.min(block.start, dayEnd);
        if (gapEnd - gapStart >= durationMs) {
          // Can fit one or more slots in this gap
          let slotStart = gapStart;
          while (slotStart + durationMs <= gapEnd && slots.length < 10) {
            slots.push({
              date: dayStr,
              start: new Date(slotStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
              end: new Date(slotStart + durationMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
              start_iso: new Date(slotStart).toISOString(),
              end_iso: new Date(slotStart + durationMs).toISOString(),
              duration_minutes,
            });
            slotStart += 30 * 60_000; // advance by 30-min increments
          }
        }
        cursor = Math.max(cursor, block.end);
      }

      // Check tail-end of day
      if (cursor + durationMs <= dayEnd && slots.length < 10) {
        let slotStart = cursor;
        while (slotStart + durationMs <= dayEnd && slots.length < 10) {
          slots.push({
            date: dayStr,
            start: new Date(slotStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
            end: new Date(slotStart + durationMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
            start_iso: new Date(slotStart).toISOString(),
            end_iso: new Date(slotStart + durationMs).toISOString(),
            duration_minutes,
          });
          slotStart += 30 * 60_000;
        }
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Deduplicate and take best 5
    const seen = new Set();
    const uniqueSlots = slots.filter(s => {
      const key = s.start_iso;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 5);

    return {
      attendees: emailList,
      date_range: `${date_start} to ${effectiveDateEnd}`,
      duration_minutes,
      work_window: `${time_earliest} – ${time_latest}`,
      timezone,
      found: uniqueSlots.length,
      slots: uniqueSlots,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (err) {
    console.error('[find-meeting-time] Error:', err.message);
    return { error: `findMeetingTime failed: ${err.message}` };
  }
}

module.exports = findMeetingTime;
