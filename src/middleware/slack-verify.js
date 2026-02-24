'use strict';

/**
 * Slack request signature verification middleware.
 *
 * Validates every inbound Slack request using HMAC-SHA256 so we can be sure
 * the payload really came from Slack and not a third party.
 *
 * Reference: https://api.slack.com/authentication/verifying-requests-from-slack
 */

const crypto = require('crypto');

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const MAX_AGE_SECONDS = 5 * 60; // 5 minutes — replay attack window

/**
 * Express middleware that verifies the Slack request signature.
 * Rejects requests with 401 if signature is missing, stale, or invalid.
 *
 * Requires `req.rawBody` to be populated (set via the `verify` option on
 * `express.json()` in index.js).
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function slackVerify(req, res, next) {
  if (!SLACK_SIGNING_SECRET) {
    console.error('[slack-verify] SLACK_SIGNING_SECRET is not set');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];

  // ── 1. Header presence check ──────────────────────────────────────────────
  if (!signature || !timestamp) {
    return res.status(401).json({ error: 'Missing Slack signature headers' });
  }

  // ── 2. Replay-attack protection ───────────────────────────────────────────
  const nowSeconds = Math.floor(Date.now() / 1000);
  const requestAge = Math.abs(nowSeconds - parseInt(timestamp, 10));

  if (requestAge > MAX_AGE_SECONDS) {
    return res.status(401).json({ error: 'Request timestamp too old' });
  }

  // ── 3. HMAC-SHA256 computation ────────────────────────────────────────────
  const rawBody = req.rawBody ?? Buffer.alloc(0);
  const sigBaseString = `v0:${timestamp}:${rawBody.toString('utf8')}`;

  const expectedSig =
    'v0=' +
    crypto
      .createHmac('sha256', SLACK_SIGNING_SECRET)
      .update(sigBaseString)
      .digest('hex');

  // ── 4. Constant-time comparison ───────────────────────────────────────────
  // Both buffers must be the same byte-length for timingSafeEqual.
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expBuf.length) {
    return res.status(401).json({ error: 'Invalid Slack signature' });
  }

  if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(401).json({ error: 'Invalid Slack signature' });
  }

  next();
}

module.exports = slackVerify;
