'use strict';

/**
 * load-persona.js — Loads Argus persona from Supabase for any surface.
 *
 * Assembly: soul + household (if exists for user) + surface overlay
 *
 * All surfaces (Electron, Slack, Sendblue, Headless) call loadPersona()
 * with the user's ID and surface type. One source of truth in Supabase.
 *
 * Falls back to hardcoded defaults if Supabase is unreachable.
 */

const supabase = require('../utils/supabase');

const GLOBAL_USER = '__default__';

// Cache: surface → { soul, household, overlay, fetchedAt }
const personaCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Hardcoded fallback if Supabase is down
const FALLBACK_SOUL = `You are Argus — {name}'s private intelligence steward. You are discreet, clinical, quietly funny, and relentlessly useful. Dry wit delivered as understatement. Loyal to {name}. Loyal to truth. No sycophancy. No cheerleading. 1-3 sentences default. — Argus 🎩`;

/**
 * Load the full persona for a given user and surface.
 *
 * @param {object} opts
 * @param {string} opts.atlasUserId - The user's atlas_user_id (or null for non-Atlas users)
 * @param {string} opts.ownerUserId - The Atlas owner's user ID (for non-Atlas user conversations, e.g. Jeff's ID when Jenna texts)
 * @param {string} opts.surface - 'slack' | 'sms' | 'app' | 'telegram'
 * @param {string} opts.userName - First name to replace {name} placeholders
 * @param {string} [opts.fullName] - Full name to replace {fullName} placeholders
 * @returns {Promise<string>} Assembled persona prompt
 */
async function loadPersona({ atlasUserId, ownerUserId, surface, userName, fullName }) {
  // Determine which user's settings to load
  // For non-Atlas users (Jenna texting Argus), use the owner's (Jeff's) household
  const effectiveUserId = atlasUserId || ownerUserId;

  // Check cache
  const cacheKey = `${effectiveUserId}:${surface}`;
  const cached = personaCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return applyPlaceholders(cached.assembled, userName, fullName);
  }

  try {
    // Fetch all relevant persona rows in one query
    // We need: soul (global or user-specific), household (user-specific), overlay (global or user-specific)
    const overlayKey = `argus_overlay_${surface}`;

    const { data: rows, error } = await supabase
      .from('ai_settings')
      .select('key, value, atlas_user_id')
      .in('key', ['argus_soul', 'argus_household', overlayKey])
      .or(`atlas_user_id.eq.${GLOBAL_USER}${effectiveUserId ? `,atlas_user_id.eq.${effectiveUserId}` : ''}`);

    if (error || !rows || rows.length === 0) {
      console.warn('[Persona] Supabase fetch failed, using fallback:', error?.message);
      return applyPlaceholders(FALLBACK_SOUL, userName, fullName);
    }

    // Resolve each component: user-specific overrides global
    const resolve = (key) => {
      const userRow = rows.find(r => r.key === key && r.atlas_user_id === effectiveUserId);
      const globalRow = rows.find(r => r.key === key && r.atlas_user_id === GLOBAL_USER);
      return userRow?.value || globalRow?.value || '';
    };

    const soul = resolve('argus_soul');
    const household = resolve('argus_household');
    const overlay = resolve(overlayKey);

    // Assemble
    let assembled = soul || FALLBACK_SOUL;
    if (household) assembled += '\n\n' + household;
    if (overlay) assembled += '\n\n' + overlay;

    // Cache it
    personaCache.set(cacheKey, { assembled, fetchedAt: Date.now() });

    return applyPlaceholders(assembled, userName, fullName);
  } catch (err) {
    console.error('[Persona] Error loading persona:', err.message);
    return applyPlaceholders(FALLBACK_SOUL, userName, fullName);
  }
}

/**
 * Replace {name} and {fullName} placeholders.
 */
function applyPlaceholders(text, userName, fullName) {
  let result = text;
  if (userName) result = result.replace(/\{name\}/g, userName);
  if (fullName) result = result.replace(/\{fullName\}/g, fullName);
  // If fullName wasn't provided, fall back to userName
  if (!fullName && userName) result = result.replace(/\{fullName\}/g, userName);
  return result;
}

/**
 * Clear the cache (e.g. after an admin edits the persona).
 */
function clearPersonaCache() {
  personaCache.clear();
}

module.exports = { loadPersona, clearPersonaCache };
