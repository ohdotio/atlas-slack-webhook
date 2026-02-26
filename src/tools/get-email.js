'use strict';

/**
 * get-email.js
 * Get full email content by Gmail message ID.
 * Uses service account impersonation.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

/**
 * Extract plain text body from a Gmail message payload (recursive).
 */
function extractBody(payload) {
  if (!payload) return '';

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }

  if (payload.parts) {
    // Prefer text/plain
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf8');
    }

    // Fall back to text/html
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      let html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf8');
      html = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
      html = html.replace(/<br\s*\/?>/gi, '\n');
      html = html.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n');
      html = html.replace(/<[^>]*>/g, '');
      html = html.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      return html.replace(/\n{3,}/g, '\n\n').trim();
    }

    // Recurse into nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}

function getHeader(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/**
 * @param {string} atlasUserId
 * @param {{
 *   message_id: string,
 *   format?: string
 * }} params
 * @param {{ userEmail: string }} context
 * @returns {Promise<object>}
 */
async function getEmail(atlasUserId, {
  message_id,
  format = 'full',
} = {}, context = {}) {
  try {
    if (!message_id) return { error: 'message_id is required' };

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    const auth = await getAuthClient(userEmail, SCOPES);
    const gmail = google.gmail({ version: 'v1', auth });

    const result = await gmail.users.messages.get({
      userId: 'me',
      id: message_id,
      format: format === 'minimal' ? 'minimal' : 'full',
    });

    const msg = result.data;
    const headers = msg.payload?.headers || [];
    const body = extractBody(msg.payload);
    const labels = msg.labelIds || [];

    // Extract attachments
    const attachments = [];
    function findAttachments(parts) {
      for (const part of (parts || [])) {
        if (part.filename && part.body?.attachmentId) {
          attachments.push({
            filename: part.filename,
            mimeType: part.mimeType,
            size: part.body.size,
            attachmentId: part.body.attachmentId,
          });
        }
        if (part.parts) findAttachments(part.parts);
      }
    }
    findAttachments(msg.payload?.parts);

    return {
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader(headers, 'From'),
      to: getHeader(headers, 'To'),
      cc: getHeader(headers, 'Cc') || null,
      bcc: getHeader(headers, 'Bcc') || null,
      subject: getHeader(headers, 'Subject'),
      date: getHeader(headers, 'Date'),
      message_id_header: getHeader(headers, 'Message-ID'),
      in_reply_to: getHeader(headers, 'In-Reply-To') || null,
      references: getHeader(headers, 'References') || null,
      body,
      snippet: msg.snippet,
      labels,
      is_unread: labels.includes('UNREAD'),
      has_attachments: attachments.length > 0,
      attachments: attachments.length > 0 ? attachments : undefined,
      size_estimate: msg.sizeEstimate,
    };
  } catch (err) {
    console.error('[get-email] Error:', err.message);
    return { error: `getEmail failed: ${err.message}` };
  }
}

module.exports = getEmail;
