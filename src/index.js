'use strict';

/**
 * Atlas Slack Webhook Service — Express entry point
 */

const express = require('express');
const eventsHandler = require('./handlers/events');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Raw body capture for Slack signature verification
// We attach rawBody to req so the verify middleware can use it later.
// ---------------------------------------------------------------------------
app.use(
  express.json({
    verify(req, _res, buf) {
      req.rawBody = buf;
    },
  })
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Health check — no auth required */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/** Slack Events API */
app.post('/slack/events', eventsHandler);

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[Atlas] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[Atlas] Slack webhook service listening on port ${PORT}`);
});

module.exports = app; // exported for testing
