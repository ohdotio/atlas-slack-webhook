'use strict';

/**
 * Atlas Slack Webhook Service — Express entry point
 */

require('dotenv').config();
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

/** Debug: check if a user's identity + API key resolves */
app.get('/debug/identity/:email', async (req, res) => {
  try {
    const supabase = require('./utils/supabase');
    const email = req.params.email;

    // Find user by email
    const { data: user, error: userErr } = await supabase
      .from('user')
      .select('id, name, email')
      .eq('email', email)
      .maybeSingle();

    if (userErr) return res.json({ error: 'user lookup failed', detail: userErr.message });
    if (!user) return res.json({ error: 'no user found for email', email });

    // Check API key
    const { data: settings } = await supabase
      .from('ai_settings')
      .select('key, value')
      .eq('atlas_user_id', user.id);

    const keys = (settings || []).map(s => ({ key: s.key, hasValue: !!s.value, valueLen: s.value?.length || 0 }));

    res.json({ user: { id: user.id, name: user.name, email: user.email }, settings: keys });
  } catch (err) {
    res.json({ error: err.message });
  }
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
