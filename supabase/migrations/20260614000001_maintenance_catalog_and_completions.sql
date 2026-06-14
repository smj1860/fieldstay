-- Migration: maintenance_catalog_items + maintenance_completions tables
-- Applied directly to vpmznjktllhmmbfnxuvk in commit 6314b3d.
-- This file records that schema change in the local migration history.
-- All statements use IF NOT EXISTS / IF EXISTS so re-applying is safe.

-- ── Columns added to maintenance_schedule_template_items ──────────────────────
ALTER TABLE public.maintenance_schedule_template_items
  ADD COLUMN IF NOT EXISTS asset_category    text,
  ADD COLUMN IF NOT EXISTS active_from_month integer CHECK (active_from_month BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS active_to_month   integer CHECK (active_to_month   BETWEEN 1 AND 12);

-- ── Columns added to maintenance_schedules ───────────────────────────────────
ALTER TABLE public.maintenance_schedules
  ADD COLUMN IF NOT EXISTS active_from_month         integer,
  ADD COLUMN IF NOT EXISTS active_to_month           integer,
  ADD COLUMN IF NOT EXISTS asset_category            text,
  ADD COLUMN IF NOT EXISTS is_from_standard_template boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_template_item_id   uuid
    REFERENCES public.maintenance_schedule_template_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_catalog_item_id    uuid;

-- Partial indexes on next_due_date for active schedules
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_property_due
  ON public.maintenance_schedules (property_id, next_due_date)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_org_due
  ON public.maintenance_schedules (org_id, next_due_date)
  WHERE is_active = true;

-- ── maintenance_catalog_items ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.maintenance_catalog_items (
  id                   uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name                 text        NOT NULL,
  category             text        NOT NULL,
  suggested_recurrence text,
  asset_category       text,
  description          text,
  sort_order           integer     NOT NULL DEFAULT 0,
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.maintenance_catalog_items ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read active catalog items (used in onboarding + PM modals)
CREATE POLICY IF NOT EXISTS "catalog_items_authenticated_read"
  ON public.maintenance_catalog_items
  FOR SELECT USING (auth.uid() IS NOT NULL AND is_active = true);

-- Service role has full access for seeding and admin operations
CREATE POLICY IF NOT EXISTS "catalog_items_service_role"
  ON public.maintenance_catalog_items
  TO service_role USING (true) WITH CHECK (true);

-- ── maintenance_completions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.maintenance_completions (
  id                      uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  maintenance_schedule_id uuid        NOT NULL,
  property_id             uuid        NOT NULL,
  org_id                  uuid        NOT NULL,
  asset_category          text,
  completed_at            timestamptz NOT NULL DEFAULT now(),
  completed_by            uuid,
  notes                   text,
  work_order_id           uuid,
  next_due_date_set       date,
  created_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.maintenance_completions ENABLE ROW LEVEL SECURITY;

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_maintenance_completions_schedule
  ON public.maintenance_completions (maintenance_schedule_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_completions_property
  ON public.maintenance_completions (property_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_completions_asset
  ON public.maintenance_completions (org_id, asset_category, completed_at DESC)
  WHERE asset_category IS NOT NULL;

-- RLS policies
CREATE POLICY IF NOT EXISTS "maintenance_completions_select"
  ON public.maintenance_completions
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY IF NOT EXISTS "maintenance_completions_insert"
  ON public.maintenance_completions
  FOR INSERT WITH CHECK (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY IF NOT EXISTS "maintenance_completions_update"
  ON public.maintenance_completions
  FOR UPDATE USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY IF NOT EXISTS "maintenance_completions_delete"
  ON public.maintenance_completions
  FOR DELETE USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY IF NOT EXISTS "maintenance_completions_service"
  ON public.maintenance_completions
  TO service_role USING (true) WITH CHECK (true);
