'use strict';

/**
 * mark-email.js
 * Mark email(s) read/unread via Gmail API.
 * Uses service account impersonation.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

/**
 * @param {string} atlasUserId
 * @param {{
 *   message_id: string,
 *   action: string
 * }} params
 * @param {{ userEmail: string }} context
 * @returns {Promise<object>}
 */
async function markEmail(atlasUserId, {
  message_id,
  action,
} = {}, context = {}) {
  try {
    if (!message_id) return { error: 'message_id is required' };
    if (!action) return { error: 'action is required (read or unread)' };
    if (!['read', 'unread'].includes(action)) {
      return { error: `Invalid action "${action}". Use "read" or "unread".` };
    }

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    const auth = await getAuthClient(userEmail, SCOPES);
    const gmail = google.gmail({ version: 'v1', auth });

    // Support comma-separated IDs for batch
    const ids = message_id.split(',').map(id => id.trim()).filter(Boolean);
    const results = [];

    for (const id of ids) {
      try {
        const modifyBody = action === 'read'
          ? { removeLabelIds: ['UNREAD'] }
          : { addLabelIds: ['UNREAD'] };

        await gmail.users.messages.modify({
          userId: 'me',
          id,
          requestBody: modifyBody,
        });

        results.push({ id, success: true });
      } catch (modErr) {
        results.push({ id, success: false, error: modErr.message });
      }
    }

    const successCount = results.filter(r => r.success).length;

    return {
      action,
      processed: results.length,
      succeeded: successCount,
      failed: results.length - successCount,
      results,
    };
  } catch (err) {
    console.error('[mark-email] Error:', err.message);
    return { error: `markEmail failed: ${err.message}` };
  }
}

module.exports = markEmail;
