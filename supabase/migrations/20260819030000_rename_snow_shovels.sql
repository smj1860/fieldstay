-- 20260819030000_rename_snow_shovels.sql
-- ============================================================================
-- "Snow Shovels & Ice Melt" -> "Snow Shovels". Ice melt is dropped, not split.
--
-- The row bundled a tool with a consumable, which made its stock level
-- meaningless: one 'each' could not answer "do we have shovels?" and "do we
-- have ice melt?" at the same time, and the durable/consumable flag added in
-- 20260819010000 has to be one or the other. The operator's decision is that
-- only the shovels are tracked, so the row becomes what it always effectively
-- was — a durable, already classified false by 20260819020000.
--
-- The DESCRIPTION is renamed with it. Leaving "Heavy-duty snow shovels and ice
-- melt bucket" under a row called "Snow Shovels" would put the ambiguity
-- straight back where anyone reading the catalog would find it.
--
-- ── Blast radius, checked before writing rather than assumed ────────────────
--
--   inventory_catalog            1 row
--   org_inventory_catalog        2 rows (the seeded org copies)
--   inventory_items              0 rows — no property stocks it
--   inventory_template_items     0 rows
--   purchase_order_items         0 rows — no history to rewrite
--
-- That last one matters: purchase_order_items.item_name is a HISTORICAL
-- record of what was ordered, and this migration deliberately does not touch
-- it. It happens to be empty for this item, but had it not been, the right
-- move would still have been to leave it — a past order said what it said.
--
-- No collision: neither inventory_catalog nor org_inventory_catalog has an
-- existing "Snow Shovels" row for any org, so the rename cannot violate a
-- (org_id, name) uniqueness constraint.
--
-- Idempotent: matches on the old name, so a replay after the rename is a no-op.
-- ============================================================================

UPDATE inventory_catalog
   SET name        = 'Snow Shovels',
       description = 'Heavy-duty snow shovels'
 WHERE name = 'Snow Shovels & Ice Melt';

UPDATE org_inventory_catalog
   SET name        = 'Snow Shovels',
       description = 'Heavy-duty snow shovels'
 WHERE name = 'Snow Shovels & Ice Melt';

-- Property-level rows denormalise the name at seed time. Zero today, but this
-- runs against every project and every future replay — leaving it out would
-- silently strand any row seeded between the classification migration and this
-- one under a name no catalog entry has any more.
UPDATE inventory_items
   SET name = 'Snow Shovels'
 WHERE name = 'Snow Shovels & Ice Melt';

UPDATE inventory_template_items
   SET name = 'Snow Shovels'
 WHERE name = 'Snow Shovels & Ice Melt';
