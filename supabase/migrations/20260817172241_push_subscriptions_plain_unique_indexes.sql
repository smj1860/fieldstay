-- 20260817172241_push_subscriptions_plain_unique_indexes.sql
-- ============================================================================
-- FIXES A LIVE PRODUCTION OUTAGE: push notification opt-in has been failing
-- with Postgres 42P10 for EVERY user, crew and PM alike, since
-- 20260620154807_push_subscriptions_rls_and_manager_schema.sql landed.
-- public.push_subscriptions held ZERO rows in production when this was written
-- — nobody had ever successfully subscribed.
--
-- WHAT BROKE
--
-- That June migration dropped the plain table constraint
-- push_subscriptions_crew_member_id_endpoint_key and replaced it with two
-- PARTIAL unique indexes:
--
--   (crew_member_id, endpoint) WHERE crew_member_id IS NOT NULL
--   (user_id,        endpoint) WHERE user_id        IS NOT NULL
--
-- Both routes still upsert with a bare column list:
--   .upsert(..., { onConflict: 'crew_member_id,endpoint' })
--
-- Postgres can use a PARTIAL index as an ON CONFLICT arbiter only when the
-- statement supplies the matching index_predicate — `ON CONFLICT (cols) WHERE
-- <predicate>`. Supabase JS's `onConflict` option takes a column list and
-- cannot express a predicate, so the generated statement names an arbiter that
-- does not exist and Postgres raises 42P10 ("there is no unique or exclusion
-- constraint matching the ON CONFLICT specification").
--
-- WHY PLAIN INDEXES RATHER THAN AN RPC
--
-- The partial predicates are FUNCTIONALLY REDUNDANT. Postgres treats NULLs as
-- distinct in a unique index (NULLS DISTINCT is still the default in PG15+),
-- so a plain UNIQUE (crew_member_id, endpoint) already permits any number of
-- rows with a NULL crew_member_id — exactly what `WHERE crew_member_id IS NOT
-- NULL` achieved by excluding them. Enforcement is identical; the partial
-- version is merely a smaller index, and that saving cost the whole feature.
--
-- So this restores the pre-June arbiter shape without changing what is
-- enforced, and needs no application change. It is also the more robust fix:
-- `.upsert()` is the idiom every writer reaches for, and an RPC would leave the
-- next person's `.upsert()` broken again.
--
-- SAFE TO RUN: the plain index is always creatable here — a duplicate group
-- would need two rows sharing a NON-NULL (crew_member_id, endpoint), which the
-- partial index being replaced already forbade. Verified 0 duplicate groups on
-- both projects before applying, and the resulting ON CONFLICT was exercised
-- against production inside a rolled-back transaction: insert, then re-subscribe
-- the same endpoint, which UPDATED rather than duplicating.
--
-- NOT FIXED HERE: app/actions/work-order-public.ts upserts vendors with
-- `onConflict: 'org_id,email'`, whose only matching unique index is on the
-- EXPRESSION (org_id, lower(email)) and is also partial. A bare column list
-- cannot name an expression index either, so that call has the same 42P10
-- defect and needs a different remedy (normalize email on write, or an RPC).
-- Left COUNTED, not suppressed — see check 14 in scripts/check-db-invariants.mjs
-- and its shrink-only allowlist.
-- ============================================================================

DROP INDEX IF EXISTS public.push_subscriptions_crew_endpoint_key;
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_crew_endpoint_key
  ON public.push_subscriptions (crew_member_id, endpoint);

-- Broken identically since June, but invisible: the dashboard route logged the
-- failure with console.error instead of reporting it, so unlike the crew route
-- it never raised a Sentry issue. Two months of silent failure.
DROP INDEX IF EXISTS public.push_subscriptions_user_endpoint_key;
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_user_endpoint_key
  ON public.push_subscriptions (user_id, endpoint);

-- ============================================================================
-- Introspection for CI check 14.
--
-- Returns every UNIQUE index in `public` with the two properties that decide
-- whether a bare `onConflict` column list can name it as an arbiter: whether it
-- is partial, and whether any key is an expression rather than a plain column.
-- Only KEY columns are reported — a covering INCLUDE column cannot serve as an
-- arbiter.
--
-- Catalog-only: no DDL, no DML, and it never reads a table's rows, so it is
-- safe to point at production.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.unique_index_shapes()
RETURNS TABLE (
  table_name    text,
  index_name    text,
  key_columns   text[],
  is_partial    boolean,
  has_expression boolean
)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $fn$
  SELECT
    c.relname::text AS table_name,
    i.relname::text AS index_name,
    array_remove(array_agg(a.attname::text ORDER BY k.ord), NULL) AS key_columns,
    (x.indpred IS NOT NULL) AS is_partial,
    (x.indexprs IS NOT NULL) AS has_expression
  FROM pg_catalog.pg_index x
  JOIN pg_catalog.pg_class     i ON i.oid = x.indexrelid
  JOIN pg_catalog.pg_class     c ON c.oid = x.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL unnest(x.indkey[0:x.indnkeyatts - 1]) WITH ORDINALITY AS k(attnum, ord)
  LEFT JOIN pg_catalog.pg_attribute a
         ON a.attrelid = x.indrelid AND a.attnum = k.attnum
  WHERE n.nspname = 'public'
    AND x.indisunique
    AND c.relkind = 'r'
  GROUP BY c.relname, i.relname, x.indpred, x.indexprs
$fn$;

REVOKE ALL     ON FUNCTION public.unique_index_shapes() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.unique_index_shapes() TO service_role;

COMMENT ON FUNCTION public.unique_index_shapes() IS
  'Catalog-only. Every public UNIQUE index with is_partial/has_expression, so CI can verify each .upsert() onConflict column list has a namable arbiter.';
