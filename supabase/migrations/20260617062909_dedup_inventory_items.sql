DELETE FROM inventory_items a
USING inventory_items b
WHERE a.property_id = b.property_id
  AND a.name = b.name
  AND a.id <> b.id
  AND a.updated_at < b.updated_at;
