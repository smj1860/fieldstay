-- Task 7: Dedup inventory_items from repeated saves
--
-- Multiple identical saves during testing produced duplicate inventory_items
-- rows landing all at once. Diagnostic confirmed 47 duplicate (property_id, name)
-- groups before cleanup (35 groups x7 rows on one property, 12 groups x2-3 rows
-- on another) with no tied updated_at timestamps within any group, so a strict
-- "keep most recently updated" delete is unambiguous.

DELETE FROM inventory_items a
USING inventory_items b
WHERE a.property_id = b.property_id
  AND a.name = b.name
  AND a.id <> b.id
  AND a.updated_at < b.updated_at;
