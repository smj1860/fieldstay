
-- ============================================================
-- 1a. Add missing columns to inventory_template_items
-- ============================================================
ALTER TABLE inventory_template_items
  ADD COLUMN IF NOT EXISTS unit      text    NOT NULL DEFAULT 'units',
  ADD COLUMN IF NOT EXISTS par_level integer NOT NULL DEFAULT 1;

-- ============================================================
-- 1b. Create org_master_checklist_items table
-- ============================================================
CREATE TABLE IF NOT EXISTS org_master_checklist_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  section    text NOT NULL,
  task       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  source     text NOT NULL DEFAULT 'catalog',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_master_checklist_org_id
  ON org_master_checklist_items(org_id);

CREATE OR REPLACE TRIGGER org_master_checklist_items_updated_at
  BEFORE UPDATE ON org_master_checklist_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE org_master_checklist_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'org_master_checklist_items'
      AND policyname = 'Admins and managers manage master checklist'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Admins and managers manage master checklist"
        ON org_master_checklist_items FOR ALL
        USING (is_org_member(org_id, ARRAY['admin','manager','owner']::member_role[]))
    $pol$;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.org_master_checklist_items TO anon, authenticated;

-- ============================================================
-- 1c. Fix communication_logs RLS
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'communication_logs'
      AND policyname = 'Org members can view communication logs'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Org members can view communication logs"
        ON communication_logs FOR SELECT
        USING (org_id IN (SELECT get_user_org_ids()))
    $pol$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'communication_logs'
      AND policyname = 'Admins and managers can log communications'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Admins and managers can log communications"
        ON communication_logs FOR INSERT
        WITH CHECK (is_org_member(org_id, ARRAY['admin','manager','owner']::member_role[]))
    $pol$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'communication_logs'
      AND policyname = 'Admins and managers manage communication logs'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Admins and managers manage communication logs"
        ON communication_logs FOR ALL
        USING (is_org_member(org_id, ARRAY['admin','manager','owner']::member_role[]))
    $pol$;
  END IF;
END $$;

-- ============================================================
-- 1d. Fix property_owners RLS
-- ============================================================
DROP POLICY IF EXISTS "Admins and managers manage property owners"
  ON property_owners;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'property_owners'
      AND policyname = 'Admins managers owners manage property owners'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Admins managers owners manage property owners"
        ON property_owners FOR ALL
        USING (is_org_member(org_id, ARRAY['admin','manager','owner']::member_role[]))
    $pol$;
  END IF;
END $$;

-- ============================================================
-- 1e. Add org_master_maintenance_schedules table
-- ============================================================
CREATE TABLE IF NOT EXISTS org_master_maintenance_schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text,
  frequency     text NOT NULL DEFAULT 'monthly',
  month_day     integer,
  week_day      integer,
  estimated_cost numeric(10,2),
  specialty     text,
  notes         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_master_maintenance_org_id
  ON org_master_maintenance_schedules(org_id);

CREATE OR REPLACE TRIGGER org_master_maintenance_updated_at
  BEFORE UPDATE ON org_master_maintenance_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE org_master_maintenance_schedules ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'org_master_maintenance_schedules'
      AND policyname = 'Admins managers owners manage master maintenance'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Admins managers owners manage master maintenance"
        ON org_master_maintenance_schedules FOR ALL
        USING (is_org_member(org_id, ARRAY['admin','manager','owner']::member_role[]))
    $pol$;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.org_master_maintenance_schedules TO anon, authenticated;

-- ============================================================
-- Vendor star rating columns (Task 5)
-- ============================================================
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS avg_rating   numeric(3,2),
  ADD COLUMN IF NOT EXISTS rating_count integer NOT NULL DEFAULT 0;

-- ============================================================
-- Org onboarding tracking (Task 7b)
-- ============================================================
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS onboarding_steps_completed
    jsonb NOT NULL DEFAULT '{}';
