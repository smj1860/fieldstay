-- Reconciliation capture (Task 4, migration drift): this index already
-- exists live under version 20260725215844 with no matching local file —
-- captured verbatim from pg_indexes so the local tree reflects live schema.
CREATE INDEX IF NOT EXISTS idx_inventory_count_drafts_reviewed_by
  ON public.inventory_count_drafts USING btree (reviewed_by);
