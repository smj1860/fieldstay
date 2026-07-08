-- ─────────────────────────────────────────────────────────────────────────
-- NOT RECORDED IN LIVE MIGRATION HISTORY: verified via Supabase MCP
-- list_migrations against project vpmznjktllhmmbfnxuvk on 2026-07-08 that
-- this file's version is absent from supabase_migrations.schema_migrations.
-- Spot-checking the schema objects it defines (tables, columns, indexes,
-- functions, policies, enum values, dropped objects) against the live
-- database confirms they already exist — this SQL was applied previously,
-- most likely by hand or under a different, already-tracked migration
-- timestamp, and this file is a historical/duplicate copy rather than a
-- pending change. Do not assume `supabase db push` needs to run it, and
-- verify against the live schema before treating it as authoritative —
-- some statements here (UPDATEs, INSERTs, ALTER TYPE ... ADD VALUE) are
-- not safely re-runnable if actually executed again.
-- ─────────────────────────────────────────────────────────────────────────
-- org_sms_templates
-- Stores per-org overrides for outbound SMS message bodies.
-- When present, these replace the hardcoded defaults in lib/sms/telnyx.ts.
-- Valid keys are enforced at the application layer (see SmsTemplateKey in templates.ts).

CREATE TABLE IF NOT EXISTS public.org_sms_templates (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key        text        NOT NULL,
  body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_sms_templates_org_key_unique UNIQUE (org_id, key)
);

ALTER TABLE public.org_sms_templates ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.org_sms_templates TO authenticated;

-- Admins and managers can read their org's templates
CREATE POLICY org_sms_templates_select ON public.org_sms_templates
  FOR SELECT TO authenticated
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- Admins and managers can write their org's templates
CREATE POLICY org_sms_templates_insert ON public.org_sms_templates
  FOR INSERT TO authenticated
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY org_sms_templates_update ON public.org_sms_templates
  FOR UPDATE TO authenticated
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY org_sms_templates_delete ON public.org_sms_templates
  FOR DELETE TO authenticated
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE INDEX IF NOT EXISTS idx_org_sms_templates_org_id ON public.org_sms_templates (org_id);
