'use strict';

/**
 * store-learning.js
 * Insert a new learning into argus_learnings table.
 * Always scoped to atlasUserId.
 */

const supabase = require('../utils/supabase');

const VALID_CATEGORIES = ['preference', 'behavioral', 'correction', 'context', 'relationship'];
const VALID_PRIORITIES = ['core', 'standard', 'ephemeral'];
const CORE_PRIORITY_PATTERNS = [/\balways remember\b/i, /\bnever forget\b/i, /\bpermanent(?:ly)?\b/i, /\bforever\b/i, /\bcommit to long-term memory\b/i];
const EPHEMERAL_PRIORITY_PATTERNS = [/\bfor now\b/i, /\btemporar(?:y|ily)\b/i, /\buntil\b/i];

function detectPriority({ priority, content = '', source = '' } = {}) {
  if (VALID_PRIORITIES.includes(priority)) return priority;
  const haystack = `${content} ${source}`;
  if (CORE_PRIORITY_PATTERNS.some(pattern => pattern.test(haystack))) return 'core';
  if (EPHEMERAL_PRIORITY_PATTERNS.some(pattern => pattern.test(haystack))) return 'ephemeral';
  return 'standard';
}

/**
 * @param {string} atlasUserId
 * @param {{
 *   person_name?: string,
 *   person_id?: string,
 *   category: string,
 *   content: string,
 *   priority?: 'core'|'standard'|'ephemeral',
 *   source?: string
 * }} params
 * @returns {Promise<object>}
 */
async function storeLearning(atlasUserId, {
  person_name,
  person_id,
  category,
  content,
  priority,
  source,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };
    if (!content || !content.trim()) return { error: 'content is required' };
    if (!category) return { error: 'category is required' };

    const normalizedCategory = category.toLowerCase();
    if (!VALID_CATEGORIES.includes(normalizedCategory)) {
      return {
        error: `Invalid category "${category}". Valid categories: ${VALID_CATEGORIES.join(', ')}`,
      };
    }

    // Resolve person_name to person_id if needed
    let resolvedPersonId = person_id || null;
    let resolvedPersonName = person_name || null;

    if (!resolvedPersonId && person_name) {
      const { data: people, error: pErr } = await supabase
        .from('people')
        .select('id, name')
        .eq('atlas_user_id', atlasUserId)
        .ilike('name', `%${person_name}%`)
        .limit(1);

      if (pErr) return { error: `DB error resolving person: ${pErr.message}` };
      if (people && people.length > 0) {
        resolvedPersonId = people[0].id;
        resolvedPersonName = people[0].name;
      }
    }

    const resolvedPriority = detectPriority({ priority, content, source });
    const record = {
      atlas_user_id: atlasUserId,
      category: normalizedCategory,
      content: content.trim(),
      source: source || 'argus-slack',
      priority: resolvedPriority,
      active: true,
    };

    if (resolvedPersonId) record.person_id = resolvedPersonId;
    if (resolvedPersonName) record.person_name = resolvedPersonName;

    const { data, error } = await supabase
      .from('argus_learnings')
      .insert(record)
.select('id, category, content, person_name, created_at, priority')
      .single();

    if (error) return { error: `DB error storing learning: ${error.message}` };

    return {
      success: true,
      learning_id: data.id,
      category: data.category,
      content: data.content,
      person_name: data.person_name || null,
      created_at: data.created_at,
      priority: data.priority || resolvedPriority,
    };
  } catch (err) {
    return { error: `storeLearning failed: ${err.message}` };
  }
}

module.exports = storeLearning;
