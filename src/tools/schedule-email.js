'use strict';

/**
 * schedule-email.js
 * Create a Gmail draft + store schedule metadata in Supabase.
 * Uses service account impersonation.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

/**
 * Build a raw RFC 2822 email message.
 */
function buildRawEmail({ to, from, subject, body, cc }) {
  const lines = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${subject}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('');
  lines.push(body);

  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

/**
 * @param {string} atlasUserId
 * @param {{
 *   to: string,
 *   subject: string,
 *   body: string,
 *   cc?: string,
 *   send_at: string,
 *   thread_id?: string,
 *   confirmed?: boolean
 * }} params
 * @param {{ userEmail: string, supabase: object }} context
 * @returns {Promise<object>}
 */
async function scheduleEmail(atlasUserId, {
  to,
  subject,
  body,
  cc,
  send_at,
  thread_id,
  confirmed = false,
} = {}, context = {}) {
  try {
    if (!to) return { error: 'to is required' };
    if (!subject) return { error: 'subject is required' };
    if (!body) return { error: 'body is required' };
    if (!send_at) return { error: 'send_at is required (ISO 8601 datetime)' };

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    const sendAtDate = new Date(send_at);
    if (isNaN(sendAtDate.getTime())) {
      return { error: `Invalid send_at date: ${send_at}` };
    }

    const fmtTime = sendAtDate.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York',
    });

    // If not confirmed, return draft for review
    if (!confirmed) {
      return {
        type: 'scheduled_email_draft',
        needs_confirmation: true,
        draft: {
          from: userEmail,
          to,
          cc: cc || null,
          subject,
          body,
          send_at: send_at,
          send_at_formatted: fmtTime,
          thread_id: thread_id || null,
        },
        message: `Please review this scheduled email. It will be sent ${fmtTime}. Say "schedule it" or "yes" to confirm.`,
      };
    }

    // ── Confirmed: create Gmail draft + store schedule ───────────────────
    const auth = await getAuthClient(userEmail, SCOPES);
    const gmail = google.gmail({ version: 'v1', auth });

    const raw = buildRawEmail({ to, from: userEmail, subject, body, cc });
    const requestBody = { message: { raw } };
    if (thread_id) requestBody.message.threadId = thread_id;

    const draftResult = await gmail.users.drafts.create({
      userId: 'me',
      requestBody,
    });

    const draftId = draftResult.data.id;

    // Store schedule metadata in Supabase
    const supabase = context.supabase;
    if (supabase) {
      const { error: schedErr } = await supabase
        .from('scheduled_emails')
        .insert({
          atlas_user_id: atlasUserId,
          draft_id: draftId,
          to_email: to,
          subject,
          send_at: sendAtDate.toISOString(),
          status: 'scheduled',
          created_at: new Date().toISOString(),
        });

      if (schedErr) {
        console.warn('[schedule-email] Failed to store schedule metadata:', schedErr.message);
        // Non-fatal — draft was still created
      }
    }

    return {
      success: true,
      draft_id: draftId,
      to,
      subject,
      send_at: send_at,
      send_at_formatted: fmtTime,
      message: `Email drafted and scheduled for ${fmtTime}. The draft is saved in Gmail.`,
      note: 'Scheduled sending requires the Atlas scheduler to be running.',
    };
  } catch (err) {
    console.error('[schedule-email] Error:', err.message);
    return { error: `scheduleEmail failed: ${err.message}` };
  }
}

module.exports = scheduleEmail;
