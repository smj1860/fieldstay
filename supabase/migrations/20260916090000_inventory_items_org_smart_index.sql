-- ============================================================================
-- recomputeParLevels()'s item read (lib/inventory/recompute-par.ts) filters
--
--   .eq('org_id', orgId).eq('par_mode', 'smart').in('property_id', propertyIds)
--
-- and inventory_items had no index shaped for that at all — every recompute
-- (fired on every property save that touches bedrooms/bathrooms/max_guests,
-- every count that records a consumption sample) forced a sequential scan of
-- the whole table for every org, at every property count.
--
-- (org_id, property_id) matches the two EQUALITY/IN filters exactly, and
-- par_mode is a partial predicate rather than a leading column: it is a
-- constant ('smart') at every call site, never a range or a second filter
-- combined with property_id, so it belongs in the WHERE clause, not the key —
-- a partial index over just the smart rows is both smaller and a closer match
-- to the query the table actually serves. static-par items (the PM's own
-- number, never touched by a recompute) never enter this index at all.
--
-- CONCURRENTLY is why this file contains exactly ONE statement and nothing
-- else (no other DDL, not even a second CONCURRENTLY index): Postgres refuses
-- CREATE INDEX CONCURRENTLY inside a transaction block, and the CLI applies a
-- migration file as one simple-query message — sending more than one
-- statement in that message implicitly wraps them ALL in a transaction, which
-- would raise the same "cannot run inside a transaction block" error CONCUR-
-- RENTLY exists to avoid. One statement per file is what keeps this one
-- outside any transaction. It also builds without holding the write lock a
-- plain CREATE INDEX would — the whole reason to use it on a table this
-- codebase expects to reach 10M+ rows: a blocking build there would stall
-- every restock write for as long as it took to finish.
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_items_org_smart
  ON public.inventory_items (org_id, property_id)
  WHERE par_mode = 'smart';
