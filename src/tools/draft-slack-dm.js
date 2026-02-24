'use strict';

/**
 * draft-slack-dm.js
 * Prepare a Slack DM draft for confirmation — does NOT send.
 * Resolves recipient_name to a Slack user via the people table.
 * Always scoped to atlasUserId.
 */

const supabase = require('../utils/supabase');

/**
 * @param {string} atlasUserId
 * @param {{
 *   recipient_name: string,
 *   message: string,
 *   context?: string
 * }} params
 * @returns {Promise<object>}
 */
async function draftSlackDm(atlasUserId, {
  recipient_name,
  message,
  context,
} = {}) {
  try {
    if (!atlasUserId) return { error: 'atlasUserId is required' };
    if (!recipient_name) return { error: 'recipient_name is required' };
    if (!message || !message.trim()) return { error: 'message is required' };

    // Resolve recipient to a Slack identity from the people table
    const { data: people, error: pErr } = await supabase
      .from('people')
      .select('id, name, slack_id, slack_username, email')
      .eq('atlas_user_id', atlasUserId)
      .ilike('name', `%${recipient_name}%`)
      .order('score', { ascending: false })
      .limit(5);

    if (pErr) return { error: `DB error resolving recipient: ${pErr.message}` };
    if (!people || people.length === 0) {
      return {
        error: `Could not find anyone named "${recipient_name}" in your network.`,
        recipient_name,
      };
    }

    // Pick the best match (first, highest-scored person with a slack id if possible)
    const withSlack = people.find(p => p.slack_id || p.slack_username);
    const person = withSlack || people[0];

    const toIdentifier = person.slack_id || person.slack_username || person.email || person.name;
    const toDisplay = person.name + (person.slack_username ? ` (@${person.slack_username})` : '');

    return {
      type: 'slack_draft',
      needs_confirmation: true,
      draft: {
        to: toIdentifier,
        toDisplay,
        person_id: person.id,
        has_slack_id: !!(person.slack_id || person.slack_username),
        message: message.trim(),
        context: context || null,
      },
    };
  } catch (err) {
    return { error: `draftSlackDm failed: ${err.message}` };
  }
}

module.exports = draftSlackDm;
