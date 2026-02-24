'use strict';

/**
 * In-memory event deduplication store.
 *
 * Slack may deliver the same event more than once (at-least-once delivery).
 * We use a Map keyed by event_id with a TTL of 10 minutes to detect and
 * discard duplicates without unbounded memory growth.
 */

const TTL_MS = 10 * 60 * 1000;       // 10 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * @typedef {{ seenAt: number }} DedupEntry
 */

/** @type {Map<string, DedupEntry>} */
const seen = new Map();

/**
 * Check whether an event has already been processed.
 *
 * Side-effect: if the event is *not* a duplicate it is recorded so that
 * subsequent calls for the same id return `true`.
 *
 * @param {string} eventId - Slack event_id (e.g. "Ev0000000000")
 * @returns {boolean} `true` if the event was already seen; `false` otherwise.
 */
function isDuplicate(eventId) {
  if (!eventId) return false;

  const now = Date.now();
  const entry = seen.get(eventId);

  if (entry) {
    // Still within TTL window → genuine duplicate
    if (now - entry.seenAt < TTL_MS) {
      return true;
    }
    // Expired entry — treat as new (shouldn't normally happen if cleanup runs)
    seen.delete(eventId);
  }

  seen.set(eventId, { seenAt: now });
  return false;
}

/**
 * Remove entries that have exceeded the TTL.
 * Called automatically on a timer; exported for testing.
 */
function cleanup() {
  const now = Date.now();
  for (const [id, entry] of seen) {
    if (now - entry.seenAt >= TTL_MS) {
      seen.delete(id);
    }
  }
}

// Periodic cleanup — avoids growing the Map indefinitely.
const _cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);

// Allow Node.js to exit cleanly even if the interval is still scheduled.
if (_cleanupTimer.unref) {
  _cleanupTimer.unref();
}

module.exports = { isDuplicate, cleanup };
