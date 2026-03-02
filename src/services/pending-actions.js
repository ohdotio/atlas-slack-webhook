'use strict';

/**
 * Pending Actions Store — the brain's short-term memory.
 *
 * Tracks what Argus needs the principal's attention on:
 * - Draft approvals (send_text with confirmed=false)
 * - Data permission requests (someone asked for the principal's private data)
 * - Active permissions (scoped authorizations the principal has granted)
 * - Active conversations (who Argus is currently chatting with)
 *
 * Persisted to Supabase (survives deploys). Cached in memory (fast reads).
 * All intelligence decisions are made by the LLM — this is just the data layer.
 */

const supabase = require('../utils/supabase');
const { sendMessage } = require('../utils/sendblue');

const OWNER_PHONE = process.env.OWNER_PHONE_NUMBER || '+14197047571';

// ── In-memory caches (keyed by atlas_user_id) ─────────────────────────────

// Pending actions: things awaiting the principal's decision
// Map<atlasUserId, PendingAction[]>
const pendingActionsCache = new Map();

// Active permissions: scoped authorizations the principal has granted
// Map<atlasUserId, Permission[]>
const permissionsCache = new Map();

// Active conversations: who Argus is currently talking to
// Map<atlasUserId, ConversationSummary[]>
const activeConvosCache = new Map();

// Last Supabase sync timestamp per user
const lastSync = new Map();
const SYNC_INTERVAL_MS = 30_000; // re-hydrate from Supabase every 30s max

// ── Schema ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PendingAction
 * @property {string} id - Unique action ID (pa_<timestamp>_<random>)
 * @property {'draft_approval'|'data_permission'|'info'} type
 * @property {string} contact_name - Who this is about
 * @property {string} contact_phone - E.164
 * @property {string} description - Human-readable description for the principal
 * @property {string} [draft_message] - The drafted message text (for draft_approval)
 * @property {string} [media_url] - Attached media (for draft_approval with image)
 * @property {string} [data_needed] - What data is needed (for data_permission)
 * @property {string} [send_style] - iMessage send style (for draft_approval)
 * @property {Object} [send_params] - Full params to replay send_text (for draft_approval)
 * @property {number} created_at - Unix ms timestamp
 * @property {number} expires_at - Unix ms timestamp (default: 2 hours)
 */

/**
 * @typedef {Object} Permission
 * @property {string} id - Unique permission ID (perm_<timestamp>_<random>)
 * @property {string} contact_name
 * @property {string} contact_phone
 * @property {string} scope - Natural language description of what's authorized
 * @property {number} granted_at - Unix ms
 * @property {number} expires_at - Unix ms (default: 24 hours)
 */

/**
 * @typedef {Object} ConversationSummary
 * @property {string} phone
 * @property {string} name
 * @property {string} summary - Brief description of what they're talking about
 * @property {number} message_count
 * @property {number} last_message_at - Unix ms
 */

// ── ID Generation ─────────────────────────────────────────────────────────

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

// ── Pending Actions CRUD ──────────────────────────────────────────────────

function _getActions(atlasUserId) {
  if (!pendingActionsCache.has(atlasUserId)) pendingActionsCache.set(atlasUserId, []);
  return pendingActionsCache.get(atlasUserId);
}

/**
 * Add a pending action for a principal.
 */
async function addPendingAction(atlasUserId, action) {
  const pa = {
    id: genId('pa'),
    created_at: Date.now(),
    expires_at: Date.now() + 2 * 60 * 60 * 1000, // 2 hours default
    ...action,
  };

  const actions = _getActions(atlasUserId);

  // Dedup: if there's already a draft_approval or data_release for the same contact,
  // replace it instead of stacking. The principal only needs the latest draft.
  if (pa.type === 'draft_approval' || pa.type === 'data_release') {
    const existingIdx = actions.findIndex(a =>
      (a.type === 'draft_approval' || a.type === 'data_release') &&
      a.contact_phone === pa.contact_phone &&
      a.contact_name?.toLowerCase() === pa.contact_name?.toLowerCase()
    );
    if (existingIdx !== -1) {
      console.log(`[pending-actions] Replacing existing ${actions[existingIdx].type} for ${pa.contact_name} (${actions[existingIdx].id} → ${pa.id})`);
      actions.splice(existingIdx, 1);
    }
  }

  actions.push(pa);

  // Persist
  _persistActions(atlasUserId).catch(e => console.warn('[pending-actions] persist failed:', e.message));

  console.log(`[pending-actions] Added ${pa.type} for ${pa.contact_name}: "${(pa.description || '').substring(0, 60)}"`);
  return pa;
}

/**
 * Get all active (non-expired) pending actions for a principal.
 */
async function getPendingActions(atlasUserId) {
  await _ensureHydrated(atlasUserId);
  const actions = _getActions(atlasUserId);
  const now = Date.now();

  // Filter expired
  const active = actions.filter(a => a.expires_at > now);
  if (active.length !== actions.length) {
    pendingActionsCache.set(atlasUserId, active);
    _persistActions(atlasUserId).catch(e => console.warn('[pending-actions] persist failed:', e.message));
  }

  return active;
}

/**
 * Get a specific pending action by ID.
 */
async function getPendingActionById(atlasUserId, actionId) {
  const actions = await getPendingActions(atlasUserId);
  return actions.find(a => a.id === actionId) || null;
}

/**
 * Remove a pending action (approved, denied, or expired).
 */
async function removePendingAction(atlasUserId, actionId) {
  const actions = _getActions(atlasUserId);
  const idx = actions.findIndex(a => a.id === actionId);
  if (idx === -1) return null;
  const [removed] = actions.splice(idx, 1);
  _persistActions(atlasUserId).catch(e => console.warn('[pending-actions] persist failed:', e.message));
  return removed;
}

/**
 * Atomically claim a pending action for execution.
 * Prevents double-sends when fast-path and in-flight agent race.
 */
async function claimPendingAction(atlasUserId, actionId) {
  const actions = _getActions(atlasUserId);
  const action = actions.find(a => a.id === actionId);
  if (!action) return null;
  if (action.status === 'executing' || action.executed_at) return null;
  if (action.expires_at && action.expires_at < Date.now()) return null;
  action.status = 'executing';
  action.executed_at = Date.now();
  await _persistActions(atlasUserId);
  console.log(`[pending-actions] Claimed action ${actionId} for execution`);
  return action;
}

/**
 * Clear all pending actions for a principal (e.g., "clear everything").
 */
async function clearAllPendingActions(atlasUserId) {
  pendingActionsCache.set(atlasUserId, []);
  _persistActions(atlasUserId).catch(e => console.warn('[pending-actions] persist failed:', e.message));
}

// ── Permissions CRUD ──────────────────────────────────────────────────────

function _getPermissions(atlasUserId) {
  if (!permissionsCache.has(atlasUserId)) permissionsCache.set(atlasUserId, []);
  return permissionsCache.get(atlasUserId);
}

/**
 * Grant a scoped permission.
 */
async function grantPermission(atlasUserId, permission) {
  const perm = {
    id: genId('perm'),
    granted_at: Date.now(),
    expires_at: Date.now() + 24 * 60 * 60 * 1000, // 24 hours default
    ...permission,
  };

  const perms = _getPermissions(atlasUserId);
  perms.push(perm);

  _persistPermissions(atlasUserId).catch(e => console.warn('[pending-actions] permissions persist failed:', e.message));

  console.log(`[pending-actions] Permission granted for ${perm.contact_name}: "${perm.scope.substring(0, 60)}"`);
  return perm;
}

/**
 * Get all active permissions for a principal.
 */
async function getActivePermissions(atlasUserId) {
  await _ensureHydrated(atlasUserId);
  const perms = _getPermissions(atlasUserId);
  const now = Date.now();

  const active = perms.filter(p => p.expires_at > now);
  if (active.length !== perms.length) {
    permissionsCache.set(atlasUserId, active);
    _persistPermissions(atlasUserId).catch(e => console.warn('[pending-actions] permissions persist failed:', e.message));
  }

  return active;
}

/**
 * Get permissions for a specific contact.
 */
async function getPermissionsForContact(atlasUserId, contactIdentifier) {
  const perms = await getActivePermissions(atlasUserId);
  if (!contactIdentifier) return [];
  return perms.filter(p =>
    p.contact_phone === contactIdentifier ||
    p.contact_name?.toLowerCase() === contactIdentifier?.toLowerCase() ||
    p.contact_slack_id === contactIdentifier
  );
}

/**
 * Revoke a specific permission.
 */
async function revokePermission(atlasUserId, permissionId) {
  const perms = _getPermissions(atlasUserId);
  const idx = perms.findIndex(p => p.id === permissionId);
  if (idx === -1) return null;
  const [removed] = perms.splice(idx, 1);
  _persistPermissions(atlasUserId).catch(e => console.warn('[pending-actions] permissions persist failed:', e.message));
  return removed;
}

// ── Active Conversations Tracking ─────────────────────────────────────────

function _getConvos(atlasUserId) {
  if (!activeConvosCache.has(atlasUserId)) activeConvosCache.set(atlasUserId, []);
  return activeConvosCache.get(atlasUserId);
}

/**
 * Update the active conversation summary for a contact.
 * Called after each autonomous conversation turn.
 */
async function updateActiveConversation(atlasUserId, { phone, slackUserId, name, lastUserMessage, lastArgusReply, source }) {
  const convos = _getConvos(atlasUserId);
  const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

  // Remove stale conversations
  const now = Date.now();
  const fresh = convos.filter(c => now - c.last_message_at < STALE_MS);

  // Find or create entry for this contact (match by phone OR slackUserId)
  const identifier = phone || slackUserId;
  let entry = fresh.find(c => (phone && c.phone === phone) || (slackUserId && c.slackUserId === slackUserId));
  if (!entry) {
    entry = {
      phone: phone || null,
      slackUserId: slackUserId || null,
      name: name || identifier,
      summary: '',
      message_count: 0,
      last_message_at: now,
      source: source || 'unknown',
    };
    fresh.push(entry);
  }

  entry.message_count += 1;
  entry.last_message_at = now;
  entry.name = name || entry.name;

  // Update summary (keep it short — last exchange)
  if (lastUserMessage) {
    const preview = lastUserMessage.length > 80 ? lastUserMessage.substring(0, 80) + '...' : lastUserMessage;
    entry.summary = `Last: "${preview}"`;
  }

  activeConvosCache.set(atlasUserId, fresh);
  // Don't persist active convos — they're transient and high-frequency
}

/**
 * Get active conversation summaries for a principal.
 */
function getActiveConversations(atlasUserId) {
  const convos = _getConvos(atlasUserId);
  const STALE_MS = 2 * 60 * 60 * 1000;
  const now = Date.now();
  return convos.filter(c => now - c.last_message_at < STALE_MS);
}

// ── Situational Awareness Prompt Block ────────────────────────────────────

/**
 * Build the SITUATIONAL AWARENESS block for the principal's system prompt.
 * This is the key integration point — injected into the Command Room prompt
 * so Argus the LLM has full context about what's happening.
 */
async function buildSituationalAwareness(atlasUserId) {
  const actions = await getPendingActions(atlasUserId);
  const permissions = await getActivePermissions(atlasUserId);
  const conversations = getActiveConversations(atlasUserId);

  const sections = [];

  // Active conversations (across all surfaces)
  if (conversations.length > 0) {
    const lines = conversations.map(c => {
      const ago = _formatTimeAgo(Date.now() - c.last_message_at);
      const surface = c.source === 'slack' ? '[Slack]' : c.source === 'sendblue' ? '[iMessage]' : '';
      return `- ${c.name} ${surface}: ${c.summary || 'chatting'} (${c.message_count} msgs, ${ago})`;
    });
    sections.push(`Active conversations:\n${lines.join('\n')}`);
  }

  // Pending actions
  if (actions.length > 0) {
    const lines = actions.map((a, i) => {
      if (a.type === 'draft_approval') {
        const media = a.media_url ? ' [with image]' : '';
        return `${i + 1}. [${a.id}] DRAFT to ${a.contact_name}: "${(a.draft_message || '').substring(0, 100)}"${media} — say "send" to deliver, or tell me to change it`;
      } else if (a.type === 'data_permission') {
        return `${i + 1}. [${a.id}] ${a.contact_name} asked about ${a.description} (needs ${a.data_needed || 'your input'}) — tell me what to share, "check it" to fetch the data, or "skip it"`;
      } else if (a.type === 'data_release') {
        return `${i + 1}. [${a.id}] RELEASE to ${a.contact_name}: "${(a.draft_message || '').substring(0, 100)}" — say "send" to deliver, or tell me to change it`;
      } else {
        return `${i + 1}. [${a.id}] ${a.description}`;
      }
    });
    sections.push(`Pending (awaiting your direction):\n${lines.join('\n')}`);
  }

  // Active permissions
  if (permissions.length > 0) {
    const lines = permissions.map(p => {
      const expiresIn = _formatTimeAgo(p.expires_at - Date.now());
      return `- ${p.contact_name}: ${p.scope} (expires in ${expiresIn})`;
    });
    sections.push(`Active permissions you've granted:\n${lines.join('\n')}`);
  }

  if (sections.length === 0) return '';

  return `\n\nSITUATIONAL AWARENESS:\n\n${sections.join('\n\n')}

IMPORTANT: When the principal says "send", "yes", "approve", "do it" etc., interpret it in context of the pending actions above and call the approve_pending_action tool with the appropriate action_id. When they say "no", "skip", "cancel", "forget it" etc., call deny_pending_action. When they give modification instructions ("change it to..." / "tell her..."), call deny_pending_action with a redirect. You are the interpreter — use natural language understanding, not exact matching.`;
}

// ── Notification to Principal ─────────────────────────────────────────────

/**
 * Send a notification to the principal about a new pending action.
 * This is a text message via Sendblue — informational, not a conversation hijack.
 */
async function notifyPrincipal(atlasUserId, action) {
  let text;

  if (action.type === 'data_permission') {
    text = `🎩 ${action.contact_name} is asking about ${action.description}.\n\nI'm still chatting with them. Tell me what to share, or I'll handle it. — Argus 🎩`;
  } else if (action.type === 'draft_approval') {
    const media = action.media_url ? '\n[image attached]' : '';
    text = `🎩 Draft for ${action.contact_name}:\n\n"${(action.draft_message || '').substring(0, 300)}"${media}\n\n"Send" to deliver, or tell me what to change. — Argus 🎩`;
  } else if (action.type === 'data_release') {
    text = `🎩 Ready to share with ${action.contact_name}:\n\n"${(action.draft_message || '').substring(0, 300)}"\n\n"Send" to release, or tell me what to change. — Argus 🎩`;
  } else {
    text = `🎩 ${action.description} — Argus 🎩`;
  }

  try {
    await sendMessage(OWNER_PHONE, text);
    console.log(`[pending-actions] Notified principal about ${action.type} for ${action.contact_name}`);
  } catch (err) {
    console.warn(`[pending-actions] Failed to notify principal:`, err.message);
  }
}

// ── Supabase Persistence ──────────────────────────────────────────────────

async function _ensureHydrated(atlasUserId) {
  const last = lastSync.get(atlasUserId) || 0;
  if (Date.now() - last < SYNC_INTERVAL_MS) return;

  try {
    // Load pending actions
    const { data: actionsData } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'pending_actions')
      .eq('atlas_user_id', atlasUserId)
      .single();

    if (actionsData?.value) {
      const parsed = typeof actionsData.value === 'string' ? JSON.parse(actionsData.value) : actionsData.value;
      if (Array.isArray(parsed)) {
        // Merge with in-memory (in-memory wins for recent items)
        const inMemory = _getActions(atlasUserId);
        const inMemoryIds = new Set(inMemory.map(a => a.id));
        for (const item of parsed) {
          if (!inMemoryIds.has(item.id) && item.expires_at > Date.now()) {
            inMemory.push(item);
          }
        }
      }
    }

    // Load permissions
    const { data: permsData } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'active_permissions')
      .eq('atlas_user_id', atlasUserId)
      .single();

    if (permsData?.value) {
      const parsed = typeof permsData.value === 'string' ? JSON.parse(permsData.value) : permsData.value;
      if (Array.isArray(parsed)) {
        const inMemory = _getPermissions(atlasUserId);
        const inMemoryIds = new Set(inMemory.map(p => p.id));
        for (const item of parsed) {
          if (!inMemoryIds.has(item.id) && item.expires_at > Date.now()) {
            inMemory.push(item);
          }
        }
      }
    }

    lastSync.set(atlasUserId, Date.now());
  } catch (err) {
    console.warn('[pending-actions] Supabase hydration failed:', err.message);
    lastSync.set(atlasUserId, Date.now()); // Don't retry immediately on failure
  }
}

async function _persistActions(atlasUserId) {
  const actions = _getActions(atlasUserId);
  try {
    await supabase
      .from('app_settings')
      .upsert({
        key: 'pending_actions',
        atlas_user_id: atlasUserId,
        value: JSON.stringify(actions),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key,atlas_user_id' });
  } catch (err) {
    console.warn('[pending-actions] Actions persist failed:', err.message);
  }
}

async function _persistPermissions(atlasUserId) {
  const perms = _getPermissions(atlasUserId);
  try {
    await supabase
      .from('app_settings')
      .upsert({
        key: 'active_permissions',
        atlas_user_id: atlasUserId,
        value: JSON.stringify(perms),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key,atlas_user_id' });
  } catch (err) {
    console.warn('[pending-actions] Permissions persist failed:', err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _formatTimeAgo(ms) {
  const mins = Math.floor(Math.abs(ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

module.exports = {
  // Pending actions
  addPendingAction,
  getPendingActions,
  getPendingActionById,
  removePendingAction,
  claimPendingAction,
  clearAllPendingActions,

  // Permissions
  grantPermission,
  getActivePermissions,
  getPermissionsForContact,
  revokePermission,

  // Active conversations
  updateActiveConversation,
  getActiveConversations,

  // Prompt injection
  buildSituationalAwareness,

  // Notifications
  notifyPrincipal,
};
