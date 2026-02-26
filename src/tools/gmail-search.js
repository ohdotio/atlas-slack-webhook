'use strict';

/**
 * gmail-search.js
 * Search Gmail directly via API (live, not Supabase cached data).
 * Uses service account impersonation.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('../utils/google-auth');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

/**
 * Extract plain text body from a Gmail message.
 */
function extractBody(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }

  // Multipart — prefer text/plain, fall back to text/html
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf8');
    }

    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      let html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf8');
      // Basic HTML to text
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

/**
 * Get header value from a Gmail message.
 */
function getHeader(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/**
 * @param {string} atlasUserId
 * @param {{
 *   query: string,
 *   limit?: number
 * }} params
 * @param {{ userEmail: string }} context
 * @returns {Promise<object>}
 */
async function gmailSearch(atlasUserId, {
  query,
  limit = 20,
} = {}, context = {}) {
  try {
    if (!query) return { error: 'query is required (Gmail search query)' };

    const userEmail = context.userEmail;
    if (!userEmail) return { error: 'User email not available for Google API impersonation.' };

    const auth = await getAuthClient(userEmail, SCOPES);
    const gmail = google.gmail({ version: 'v1', auth });

    const effectiveLimit = Math.min(limit, 100);

    // Search for messages
    const listResult = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: effectiveLimit,
    });

    const messageIds = (listResult.data.messages || []).map(m => m.id);

    if (messageIds.length === 0) {
      return { query, found: 0, emails: [] };
    }

    // Fetch full details for each message
    const emails = [];
    for (const msgId of messageIds) {
      try {
        const msgResult = await gmail.users.messages.get({
          userId: 'me',
          id: msgId,
          format: 'full',
        });

        const msg = msgResult.data;
        const headers = msg.payload?.headers || [];
        const body = extractBody(msg.payload);
        const labels = msg.labelIds || [];

        const attachments = [];
        if (msg.payload?.parts) {
          for (const part of msg.payload.parts) {
            if (part.filename && part.body?.attachmentId) {
              attachments.push({
                filename: part.filename,
                mimeType: part.mimeType,
                size: part.body.size,
                attachmentId: part.body.attachmentId,
              });
            }
          }
        }

        emails.push({
          id: msg.id,
          threadId: msg.threadId,
          from: getHeader(headers, 'From'),
          to: getHeader(headers, 'To'),
          cc: getHeader(headers, 'Cc') || null,
          subject: getHeader(headers, 'Subject'),
          date: getHeader(headers, 'Date'),
          snippet: msg.snippet,
          body: body.substring(0, 3000),
          labels,
          is_unread: labels.includes('UNREAD'),
          has_attachments: attachments.length > 0,
          attachments: attachments.length > 0 ? attachments : undefined,
        });
      } catch (msgErr) {
        console.warn(`[gmail-search] Failed to fetch message ${msgId}:`, msgErr.message);
      }
    }

    return {
      query,
      found: emails.length,
      total_results: listResult.data.resultSizeEstimate || emails.length,
      emails,
    };
  } catch (err) {
    console.error('[gmail-search] Error:', err.message);
    return { error: `gmailSearch failed: ${err.message}` };
  }
}

module.exports = gmailSearch;
