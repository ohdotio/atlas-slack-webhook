'use strict';

/**
 * Sendblue API client (lightweight — for Slack webhook iMessage sending).
 */

const API_BASE = 'https://api.sendblue.co/api';

function getHeaders() {
  return {
    'sb-api-key-id': process.env.SENDBLUE_API_KEY,
    'sb-api-secret-key': process.env.SENDBLUE_API_SECRET,
    'Content-Type': 'application/json',
  };
}

function getFromNumber() {
  return process.env.SENDBLUE_PHONE_NUMBER || '+12347361063';
}

/**
 * Send an iMessage/SMS to a phone number.
 * @param {string} to - E.164 phone number
 * @param {string} content - Message text
 * @param {object} [opts] - { media_url, send_style }
 */
async function sendMessage(to, content, opts = {}) {
  const body = {
    number: to,
    from_number: getFromNumber(),
    content: content || undefined,
    media_url: opts.media_url || undefined,
    send_style: opts.send_style || undefined,
  };

  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

  const resp = await fetch(`${API_BASE}/send-message`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error('[sendblue] send error:', data);
    return { success: false, error: data.error_message || data.message || `HTTP ${resp.status}` };
  }

  console.log(`[sendblue] Sent to ${to}: "${(content || '').substring(0, 50)}..." status=${data.status}`);
  return { success: true, ...data };
}

module.exports = { sendMessage, getFromNumber };
