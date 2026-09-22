-- prospect_imports.imported_by (FK to auth.users) had no covering index —
-- the same miss 20260920010000_prospect_touches_actor_id_index.sql fixed on
-- the sibling table, caught the same way by check-db-invariants.mjs's
-- unindexed-FK check. Without one, every DELETE/UPDATE on auth.users
-- sequential-scans prospect_imports to enforce ON DELETE SET NULL.
--
-- Not partial, unlike prospect_accounts_import_idx: that column is NULL on
-- almost every row (only rows an import CREATED carry one), whereas
-- imported_by is set on every import row, so a WHERE clause would exclude
-- nothing and only make the index unusable for some plans.

CREATE INDEX IF NOT EXISTS prospect_imports_imported_by_idx
  ON public.prospect_imports (imported_by);
