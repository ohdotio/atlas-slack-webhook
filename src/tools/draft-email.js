'use strict';

/**
 * draft-email.js
 * Draft an email for user review (returns draft for confirmation, doesn't auto-send).
 * On confirmation, creates a Gmail draft or sends directly.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.modify'];

/**
 * Build a raw RFC 2822 email message.
 */
function buildRawEmail({ to, from, subject, body, cc, inReplyTo, references }) {
  const lines = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${subject}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
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
 *   threadId?: string,
 *   inReplyTo?: string,
 *   confirmed?: boolean
 * }} params
 * @param {{ userEmail: string }} context
 * @returns {Promise<object>}
 */
async function draftEmail(atlasUserId, {
  to,
  subject,
  body,
  cc,
  threadId,
  inReplyTo,
  confirmed = false,
} = {}, context = {}) {
  try {
    if (!to) return { error: 'to is required (email address)' };
    if (!subject) return { error: 'subject is required' };
    if (!body) return { error: 'body is required' };

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    // If not confirmed, return draft for review
    if (!confirmed) {
      return {
        type: 'email_draft',
        needs_confirmation: true,
        draft: {
          from: userEmail,
          to,
          cc: cc || null,
          subject,
          body,
          threadId: threadId || null,
          inReplyTo: inReplyTo || null,
        },
        message: 'Please review this email draft. Say "send it" or "yes" to confirm.',
      };
    }

    // ── Confirmed: send the email via Gmail API ──────────────────────────
    const auth = await getAuthClient(userEmail, SCOPES);
    const gmail = google.gmail({ version: 'v1', auth });

    const raw = buildRawEmail({ to, from: userEmail, subject, body, cc, inReplyTo });
    const requestBody = { raw };
    if (threadId) requestBody.threadId = threadId;

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody,
    });

    return {
      success: true,
      message_id: result.data.id,
      thread_id: result.data.threadId,
      to,
      subject,
      message: 'Email sent successfully.',
    };
  } catch (err) {
    console.error('[draft-email] Error:', err.message);
    return { error: `draftEmail failed: ${err.message}` };
  }
}

module.exports = draftEmail;
