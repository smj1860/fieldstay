
-- The two existing partial indexes on (external_id, external_source)
-- cannot serve as ON CONFLICT targets because they have WHERE clauses.
-- PostgreSQL requires an unconditional unique constraint for upsert resolution.
-- We drop both partial indexes and add a proper unique constraint.
-- Rows where external_id IS NULL are manual properties and will never
-- conflict — the constraint only fires when both columns are non-null,
-- which is the only case the upsert cares about.

DROP INDEX IF EXISTS idx_properties_external_source;
DROP INDEX IF EXISTS properties_external_id_source_idx;

-- Full unconditional unique constraint — ON CONFLICT can now resolve against it.
-- NULL values in either column are excluded from uniqueness checks by
-- SQL standard (NULLs are never equal), so manual properties are unaffected.
ALTER TABLE properties
  ADD CONSTRAINT uq_properties_external_id_source
  UNIQUE (external_id, external_source);
