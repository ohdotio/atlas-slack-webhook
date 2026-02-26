'use strict';

/**
 * manage-email-labels.js
 * Manage Gmail labels: list, apply, remove, archive, trash, untrash.
 * Uses service account impersonation.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

/**
 * @param {string} atlasUserId
 * @param {{
 *   action: string,
 *   message_id?: string,
 *   label_name?: string
 * }} params
 * @param {{ userEmail: string }} context
 * @returns {Promise<object>}
 */
async function manageEmailLabels(atlasUserId, {
  action,
  message_id,
  label_name,
} = {}, context = {}) {
  try {
    if (!action) return { error: 'action is required (list_labels, apply, remove, archive, trash, untrash)' };

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    const auth = await getAuthClient(userEmail, SCOPES);
    const gmail = google.gmail({ version: 'v1', auth });

    // ── LIST LABELS ──────────────────────────────────────────────────────
    if (action === 'list_labels') {
      const result = await gmail.users.labels.list({ userId: 'me' });
      const labels = (result.data.labels || []).map(l => ({
        id: l.id,
        name: l.name,
        type: l.type,
      }));
      return { found: labels.length, labels };
    }

    // All other actions require message_id
    if (!message_id) return { error: 'message_id is required for this action' };

    // ── ARCHIVE ──────────────────────────────────────────────────────────
    if (action === 'archive') {
      await gmail.users.messages.modify({
        userId: 'me',
        id: message_id,
        requestBody: { removeLabelIds: ['INBOX'] },
      });
      return { success: true, message_id, action: 'archived' };
    }

    // ── TRASH ────────────────────────────────────────────────────────────
    if (action === 'trash') {
      await gmail.users.messages.trash({ userId: 'me', id: message_id });
      return { success: true, message_id, action: 'trashed' };
    }

    // ── UNTRASH ──────────────────────────────────────────────────────────
    if (action === 'untrash') {
      await gmail.users.messages.untrash({ userId: 'me', id: message_id });
      return { success: true, message_id, action: 'untrashed' };
    }

    // ── APPLY / REMOVE label ─────────────────────────────────────────────
    if (action === 'apply' || action === 'remove') {
      if (!label_name) return { error: 'label_name is required for apply/remove actions' };

      // Resolve label name to ID
      const labelsResult = await gmail.users.labels.list({ userId: 'me' });
      const allLabels = labelsResult.data.labels || [];
      const matchedLabel = allLabels.find(l =>
        l.name.toLowerCase() === label_name.toLowerCase() ||
        l.id.toLowerCase() === label_name.toLowerCase()
      );

      if (!matchedLabel) {
        return {
          error: `Label "${label_name}" not found. Use action "list_labels" to see available labels.`,
        };
      }

      const modifyBody = action === 'apply'
        ? { addLabelIds: [matchedLabel.id] }
        : { removeLabelIds: [matchedLabel.id] };

      await gmail.users.messages.modify({
        userId: 'me',
        id: message_id,
        requestBody: modifyBody,
      });

      return {
        success: true,
        message_id,
        action: action === 'apply' ? 'label_applied' : 'label_removed',
        label: matchedLabel.name,
        label_id: matchedLabel.id,
      };
    }

    return { error: `Unknown action: ${action}. Use list_labels, apply, remove, archive, trash, or untrash.` };
  } catch (err) {
    console.error('[manage-email-labels] Error:', err.message);
    return { error: `manageEmailLabels failed: ${err.message}` };
  }
}

module.exports = manageEmailLabels;
