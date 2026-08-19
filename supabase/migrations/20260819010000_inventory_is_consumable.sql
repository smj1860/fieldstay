-- 20260819010000_inventory_is_consumable.sql
-- ============================================================================
-- DURABLE vs CONSUMABLE, so "at par" can mean the right thing.
--
-- Par means two different things depending on the item:
--
--   * consumable (toilet paper, dish soap, Swiffer refills) — par is a REORDER
--     POINT. Sitting exactly on it means the next turnover takes you under.
--   * durable (mattress protector, broom, coffee maker, pillows) — par is a
--     COMPLETE SET. One broom per property IS the permanent correct state.
--
-- Without the distinction every durable sat permanently in the warning band:
-- 69 of one org's items were exactly at par, which was most of what the amber
-- badge was showing. A warning that never clears is not a warning.
--
-- ── Why a real column and not a rule derived from category or unit ──────────
--
-- Both were checked against the live catalog and both are wrong:
--
--   category  'cleaning' holds Swiffer Mop (durable) AND Swiffer Refills
--             (consumable); 'kitchen' holds Coffee Maker / Keurig AND Coffee
--             Filters. The axis simply is not category.
--   unit      a good correlation — durables are mostly 'each' — but Sponges,
--             Trash Bags - Large and Vacuum Bags or Filters are all 'each' and
--             all consumable. Deriving from unit would paint those green at
--             par, which is the one direction that costs you: green means
--             "no action needed" and you run out.
--
-- ── DEFAULT TRUE is the safe direction ─────────────────────────────────────
--
-- Unclassified means consumable. An unclassified durable shows yellow at par
-- (mild noise, self-correcting once someone flags it); an unclassified
-- consumable showing green at par is a stockout nobody was warned about. So
-- every item starts consumable and is corrected upward, never the reverse.
--
-- ── SCHEMA ONLY, deliberately ───────────────────────────────────────────────
--
-- No rows are classified here. Which of the 157 platform catalog items are
-- durable is an operational judgment — roughly 30 of them are genuinely
-- arguable (is a Thermacell a device or a refill? are dish cloths laundered or
-- binned?) — and that belongs to the operator, not to whoever wrote this file.
-- The classification lands as its own data migration so it is reviewable as
-- data, and so a later correction is a diff against a list rather than an
-- archaeology exercise against this comment.
-- ============================================================================

ALTER TABLE inventory_catalog
  ADD COLUMN IF NOT EXISTS is_consumable boolean NOT NULL DEFAULT true;

ALTER TABLE org_inventory_catalog
  ADD COLUMN IF NOT EXISTS is_consumable boolean NOT NULL DEFAULT true;

-- Denormalised onto the property-level row for the same reason name, category,
-- unit and par_level already are: catalog_item_id is NULLABLE, so an item a PM
-- typed in themselves has no catalog row to join to, and the status
-- calculation still has to work for it.
ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS is_consumable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN inventory_catalog.is_consumable IS
  'False for equipment and linens — anything where par is a complete set rather '
  'than a reorder point. Drives the at-par colour: consumable at par is yellow '
  '(about to run short), durable at par is green (correctly stocked).';
COMMENT ON COLUMN org_inventory_catalog.is_consumable IS
  'See inventory_catalog.is_consumable.';
COMMENT ON COLUMN inventory_items.is_consumable IS
  'See inventory_catalog.is_consumable. Denormalised because catalog_item_id is '
  'nullable — a PM-created item has no catalog row to join to.';
