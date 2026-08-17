-- 20260817172700_notifications_dedupe_key_plain_unique_index.sql
-- ============================================================================
-- THE SAME 42P10 DEFECT AS THE PUSH ROUTES, in the notification-bell writer.
-- Found by the new check 14 in scripts/check-db-invariants.mjs while fixing
-- 20260817172241 — not by Sentry, and not reported by anyone.
--
-- createPmNotifications() (lib/inngest/helpers.ts, the BATCH writer) upserts
-- with `onConflict: 'dedupe_key', ignoreDuplicates: true`. The only unique index
-- on that column was PARTIAL — `WHERE dedupe_key IS NOT NULL` — and Postgres
-- can use a partial index as an ON CONFLICT arbiter only when the statement
-- repeats its predicate, which Supabase JS's `onConflict` cannot express. So
-- every batched notification carrying a dedupe key raised 42P10 and was lost.
-- Verified against production: the exact statement threw, and succeeds now.
--
-- The single-row createPmNotification() was unaffected — it uses a plain
-- .insert() and catches 23505.
--
-- That function's own comment reasoned about the partial index:
--
--     "Rows WITHOUT a dedupe key are inserted separately, because the partial
--      unique index only covers `dedupe_key IS NOT NULL` — an ON CONFLICT
--      naming that column cannot arbitrate rows the index does not contain."
--
-- Correct about the split, and it is kept. What it missed is that ON CONFLICT
-- could not name that index for the rows it DOES contain either. The comment has
-- been corrected in place.
--
-- WHY PLAIN IS EQUIVALENT
--
-- NULLS DISTINCT is the default for unique indexes (still true in PG15+), so a
-- plain UNIQUE (dedupe_key) permits unlimited NULL rows — exactly what the
-- partial predicate achieved by excluding them. Verified against production
-- inside a rolled-back transaction: a repeated dedupe key collapsed to one row
-- via DO NOTHING, and two NULL dedupe keys coexisted.
--
-- db_invariant_report()'s dedup_columns_without_unique_index check accepts a
-- plain unique, so that gate is unaffected.
-- ============================================================================

DROP INDEX IF EXISTS public.notifications_dedupe_key_idx;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_idx
  ON public.notifications (dedupe_key);

COMMENT ON INDEX public.notifications_dedupe_key_idx IS
  'PLAIN, not partial, so ON CONFLICT (dedupe_key) can name it as an arbiter. A partial index needs the statement to repeat its predicate, which Supabase JS onConflict cannot express — createPmNotifications() batch upserts were throwing 42P10. NULLs are distinct in a unique index, so rows with a NULL dedupe_key still never collide.';
