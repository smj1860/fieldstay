
-- ============================================================
-- MAINTENANCE STANDARD TEMPLATE — SCHEMA EXTENSIONS
-- ============================================================

-- ─── 1a. Extend maintenance_schedule_template_items ───────────────────────
ALTER TABLE maintenance_schedule_template_items
  ADD COLUMN IF NOT EXISTS asset_category    TEXT,
  ADD COLUMN IF NOT EXISTS active_from_month INTEGER CHECK (active_from_month BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS active_to_month   INTEGER CHECK (active_to_month   BETWEEN 1 AND 12);

COMMENT ON COLUMN maintenance_schedule_template_items.active_from_month IS
  'Start month of active window (1=Jan). NULL = active all year. Supports year-wrap (e.g. 11→3 = Nov–Mar).';
COMMENT ON COLUMN maintenance_schedule_template_items.active_to_month IS
  'End month of active window (1=Jan). NULL = active all year.';
COMMENT ON COLUMN maintenance_schedule_template_items.asset_category IS
  'Asset ledger category this item links to.';

-- ─── 1b. Extend maintenance_schedules ─────────────────────────────────────
-- next_due_date, is_active, updated_at already exist — use IF NOT EXISTS
ALTER TABLE maintenance_schedules
  ADD COLUMN IF NOT EXISTS active_from_month         INTEGER CHECK (active_from_month BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS active_to_month           INTEGER CHECK (active_to_month   BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS asset_category            TEXT,
  ADD COLUMN IF NOT EXISTS is_from_standard_template BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_template_item_id   UUID REFERENCES maintenance_schedule_template_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_catalog_item_id    UUID;

CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_property_due
  ON maintenance_schedules (property_id, next_due_date)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_org_due
  ON maintenance_schedules (org_id, next_due_date)
  WHERE is_active = true;

-- updated_at trigger (only if set_updated_at function exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'maintenance_schedules_updated_at'
    ) THEN
      EXECUTE '
        CREATE TRIGGER maintenance_schedules_updated_at
          BEFORE UPDATE ON maintenance_schedules
          FOR EACH ROW EXECUTE FUNCTION set_updated_at()
      ';
    END IF;
  END IF;
END $$;

-- ─── 1c. Create maintenance_catalog_items ─────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_catalog_items (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT        NOT NULL,
  category             TEXT        NOT NULL,
  suggested_recurrence TEXT,
  asset_category       TEXT,
  description          TEXT,
  sort_order           INTEGER     NOT NULL DEFAULT 0,
  is_active            BOOLEAN     NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE maintenance_catalog_items IS
  'Global catalog of optional per-property maintenance items. Not org-scoped. Read by all authenticated users.';

ALTER TABLE maintenance_catalog_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "catalog_items_authenticated_read" ON maintenance_catalog_items
  FOR SELECT USING (auth.uid() IS NOT NULL AND is_active = true);

CREATE POLICY "catalog_items_service_role" ON maintenance_catalog_items
  TO service_role USING (true) WITH CHECK (true);

-- ─── 1d. Create maintenance_completions ───────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_completions (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  maintenance_schedule_id UUID        NOT NULL REFERENCES maintenance_schedules(id) ON DELETE CASCADE,
  property_id             UUID        NOT NULL REFERENCES properties(id)            ON DELETE CASCADE,
  org_id                  UUID        NOT NULL REFERENCES organizations(id)         ON DELETE CASCADE,
  asset_category          TEXT,
  completed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_by            UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  notes                   TEXT,
  work_order_id           UUID,
  next_due_date_set       DATE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maintenance_completions_schedule
  ON maintenance_completions (maintenance_schedule_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_completions_property
  ON maintenance_completions (property_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_completions_asset
  ON maintenance_completions (org_id, asset_category, completed_at DESC)
  WHERE asset_category IS NOT NULL;

ALTER TABLE maintenance_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "maintenance_completions_select" ON maintenance_completions
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "maintenance_completions_insert" ON maintenance_completions
  FOR INSERT WITH CHECK (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "maintenance_completions_update" ON maintenance_completions
  FOR UPDATE USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY "maintenance_completions_delete" ON maintenance_completions
  FOR DELETE USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY "maintenance_completions_service" ON maintenance_completions
  TO service_role USING (true) WITH CHECK (true);
