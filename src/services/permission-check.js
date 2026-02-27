'use strict';

/**
 * Permission checking service for multi-user Atlas data access.
 *
 * Handles checking, granting, and revoking standing permissions that control
 * whether one Slack user can query another Atlas user's data.
 */

/**
 * Resolve a Slack user ID to an Atlas user ID via user_slack_identities.
 * Returns null if no mapping found.
 *
 * @param {object} supabase - Initialized Supabase client
 * @param {string} slackUserId - Slack user ID to look up
 * @returns {Promise<string|null>} atlas_user_id or null
 */
async function resolveAtlasId(supabase, slackUserId) {
  const { data, error } = await supabase
    .from('user_slack_identities')
    .select('atlas_user_id')
    .eq('slack_user_id', slackUserId)
    .maybeSingle();

  if (error) {
    console.error('[permission-check] resolveAtlasId error:', error.message);
    return null;
  }
  return data?.atlas_user_id ?? null;
}

/**
 * Check whether a requestor (identified by Slack ID) has permission to access
 * a specific data type belonging to an Atlas user.
 *
 * Check order:
 *  1. Self-query  — requestor's Slack ID maps to the same Atlas user as the data owner
 *  2. Admin       — requestor has role='admin' in the `user` table
 *  3. Standing permission in data_access_permissions
 *     - scope='always' (and not expired) → allowed
 *     - scope='never'                    → denied
 *  4. Default: needs_approval
 *
 * @param {object} supabase - Initialized Supabase client
 * @param {object} params
 * @param {string} params.requestorSlackId   - Slack user ID of the person making the request
 * @param {string} params.dataOwnerAtlasId   - Atlas user ID whose data is being requested
 * @param {string} params.dataType           - 'calendar' | 'email' | 'slack' | 'contacts' | 'all'
 * @returns {Promise<{ allowed: boolean, scope: string, reason: string }>}
 */
async function checkPermission(supabase, { requestorSlackId, dataOwnerAtlasId, dataType }) {
  // ── 1. Self-query check ────────────────────────────────────────────────────
  const requestorAtlasId = await resolveAtlasId(supabase, requestorSlackId);

  if (requestorAtlasId && requestorAtlasId === dataOwnerAtlasId) {
    return { allowed: true, scope: 'self', reason: 'Self-query' };
  }

  // ── 2. Admin check ─────────────────────────────────────────────────────────
  if (requestorAtlasId) {
    const { data: userRow, error: userError } = await supabase
      .from('user')
      .select('role')
      .eq('id', requestorAtlasId)
      .maybeSingle();

    if (userError) {
      console.error('[permission-check] admin check error:', userError.message);
    } else if (userRow?.role === 'admin') {
      return { allowed: true, scope: 'admin', reason: 'Admin access' };
    }
  }

  // ── 3. Standing permission check ───────────────────────────────────────────
  // Match on exact data_type OR 'all' wildcard
  const { data: permissions, error: permError } = await supabase
    .from('data_access_permissions')
    .select('scope, expires_at')
    .eq('atlas_user_id', dataOwnerAtlasId)
    .eq('grantee_slack_user_id', requestorSlackId)
    .in('data_type', [dataType, 'all']);

  if (permError) {
    console.error('[permission-check] permission lookup error:', permError.message);
    // Fall through to default
  } else if (permissions && permissions.length > 0) {
    const now = new Date();

    // Check for explicit 'never' first — a deny overrides a broader 'always'
    const denied = permissions.find((p) => p.scope === 'never');
    if (denied) {
      return { allowed: false, scope: 'denied', reason: 'Access denied by data owner' };
    }

    // Check for 'always' (not expired)
    const standing = permissions.find(
      (p) =>
        p.scope === 'always' &&
        (p.expires_at === null || new Date(p.expires_at) > now)
    );
    if (standing) {
      return { allowed: true, scope: 'standing', reason: 'Standing permission' };
    }
  }

  // ── 4. Default: needs approval ─────────────────────────────────────────────
  return { allowed: false, scope: 'needs_approval', reason: 'Requires data owner approval' };
}

/**
 * Grant (or update) a standing permission for a grantee to access an owner's data.
 * Uses upsert on (atlas_user_id, grantee_slack_user_id, data_type).
 *
 * @param {object} supabase - Initialized Supabase client
 * @param {object} params
 * @param {string}      params.ownerAtlasId    - Atlas user ID of the data owner
 * @param {string}      params.granteeSlackId  - Slack user ID of the grantee
 * @param {string|null} [params.granteeAtlasId] - Atlas user ID of the grantee (if known)
 * @param {string}      params.dataType        - 'calendar' | 'email' | 'slack' | 'contacts' | 'all'
 * @param {string}      [params.scope='always'] - 'always' | 'ask_each_time' | 'never'
 * @param {string}      [params.grantedBy='user'] - 'user' | 'admin'
 * @param {string|null} [params.expiresAt]     - ISO timestamp or null for no expiry
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
async function grantPermission(
  supabase,
  {
    ownerAtlasId,
    granteeSlackId,
    granteeAtlasId = null,
    dataType,
    scope = 'always',
    grantedBy = 'user',
    expiresAt = null,
  }
) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('data_access_permissions')
    .upsert(
      {
        atlas_user_id: ownerAtlasId,
        grantee_slack_user_id: granteeSlackId,
        grantee_atlas_user_id: granteeAtlasId,
        data_type: dataType,
        scope,
        granted_by: grantedBy,
        expires_at: expiresAt,
        updated_at: now,
      },
      { onConflict: 'atlas_user_id,grantee_slack_user_id,data_type' }
    )
    .select()
    .maybeSingle();

  if (error) {
    console.error('[permission-check] grantPermission error:', error.message);
  }

  return { data, error };
}

/**
 * Revoke (delete) a permission record for the given owner/grantee/dataType combination.
 *
 * @param {object} supabase - Initialized Supabase client
 * @param {object} params
 * @param {string} params.ownerAtlasId   - Atlas user ID of the data owner
 * @param {string} params.granteeSlackId - Slack user ID of the grantee
 * @param {string} params.dataType       - Data type to revoke
 * @returns {Promise<{ error: object|null }>}
 */
async function revokePermission(supabase, { ownerAtlasId, granteeSlackId, dataType }) {
  const { error } = await supabase
    .from('data_access_permissions')
    .delete()
    .eq('atlas_user_id', ownerAtlasId)
    .eq('grantee_slack_user_id', granteeSlackId)
    .eq('data_type', dataType);

  if (error) {
    console.error('[permission-check] revokePermission error:', error.message);
  }

  return { error };
}

module.exports = { checkPermission, grantPermission, revokePermission };
