-- Cross-Channel Conversation Context
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- 
-- Adds person_id and source tracking to conversations and memories,
-- enabling Argus to share context across Slack, iMessage, and the Atlas UI.

-- 1. Add person_id and source to argus_conversations
ALTER TABLE argus_conversations ADD COLUMN IF NOT EXISTS person_id TEXT;
ALTER TABLE argus_conversations ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'app';

-- Index for fast person-based lookups (cross-channel history)
CREATE INDEX IF NOT EXISTS idx_argus_conv_person 
  ON argus_conversations(person_id, created_at DESC);

-- 2. Add person_id to autonomous_user_memory  
ALTER TABLE autonomous_user_memory ADD COLUMN IF NOT EXISTS person_id TEXT;

CREATE INDEX IF NOT EXISTS idx_auto_mem_person 
  ON autonomous_user_memory(person_id);

-- 3. Backfill person_id on existing memories (map slack_user_id → people.id)
UPDATE autonomous_user_memory m
SET person_id = p.id
FROM people p
WHERE p.slack_id = m.slack_user_id
  AND m.person_id IS NULL;

-- 4. Create a helper function for future migrations (optional but useful)
CREATE OR REPLACE FUNCTION exec_sql(sql TEXT) RETURNS void AS $$
BEGIN
  EXECUTE sql;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
