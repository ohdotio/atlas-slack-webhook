'use strict';

/**
 * delete-learning.js
 * Soft-delete a learning by setting active=false.
 * Always scoped to atlasUserId.
 */

const supabase = require('../utils/supabase');

/**
 * @param {string} atlasUserId
 * @param {{
 *   learning_id: string,
 *   reason?: string
 * }} params
 * @returns {Promise<object>}
 */
async function deleteLearning(atlasUserId, {
  learning_id,
  reason,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };
    if (!learning_id) return { error: 'learning_id is required' };

    // Verify the learning belongs to this user
    const { data: existing, error: fetchErr } = await supabase
      .from('argus_learnings')
      .select('id, content, atlas_user_id')
      .eq('id', learning_id)
      .eq('atlas_user_id', atlasUserId)
      .single();

    if (fetchErr || !existing) {
      return { error: `Learning not found or access denied: ${learning_id}` };
    }

    const { error } = await supabase
      .from('argus_learnings')
      .update({ active: false })
      .eq('id', learning_id)
      .eq('atlas_user_id', atlasUserId);

    if (error) return { error: `DB error deleting learning: ${error.message}` };

    return {
      success: true,
      deleted_id: learning_id,
      content_was: existing.content,
      reason: reason || null,
    };
  } catch (err) {
    return { error: `deleteLearning failed: ${err.message}` };
  }
}

module.exports = deleteLearning;
