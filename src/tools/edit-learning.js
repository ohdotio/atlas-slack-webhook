'use strict';

/**
 * edit-learning.js
 * Update an existing learning by id (content, category, person_name, source).
 * Always scoped to atlasUserId.
 */

const supabase = require('../utils/supabase');

const VALID_CATEGORIES = ['preference', 'behavioral', 'correction', 'context', 'relationship'];

/**
 * @param {string} atlasUserId
 * @param {{
 *   learning_id: string,
 *   content?: string,
 *   category?: string,
 *   person_name?: string,
 *   source?: string
 * }} params
 * @returns {Promise<object>}
 */
async function editLearning(atlasUserId, {
  learning_id,
  content,
  category,
  person_name,
  source,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };
    if (!learning_id) return { error: 'learning_id is required' };

    // Verify the learning belongs to this user
    const { data: existing, error: fetchErr } = await supabase
      .from('argus_learnings')
      .select('id, atlas_user_id')
      .eq('id', learning_id)
      .eq('atlas_user_id', atlasUserId)
      .single();

    if (fetchErr || !existing) {
      return { error: `Learning not found or access denied: ${learning_id}` };
    }

    const updates = {};
    if (content !== undefined && content !== null) updates.content = content.trim();
    if (category !== undefined && category !== null) {
      const normalizedCategory = category.toLowerCase();
      if (!VALID_CATEGORIES.includes(normalizedCategory)) {
        return { error: `Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(', ')}` };
      }
      updates.category = normalizedCategory;
    }
    if (person_name !== undefined) updates.person_name = person_name;
    if (source !== undefined) updates.source = source;

    if (Object.keys(updates).length === 0) {
      return { error: 'No fields to update. Provide content, category, person_name, or source.' };
    }

    const { data, error } = await supabase
      .from('argus_learnings')
      .update(updates)
      .eq('id', learning_id)
      .eq('atlas_user_id', atlasUserId)
      .select('id, category, content, person_name, source, created_at')
      .single();

    if (error) return { error: `DB error updating learning: ${error.message}` };

    return {
      success: true,
      learning: data,
    };
  } catch (err) {
    return { error: `editLearning failed: ${err.message}` };
  }
}

module.exports = editLearning;
