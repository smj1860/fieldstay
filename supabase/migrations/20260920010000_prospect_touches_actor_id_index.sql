-- prospect_touches.actor_id (FK to auth.users) had no covering index —
-- caught by check-db-invariants.mjs's unindexed-FK check: without one, every
-- DELETE/UPDATE on auth.users sequential-scans prospect_touches to enforce
-- the FK's ON DELETE SET NULL. Small table today, but the fix belongs in the
-- schema regardless of current size — the check doesn't grade on row count.

CREATE INDEX IF NOT EXISTS prospect_touches_actor_id_idx
  ON public.prospect_touches (actor_id);
