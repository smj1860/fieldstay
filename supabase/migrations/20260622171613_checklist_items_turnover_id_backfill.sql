-- Backfill turnover_id on checklist_instance_items from parent checklist_instances
UPDATE checklist_instance_items ci
SET turnover_id = ch.turnover_id
FROM checklist_instances ch
WHERE ci.instance_id = ch.id
  AND ci.turnover_id IS NULL;
