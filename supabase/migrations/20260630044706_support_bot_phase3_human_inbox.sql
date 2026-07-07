
-- ─────────────────────────────────────────────────────────────────────────────
-- Support Bot Phase 3 — Human Inbox & Escalation
--
-- Adds the ability for FieldStay founder/staff to see all conversations across
-- every org, get flagged when a conversation needs human attention, and inject
-- replies directly into the chat thread.
-- ─────────────────────────────────────────────────────────────────────────────

-- 'human' role lets staff replies render distinctly from bot/user messages
ALTER TYPE support_message_role ADD VALUE IF NOT EXISTS 'human';

-- ── support_conversations: escalation + assignment state ──────────────────────
ALTER TABLE support_conversations
  ADD COLUMN IF NOT EXISTS needs_human       BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS escalation_reason  TEXT,
  ADD COLUMN IF NOT EXISTS escalated_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_staff_id   UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS staff_notified_at   TIMESTAMPTZ;

-- Index for the inbox view — escalated + open conversations sort to the top
CREATE INDEX IF NOT EXISTS idx_support_conversations_needs_human
  ON support_conversations(needs_human, last_message_at DESC)
  WHERE needs_human = true;

CREATE INDEX IF NOT EXISTS idx_support_conversations_status_recent
  ON support_conversations(status, last_message_at DESC);

-- ── support_messages: track who sent a human reply ────────────────────────────
ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS sent_by_user_id UUID REFERENCES auth.users(id);

-- ── platform_staff: who is allowed to see the cross-org inbox ─────────────────
-- This is intentionally separate from organization_members — inbox access is
-- platform-level (FieldStay staff), not org-scoped like everything else in
-- the schema. Only rows in this table can read across all orgs' conversations.
CREATE TABLE IF NOT EXISTS platform_staff (
  user_id     UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL DEFAULT 'support' CHECK (role IN ('support', 'admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_staff ENABLE ROW LEVEL SECURITY;

-- Staff can see their own row (used to check "am I staff" client-side)
CREATE POLICY "platform_staff_self_select" ON platform_staff
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- No client-side writes — staff are added via direct migration/service role only
CREATE POLICY "platform_staff_restrict_write" ON platform_staff
  FOR ALL USING (false) WITH CHECK (false);

-- ── Helper function: is the current user platform staff? ──────────────────────
CREATE OR REPLACE FUNCTION is_platform_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_staff WHERE user_id = (SELECT auth.uid())
  );
$$;

-- ── RLS: platform staff can read ALL conversations and messages ───────────────
-- This is the cross-tenant exception by design — staff need visibility across
-- every org to operate the inbox. Scoped strictly to SELECT, never write,
-- and gated entirely behind the platform_staff table above.
CREATE POLICY "support_conversations_staff_select" ON support_conversations
  FOR SELECT USING (is_platform_staff());

CREATE POLICY "support_messages_staff_select" ON support_messages
  FOR SELECT USING (is_platform_staff());

-- Staff can insert human replies — service-role validated via the staff
-- reply API route, not directly from the client
CREATE POLICY "support_messages_staff_insert" ON support_messages
  FOR INSERT WITH CHECK (is_platform_staff());

-- Staff can update conversation state (resolve, assign, etc.)
CREATE POLICY "support_conversations_staff_update" ON support_conversations
  FOR UPDATE USING (is_platform_staff()) WITH CHECK (is_platform_staff());
