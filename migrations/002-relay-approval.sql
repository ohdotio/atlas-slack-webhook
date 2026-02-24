-- Migration 002: Relay approval system
-- Run in Supabase SQL editor

-- 1. Add new columns to existing slack_message_relay table
ALTER TABLE slack_message_relay
  ADD COLUMN IF NOT EXISTS recipient_name TEXT,
  ADD COLUMN IF NOT EXISTS relay_context TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Update status enum to support new states
-- (status is TEXT so no enum change needed, just documenting valid values):
-- sent | active | pending_approval | replied | closed | expired

-- 2. Create relay_approval_queue table
CREATE TABLE IF NOT EXISTS relay_approval_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  relay_id UUID NOT NULL REFERENCES slack_message_relay(id) ON DELETE CASCADE,
  sender_atlas_user_id TEXT NOT NULL,
  recipient_question TEXT NOT NULL,
  suggested_response TEXT,
  approval_channel_id TEXT NOT NULL,
  approval_message_ts TEXT,
  status TEXT DEFAULT 'pending',  -- pending | approved | modified | declined | expired
  approved_response TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approval_relay ON relay_approval_queue(relay_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_user ON relay_approval_queue(sender_atlas_user_id, status);

-- 3. Add index for non-threaded relay lookups (find recent relays by recipient)
CREATE INDEX IF NOT EXISTS idx_relay_recipient_recent
  ON slack_message_relay(recipient_slack_user_id, status, created_at DESC);
