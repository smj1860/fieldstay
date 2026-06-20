-- Extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Enums
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'support_category') THEN
    CREATE TYPE support_category AS ENUM ('faq', 'technical', 'account_specific');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'support_message_role') THEN
    CREATE TYPE support_message_role AS ENUM ('user', 'assistant');
  END IF;
END $$;

-- Knowledge base chunks — platform-wide, NOT tenant-scoped
-- embedding is nullable; stays NULL until Phase 2's ingestion pipeline runs.
-- Dimension 1536 is a placeholder assumption.
CREATE TABLE IF NOT EXISTS support_kb_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  embedding   VECTOR(1536),
  source      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Conversations
CREATE TABLE IF NOT EXISTS support_conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_conversations_org  ON support_conversations(org_id);
CREATE INDEX IF NOT EXISTS idx_support_conversations_user ON support_conversations(user_id);

-- Messages
CREATE TABLE IF NOT EXISTS support_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  role            support_message_role NOT NULL,
  content         TEXT NOT NULL,
  category        support_category,
  model_used      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON support_messages(conversation_id);

-- RLS
ALTER TABLE support_kb_chunks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages      ENABLE ROW LEVEL SECURITY;

-- KB chunks are not tenant data — any authenticated user may read them.
CREATE POLICY "authenticated users read kb chunks"
  ON support_kb_chunks FOR SELECT
  TO authenticated
  USING (true);

-- Conversations strictly scoped to the owning user + org.
CREATE POLICY "org members access own conversations"
  ON support_conversations FOR ALL
  USING (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid())
  )
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid())
  );

-- Messages scoped via parent conversation ownership
CREATE POLICY "org members access own conversation messages"
  ON support_messages FOR ALL
  USING (
    conversation_id IN (
      SELECT id FROM support_conversations
      WHERE user_id = auth.uid()
        AND org_id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid())
    )
  )
  WITH CHECK (
    conversation_id IN (
      SELECT id FROM support_conversations
      WHERE user_id = auth.uid()
        AND org_id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid())
    )
  );

-- Seed placeholder KB content so the pipeline is testable before Phase 2
INSERT INTO support_kb_chunks (title, content, source) VALUES
  ('Supported integrations', 'FieldStay currently integrates with OwnerRez, with Hospitable and Lodgify integrations in progress. Reach out to support if you need a different PMS connected.', 'placeholder'),
  ('Pricing tiers', 'FieldStay pricing: Starter $199/mo (1-15 properties), Growth $379/mo (16-50), Portfolio $599/mo (51-100), Enterprise custom for 100+. RepuGuard reputation monitoring is bundled into every tier.', 'placeholder'),
  ('Turnover management', 'Turnovers are created automatically from synced bookings. Crew members can be assigned individually or in bulk from the Turnover Board, and marking a turnover complete updates the cleaning status and notifies the property manager.', 'placeholder'),
  ('Getting help', 'For anything not covered here, ask and I will let you know if this needs to go to a human — just say so and I will flag it for the support team.', 'placeholder');

-- Index deferred to Phase 2 once embeddings are populated.
