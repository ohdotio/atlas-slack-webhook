'use strict';

/**
 * Session Memory — Supabase-backed short-term context for Cloud Argus vNext.
 *
 * Keyed by (atlasUserId, conversationKey) with a 4-hour TTL.
 * Stores lightweight working memory: lastPerson, lastPersonId, lastDateRange,
 * lastTopic, lastIntent, lastToolCalls, openLoops.
 *
 * NEVER stores pending action IDs, send_params, or approval state.
 * Pending-actions.js remains the single source of truth for approvals.
 */

const defaultSupabase = require('../utils/supabase');

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const EMPTY_MEMORY = {
  lastPerson: null,
  lastPersonId: null,
  lastDateRange: null,
  lastTopic: null,
  lastIntent: null,
  lastToolCalls: [],
  openLoops: [],
};

/**
 * Load session memory. Returns null if no session or expired.
 */
async function getSessionMemory(atlasUserId, conversationKey, supabase = defaultSupabase) {
  try {
    const { data, error } = await supabase
      .from('argus_session_memory')
      .select('memory, updated_at')
      .eq('atlas_user_id', atlasUserId)
      .eq('conversation_key', conversationKey)
      .single();

    // Table might not exist yet — graceful degradation
    if (error) {
      if (error.code === '42P01' || error.message?.includes('schema cache')) {
        // Table doesn't exist — silent degradation
        return null;
      }
      if (error.code === 'PGRST116') return null; // no rows
      return null;
    }
    if (!data) return null;

    // TTL check
    const updatedAt = new Date(data.updated_at).getTime();
    if (Date.now() - updatedAt > SESSION_TTL_MS) {
      // Stale — delete and return null
      supabase
        .from('argus_session_memory')
        .delete()
        .eq('atlas_user_id', atlasUserId)
        .eq('conversation_key', conversationKey)
        .then(() => console.log(`[session-memory] Cleaned stale session: ${conversationKey}`))
        .catch(e => console.warn(`[session-memory] Stale cleanup failed:`, e.message));
      return null;
    }

    return data.memory || null;
  } catch (err) {
    console.warn(`[session-memory] getSessionMemory failed:`, err.message);
    return null;
  }
}

/**
 * Update session memory (merge with existing).
 * Only call at end_turn and major state transitions.
 */
async function updateSessionMemory(atlasUserId, conversationKey, updates, supabase = defaultSupabase) {
  try {
    // Read existing
    const existing = await getSessionMemory(atlasUserId, conversationKey, supabase) || { ...EMPTY_MEMORY };
    const merged = { ...existing, ...updates };

    // Cap arrays
    if (merged.lastToolCalls && merged.lastToolCalls.length > 5) {
      merged.lastToolCalls = merged.lastToolCalls.slice(-5);
    }
    if (merged.openLoops && merged.openLoops.length > 3) {
      merged.openLoops = merged.openLoops.slice(-3);
    }

    // Upsert
    const { error } = await supabase
      .from('argus_session_memory')
      .upsert({
        atlas_user_id: atlasUserId,
        conversation_key: conversationKey,
        memory: merged,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'atlas_user_id,conversation_key' });

    if (error) {
      // Table might not exist yet — don't spam logs
      if (error.code !== '42P01' && !error.message?.includes('schema cache')) {
        console.warn(`[session-memory] upsert failed:`, error.message);
      }
    }

    return merged;
  } catch (err) {
    console.warn(`[session-memory] updateSessionMemory failed:`, err.message);
    return null;
  }
}

/**
 * Delete stale sessions. Call from health check endpoint.
 */
async function cleanupStaleSessions(supabase = defaultSupabase) {
  try {
    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('argus_session_memory')
      .delete()
      .lt('updated_at', cutoff)
      .select('conversation_key');

    if (error) {
      console.warn(`[session-memory] cleanup failed:`, error.message);
    } else if (data?.length > 0) {
      console.log(`[session-memory] Cleaned ${data.length} stale sessions`);
    }
  } catch (err) {
    console.warn(`[session-memory] cleanup error:`, err.message);
  }
}

/**
 * Build the SESSION CONTEXT block for injection into the system prompt.
 * Capped at ~30 lines.
 */
function buildSessionContextBlock(sessionMem) {
  if (!sessionMem) return '';
  const lines = ['## SESSION CONTEXT (from prior turns in this conversation)'];
  if (sessionMem.lastPerson) {
    lines.push(`Last person discussed: ${sessionMem.lastPerson}${sessionMem.lastPersonId ? ` (id: ${sessionMem.lastPersonId})` : ''}`);
  }
  if (sessionMem.lastDateRange) lines.push(`Last date range: ${sessionMem.lastDateRange}`);
  if (sessionMem.lastTopic) lines.push(`Last topic: ${sessionMem.lastTopic}`);
  if (sessionMem.lastIntent) lines.push(`Last intent: ${sessionMem.lastIntent}`);
  if (sessionMem.lastToolCalls?.length > 0) {
    lines.push(`Recent tools used: ${sessionMem.lastToolCalls.join(', ')}`);
  }
  if (sessionMem.openLoops?.length > 0) {
    lines.push(`Open loops:`);
    for (const loop of sessionMem.openLoops) {
      lines.push(`  - ${loop}`);
    }
  }
  lines.push('Use this context to resolve pronouns ("he", "she", "them", "that person") and avoid redundant searches.');
  return lines.join('\n');
}

module.exports = {
  getSessionMemory,
  updateSessionMemory,
  cleanupStaleSessions,
  buildSessionContextBlock,
};
