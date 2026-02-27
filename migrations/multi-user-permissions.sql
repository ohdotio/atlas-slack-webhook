-- Multi-user data access permissions
-- Allows Atlas users to grant standing permissions for others to access their data

CREATE TABLE IF NOT EXISTS data_access_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  atlas_user_id TEXT NOT NULL,              -- data owner (grantor)
  grantee_slack_user_id TEXT NOT NULL,      -- who can access
  grantee_atlas_user_id TEXT,               -- if grantee is also Atlas user
  data_type TEXT NOT NULL,                  -- 'calendar', 'email', 'slack', 'contacts', 'all'
  scope TEXT DEFAULT 'ask_each_time',       -- 'always', 'ask_each_time', 'never'
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  granted_by TEXT DEFAULT 'user',           -- 'user' or 'admin'
  UNIQUE(atlas_user_id, grantee_slack_user_id, data_type)
);

-- Index for fast permission lookups
CREATE INDEX IF NOT EXISTS idx_dap_grantee ON data_access_permissions(grantee_slack_user_id, data_type);
CREATE INDEX IF NOT EXISTS idx_dap_owner ON data_access_permissions(atlas_user_id);

-- Extend relay_approval_queue for multi-user escalation
-- These columns are nullable for backwards compatibility with existing relay rows
ALTER TABLE relay_approval_queue ADD COLUMN IF NOT EXISTS data_owner_atlas_user_id TEXT;
ALTER TABLE relay_approval_queue ADD COLUMN IF NOT EXISTS data_type TEXT;
ALTER TABLE relay_approval_queue ADD COLUMN IF NOT EXISTS requestor_channel_id TEXT;
