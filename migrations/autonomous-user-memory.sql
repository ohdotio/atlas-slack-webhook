-- Autonomous conversation memory for non-Atlas users.
-- Stores facts Argus learns about people through conversation.
-- Used to make Argus feel like a real colleague who remembers you.

CREATE TABLE IF NOT EXISTS autonomous_user_memory (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  category TEXT DEFAULT 'general',  -- personal, work, preference, humor, plan, opinion
  source_message TEXT,               -- the user message that triggered this memory (audit trail)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ             -- null = permanent
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_autonomous_memory_user ON autonomous_user_memory(slack_user_id);

-- Prevent exact duplicate facts for the same user
CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomous_memory_dedup 
  ON autonomous_user_memory(slack_user_id, fact);

-- RLS: service role only (webhook uses service key)
ALTER TABLE autonomous_user_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON autonomous_user_memory
  FOR ALL USING (true) WITH CHECK (true);
