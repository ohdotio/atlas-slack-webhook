'use strict';

/**
 * escalation-router.js — Route escalations to the correct data owner.
 *
 * Replaces the old "always escalate to Jeff" pattern with targeted escalation
 * to whichever Atlas user owns the data being requested.
 */

const { WebClient } = require('@slack/web-api');
const supabase = require('../utils/supabase');
const { markdownToSlack } = require('../utils/slack-format');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

/**
 * Escalate a query to the data owner for approval.
 *
 * Sends a DM to the data owner asking them to approve/decline the data request.
 * Creates an approval record in the relay_approval_queue.
 *
 * @param {object} params
 * @param {string} params.requestorSlackId     - Who's asking
 * @param {string} params.requestorName        - Display name of requestor
 * @param {string} params.dataOwnerSlackId     - Who owns the data
 * @param {string} params.dataOwnerAtlasId     - Atlas user ID of data owner
 * @param {string} params.dataOwnerName        - Display name of data owner
 * @param {string} params.originalMessage      - What the requestor asked
 * @param {string[]} params.dataTypes          - What data types are needed
 * @param {string} params.requestorChannelId   - Channel to respond to requestor
 * @returns {Promise<{success: boolean, approvalId?: string, error?: string}>}
 */
async function escalateToDataOwner({
  requestorSlackId,
  requestorName,
  dataOwnerSlackId,
  dataOwnerAtlasId,
  dataOwnerName,
  originalMessage,
  dataTypes,
  requestorChannelId,
}) {
  try {
    // ── Open DM channel with data owner ──────────────────────────────────
    let ownerChannelId;
    try {
      const openResult = await slack.conversations.open({ users: dataOwnerSlackId });
      ownerChannelId = openResult.channel?.id;
    } catch (err) {
      console.error('[escalation] Failed to open DM with data owner:', err.message);
      return { success: false, error: 'Could not reach the data owner' };
    }

    if (!ownerChannelId) {
      return { success: false, error: 'Could not open DM channel with data owner' };
    }

    // ── Build approval message ───────────────────────────────────────────
    const dataTypeStr = dataTypes.length > 0 ? dataTypes.join(', ') : 'general information';
    const approvalMessage = [
      `📋 *Data access request*`,
      ``,
      `*${requestorName}* is asking about your ${dataTypeStr}:`,
      `> ${originalMessage}`,
      ``,
      `How would you like to handle this?`,
      `• Reply with your answer and I'll pass it along`,
      `• Say *"decline"* to refuse the request`,
      `• Say *"always allow"* to give ${requestorName} standing access to your ${dataTypeStr}`,
    ].join('\n');

    // ── Post to data owner ───────────────────────────────────────────────
    const posted = await slack.chat.postMessage({
      channel: ownerChannelId,
      text: markdownToSlack(approvalMessage),
    });

    // ── Create approval record ───────────────────────────────────────────
    const approvalRecord = {
      sender_slack_user_id: requestorSlackId,
      sender_name: requestorName,
      recipient_slack_user_id: dataOwnerSlackId,
      data_owner_atlas_user_id: dataOwnerAtlasId,
      original_message: originalMessage,
      data_type: dataTypes.join(','),
      requestor_channel_id: requestorChannelId,
      approval_message_ts: posted.ts,
      approval_channel_id: ownerChannelId,
      status: 'pending_approval',
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('relay_approval_queue')
      .insert(approvalRecord)
      .select('id')
      .single();

    if (error) {
      console.error('[escalation] Failed to create approval record:', error.message);
      // Message was sent to owner, so it's partially successful
      return { success: true, approvalId: null, error: 'Approval tracking failed but owner was notified' };
    }

    console.log(`[escalation] Created approval ${data.id} for ${requestorName} → ${dataOwnerName}`);
    return { success: true, approvalId: data.id };

  } catch (err) {
    console.error('[escalation] Unexpected error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get the data owner's Slack user ID from their Atlas user ID.
 * Queries user_slack_identities table.
 *
 * @param {string} atlasUserId
 * @returns {Promise<string|null>} Slack user ID
 */
async function getSlackIdForAtlasUser(atlasUserId) {
  const { data } = await supabase
    .from('user_slack_identities')
    .select('slack_user_id')
    .eq('atlas_user_id', atlasUserId)
    .limit(1)
    .maybeSingle();

  return data?.slack_user_id || null;
}

module.exports = {
  escalateToDataOwner,
  getSlackIdForAtlasUser,
};
