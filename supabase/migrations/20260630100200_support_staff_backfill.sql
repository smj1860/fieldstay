-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill migration — reproduces the support-bot human-inbox authorization
-- layer that was applied directly to the live database (support_bot_phase3_
-- human_inbox, add_stephen_as_platform_staff) without a corresponding committed
-- migration file. This migration is idempotent and safe to run against an
-- environment where these objects already exist (production) or do not exist
-- yet (new environment, branch, disaster recovery).
-- ─────────────────────────────────────────────────────────────────────────────

-- 'human' role for staff replies rendering distinctly in chat
ALTER TYPE support_message_role ADD VALUE IF NOT EXISTS 'human';

-- support_conversations: escalation + assignment state
ALTER TABLE support_conversations
  ADD COLUMN IF NOT EXISTS needs_human        BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS escalation_reason   TEXT,
  ADD COLUMN IF NOT EXISTS escalated_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_staff_id    UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS staff_notified_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_support_conversations_needs_human
  ON support_conversations(needs_human, last_message_at DESC)
  WHERE needs_human = true;

CREATE INDEX IF NOT EXISTS idx_support_conversations_status_recent
  ON support_conversations(status, last_message_at DESC);

-- support_messages: track who sent a human reply
ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS sent_by_user_id UUID REFERENCES auth.users(id);

-- platform_staff: who can see the cross-org support inbox
CREATE TABLE IF NOT EXISTS platform_staff (
  user_id     UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL DEFAULT 'support' CHECK (role IN ('support', 'admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_staff ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_staff_self_select"   ON platform_staff;
DROP POLICY IF EXISTS "platform_staff_restrict_write" ON platform_staff;

CREATE POLICY "platform_staff_self_select" ON platform_staff
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY "platform_staff_restrict_write" ON platform_staff
  FOR ALL USING (false) WITH CHECK (false);

-- Helper function: is the current user platform staff?
CREATE OR REPLACE FUNCTION is_platform_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_staff WHERE user_id = (SELECT auth.uid())
  );
$$;

-- RLS: platform staff can read/manage all conversations (cross-tenant by design)
DROP POLICY IF EXISTS "support_conversations_staff_select" ON support_conversations;
DROP POLICY IF EXISTS "support_conversations_staff_update" ON support_conversations;
DROP POLICY IF EXISTS "support_messages_staff_select"       ON support_messages;
DROP POLICY IF EXISTS "support_messages_staff_insert"       ON support_messages;

CREATE POLICY "support_conversations_staff_select" ON support_conversations
  FOR SELECT USING (is_platform_staff());

CREATE POLICY "support_conversations_staff_update" ON support_conversations
  FOR UPDATE USING (is_platform_staff()) WITH CHECK (is_platform_staff());

CREATE POLICY "support_messages_staff_select" ON support_messages
  FOR SELECT USING (is_platform_staff());

CREATE POLICY "support_messages_staff_insert" ON support_messages
  FOR INSERT WITH CHECK (is_platform_staff());

-- Stephen as initial platform staff admin (idempotent — no-op if already present)
INSERT INTO platform_staff (user_id, role)
SELECT id, 'admin' FROM auth.users WHERE email = 'stephen@fieldstay.app'
ON CONFLICT (user_id) DO NOTHING;
