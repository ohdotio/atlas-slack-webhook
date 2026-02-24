-- Migration 003: Row Level Security for all tables
-- 
-- PREREQUISITES:
--   Atlas Electron must authenticate to Supabase using a JWT where
--   auth.uid() = the user's Google OAuth ID (atlas_user_id).
--   Service-role key (used by webhook, headless) bypasses RLS automatically.
--
-- DO NOT RUN until Atlas Electron auth is updated to use JWT auth.
-- Running this with the current publishable key will break all syncs.

-- ============================================================================
-- USER TABLE (user's own row: id = auth.uid())
-- ============================================================================
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own row" ON "user"
  FOR SELECT USING (id = auth.uid()::text);

CREATE POLICY "Users can update own row" ON "user"
  FOR UPDATE USING (id = auth.uid()::text);

-- No insert policy — users are created during onboarding (service-role)

-- ============================================================================
-- STANDARD atlas_user_id TABLES
-- ============================================================================

-- Helper: same pattern for all tables scoped by atlas_user_id
-- SELECT, INSERT, UPDATE, DELETE all check atlas_user_id = auth.uid()

-- PEOPLE
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their people" ON people
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- EMAILS
ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their emails" ON emails
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- SLACK MESSAGES
ALTER TABLE slack_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their slack messages" ON slack_messages
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- IMESSAGE MESSAGES
ALTER TABLE imessage_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their imessages" ON imessage_messages
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- CALENDAR EVENTS
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their calendar events" ON calendar_events
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- TRANSCRIPTIONS
ALTER TABLE transcriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their transcriptions" ON transcriptions
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- PROFILE SYNTHESIS
ALTER TABLE profile_synthesis ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their profile synthesis" ON profile_synthesis
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- ARGUS LEARNINGS
ALTER TABLE argus_learnings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their argus learnings" ON argus_learnings
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- ARGUS CONVERSATIONS
ALTER TABLE argus_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their argus conversations" ON argus_conversations
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- AI SETTINGS
ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their ai settings" ON ai_settings
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- APP SETTINGS
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their app settings" ON app_settings
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- BEEPER MESSAGES
ALTER TABLE beeper_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their beeper messages" ON beeper_messages
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- PHONE CALLS
ALTER TABLE phone_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their phone calls" ON phone_calls
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- INTERACTIONS
ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their interactions" ON interactions
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- SYNC STATE
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their sync state" ON sync_state
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- USER SLACK IDENTITIES
ALTER TABLE user_slack_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their slack identities" ON user_slack_identities
  FOR ALL USING (atlas_user_id = auth.uid()::text)
  WITH CHECK (atlas_user_id = auth.uid()::text);

-- ============================================================================
-- RELAY TABLES (scoped by sender_atlas_user_id)
-- ============================================================================

-- SLACK MESSAGE RELAY
ALTER TABLE slack_message_relay ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their sent relays" ON slack_message_relay
  FOR ALL USING (sender_atlas_user_id = auth.uid()::text)
  WITH CHECK (sender_atlas_user_id = auth.uid()::text);

-- RELAY APPROVAL QUEUE
ALTER TABLE relay_approval_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their approval requests" ON relay_approval_queue
  FOR ALL USING (sender_atlas_user_id = auth.uid()::text)
  WITH CHECK (sender_atlas_user_id = auth.uid()::text);

-- ============================================================================
-- SLACK BOT INSTALLATIONS (admin-only, service-role access)
-- ============================================================================
ALTER TABLE slack_bot_installations ENABLE ROW LEVEL SECURITY;
-- No user policies — managed via service-role only
