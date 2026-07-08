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
-- Schema history gap fill — columns and tables that exist in the live DB
-- but were never explicitly tracked in this repo's migration history.
-- All statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so they are
-- safe no-ops if the objects already exist.

-- ── org_milestones: ensure RLS is enabled (belt-and-suspenders) ───────────────
ALTER TABLE public.org_milestones ENABLE ROW LEVEL SECURITY;

-- ── audit_events: canonical create (idempotent) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_id    uuid,
  action      text        NOT NULL,
  target_type text,
  target_id   uuid,
  metadata    jsonb,
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_org_id    ON public.audit_events(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created   ON public.audit_events(created_at);

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

-- Policy: owners-only SELECT (already in rls_hardening.sql but idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_events' AND policyname = 'audit_events_select'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "audit_events_select"
        ON public.audit_events FOR SELECT
        USING (
          org_id IS NOT NULL
          AND is_org_member(org_id, ARRAY['owner'::member_role])
        )
    $p$;
  END IF;
END;
$$;

-- ── owner_transactions: add any missing columns ───────────────────────────────
ALTER TABLE public.owner_transactions
  ADD COLUMN IF NOT EXISTS source               text,
  ADD COLUMN IF NOT EXISTS source_reference_id  text,
  ADD COLUMN IF NOT EXISTS visible_to_owner     boolean NOT NULL DEFAULT true;

-- ── owner_portal_tokens: add revoked_at ───────────────────────────────────────
ALTER TABLE public.owner_portal_tokens
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_owner_portal_revoked
  ON public.owner_portal_tokens(revoked_at)
  WHERE revoked_at IS NOT NULL;

-- ── properties: add cleaning_cost_visible_to_owner ───────────────────────────
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS cleaning_cost_visible_to_owner boolean NOT NULL DEFAULT true;

-- ── work_orders: add category if missing ─────────────────────────────────────
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS category wo_category;

-- ── inventory_count_drafts + items ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inventory_count_drafts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id     uuid        NOT NULL REFERENCES public.properties(id)    ON DELETE CASCADE,
  crew_member_id  uuid        REFERENCES public.crew_members(id)           ON DELETE SET NULL,
  status          text        NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','rejected')),
  submitted_at    timestamptz,
  reviewed_at     timestamptz,
  reviewed_by     uuid,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.inventory_count_draft_items (
  id                  uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id            uuid    NOT NULL REFERENCES public.inventory_count_drafts(id) ON DELETE CASCADE,
  inventory_item_id   uuid    NOT NULL REFERENCES public.inventory_items(id)        ON DELETE CASCADE,
  previous_quantity   integer NOT NULL DEFAULT 0,
  submitted_quantity  integer NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE public.inventory_count_drafts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_count_draft_items ENABLE ROW LEVEL SECURITY;

-- Draft SELECT: any org member can see their org's drafts
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inventory_count_drafts' AND policyname = 'drafts_select'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "drafts_select"
        ON public.inventory_count_drafts FOR SELECT
        USING (org_id IN (SELECT get_user_org_ids()))
    $p$;
  END IF;
END;
$$;

-- Draft write: crew can INSERT their own draft; admin/manager can UPDATE (approve/reject)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inventory_count_drafts' AND policyname = 'drafts_insert'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "drafts_insert"
        ON public.inventory_count_drafts FOR INSERT
        WITH CHECK (org_id IN (SELECT get_user_org_ids()))
    $p$;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inventory_count_drafts' AND policyname = 'drafts_manage'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "drafts_manage"
        ON public.inventory_count_drafts FOR UPDATE
        USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
        WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    $p$;
  END IF;
END;
$$;

-- Draft items: follow draft's org scope
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inventory_count_draft_items' AND policyname = 'draft_items_select'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "draft_items_select"
        ON public.inventory_count_draft_items FOR SELECT
        USING (
          draft_id IN (
            SELECT id FROM public.inventory_count_drafts
            WHERE org_id IN (SELECT get_user_org_ids())
          )
        )
    $p$;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inventory_count_draft_items' AND policyname = 'draft_items_insert'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "draft_items_insert"
        ON public.inventory_count_draft_items FOR INSERT
        WITH CHECK (
          draft_id IN (
            SELECT id FROM public.inventory_count_drafts
            WHERE org_id IN (SELECT get_user_org_ids())
          )
        )
    $p$;
  END IF;
END;
$$;
