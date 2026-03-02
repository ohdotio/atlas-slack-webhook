-- Cross-user data access requests
-- When someone asks Argus about another Atlas user's private data,
-- this table tracks the request → owner response → delivery flow.

CREATE TABLE IF NOT EXISTS cross_user_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- Who's asking
  requestor_atlas_user_id TEXT,              -- set if requestor is Atlas user, null if not
  requestor_slack_user_id TEXT,              -- Slack user ID (for routing response back)
  requestor_phone TEXT,                      -- phone number (for Sendblue routing)
  requestor_name TEXT NOT NULL,              -- display name
  requestor_channel_id TEXT,                 -- Slack channel to reply in
  requestor_thread_ts TEXT,                  -- Slack thread context
  requestor_surface TEXT NOT NULL,           -- 'slack' or 'sendblue'
  
  -- Whose data they want
  target_atlas_user_id TEXT NOT NULL,        -- the data owner
  target_slack_user_id TEXT,                 -- owner's Slack user ID (for DM delivery)
  
  -- The owner's DM thread (where the back-and-forth happens)
  owner_channel_id TEXT,                     -- Slack DM channel with owner
  owner_thread_ts TEXT,                      -- thread ts — THE key for routing owner replies
  
  -- The request
  original_question TEXT NOT NULL,
  data_type TEXT,                            -- 'calendar', 'email', 'contacts', 'schedule', 'general'
  
  -- Resolution
  status TEXT DEFAULT 'pending' NOT NULL,    -- pending → in_progress → answered → denied → expired
  owner_instruction TEXT,                    -- owner's final direction
  response_to_requestor TEXT,               -- what Argus actually sent back
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT (now() + interval '24 hours')
);

-- Index for looking up requests by owner thread (the hot path)
CREATE INDEX IF NOT EXISTS idx_cross_user_owner_thread 
  ON cross_user_requests (owner_channel_id, owner_thread_ts) 
  WHERE status IN ('pending', 'in_progress');

-- Index for expiry cleanup
CREATE INDEX IF NOT EXISTS idx_cross_user_expires 
  ON cross_user_requests (expires_at) 
  WHERE status IN ('pending', 'in_progress');
