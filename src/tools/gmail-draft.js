'use strict';

/**
 * gmail-draft.js
 * Manage Gmail drafts: create, update, list, delete.
 * Uses service account impersonation.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

/**
 * Build a raw RFC 2822 email message.
 */
function buildRawEmail({ to, from, subject, body, cc, threadId, inReplyTo, references }) {
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
 *   action: string,
 *   to?: string,
 *   subject?: string,
 *   body?: string,
 *   cc?: string,
 *   draft_id?: string,
 *   thread_id?: string
 * }} params
 * @param {{ userEmail: string }} context
 * @returns {Promise<object>}
 */
async function gmailDraft(atlasUserId, {
  action,
  to,
  subject,
  body,
  cc,
  draft_id,
  thread_id,
} = {}, context = {}) {
  try {
    if (!action) return { error: 'action is required (create, update, list, delete)' };

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    const auth = await getAuthClient(userEmail, SCOPES);
    const gmail = google.gmail({ version: 'v1', auth });

    // ── LIST ──────────────────────────────────────────────────────────────
    if (action === 'list') {
      const result = await gmail.users.drafts.list({ userId: 'me', maxResults: 20 });
      const drafts = [];
      for (const d of (result.data.drafts || [])) {
        try {
          const detail = await gmail.users.drafts.get({ userId: 'me', id: d.id });
          const headers = detail.data.message?.payload?.headers || [];
          const getH = (name) => {
            const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
            return h ? h.value : '';
          };
          drafts.push({
            draft_id: d.id,
            message_id: detail.data.message?.id,
            to: getH('To'),
            subject: getH('Subject'),
            snippet: detail.data.message?.snippet,
          });
        } catch (_) {
          drafts.push({ draft_id: d.id });
        }
      }
      return { found: drafts.length, drafts };
    }

    // ── CREATE ────────────────────────────────────────────────────────────
    if (action === 'create') {
      if (!to) return { error: 'to is required for creating a draft' };
      if (!subject) return { error: 'subject is required for creating a draft' };
      if (!body) return { error: 'body is required for creating a draft' };

      const raw = buildRawEmail({ to, from: userEmail, subject, body, cc });
      const requestBody = { message: { raw } };
      if (thread_id) requestBody.message.threadId = thread_id;

      const result = await gmail.users.drafts.create({
        userId: 'me',
        requestBody,
      });

      return {
        success: true,
        draft_id: result.data.id,
        message_id: result.data.message?.id,
        to,
        subject,
      };
    }

    // ── UPDATE ────────────────────────────────────────────────────────────
    if (action === 'update') {
      if (!draft_id) return { error: 'draft_id is required for updating a draft' };

      const raw = buildRawEmail({ to: to || '', from: userEmail, subject: subject || '', body: body || '', cc });
      const requestBody = { message: { raw } };
      if (thread_id) requestBody.message.threadId = thread_id;

      const result = await gmail.users.drafts.update({
        userId: 'me',
        id: draft_id,
        requestBody,
      });

      return {
        success: true,
        draft_id: result.data.id,
        message_id: result.data.message?.id,
        updated: true,
      };
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (action === 'delete') {
      if (!draft_id) return { error: 'draft_id is required for deleting a draft' };

      await gmail.users.drafts.delete({ userId: 'me', id: draft_id });

      return {
        success: true,
        deleted_draft_id: draft_id,
      };
    }

    return { error: `Unknown action: ${action}. Use create, update, list, or delete.` };
  } catch (err) {
    console.error('[gmail-draft] Error:', err.message);
    return { error: `gmailDraft failed: ${err.message}` };
  }
}

module.exports = gmailDraft;
