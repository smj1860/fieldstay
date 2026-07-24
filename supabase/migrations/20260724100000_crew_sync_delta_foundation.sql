-- ============================================================================
-- Crew PWA sync v2 — Phase 1: delta-sync foundation
--
-- 1) BUG FIX: property_assets has an updated_at column but never got a
--    set_updated_at touch trigger (every other synced table has one), so
--    its updated_at freezes at insert time and is useless as a change
--    cursor. Fixed here so future cursor-based sync (and anything else)
--    can trust it.
--
-- 2) Partial indexes on updated_at for the tables the crew PWA delta-pulls
--    with `.gt('updated_at', cursor)` scoped to an id/turnover_id list.
--    Plain b-tree on updated_at alone: the delta filter is always paired
--    with an indexed id-list predicate, so the planner can pick whichever
--    is more selective.
-- ============================================================================

-- 1) property_assets touch trigger (idempotent: drop-if-exists then create)
DROP TRIGGER IF EXISTS property_assets_updated_at ON property_assets;
CREATE TRIGGER property_assets_updated_at
  BEFORE UPDATE ON property_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2) delta-pull indexes
CREATE INDEX IF NOT EXISTS idx_turnovers_updated_at
  ON turnovers (updated_at);
CREATE INDEX IF NOT EXISTS idx_checklist_instances_updated_at
  ON checklist_instances (updated_at);
CREATE INDEX IF NOT EXISTS idx_checklist_instance_items_updated_at
  ON checklist_instance_items (updated_at);
CREATE INDEX IF NOT EXISTS idx_work_orders_updated_at
  ON work_orders (updated_at);
