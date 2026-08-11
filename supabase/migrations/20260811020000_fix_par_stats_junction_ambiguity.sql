-- Fix: 20260810214329_dynamic_par_engine_schema.sql broke every PostgREST
-- embed between inventory_items and properties.
--
-- inventory_consumption_stats was created with PRIMARY KEY (property_id,
-- inventory_item_id), where both columns are single-column foreign keys to
-- different tables. That is exactly PostgREST's signature for a many-to-many
-- JUNCTION table, so it began offering a second path between inventory_items
-- and properties on top of the existing inventory_items.property_id FK. Every
-- pre-existing embed became ambiguous and started returning
-- HTTP 300 / PGRST201 "Could not embed because more than one relationship was
-- found" — four live call sites: the inventory page, inventory/actions.ts,
-- lib/notifications.ts (the low-stock notification bell) and
-- lib/support/account-tools.ts. CI caught only the first, via
-- e2e/specs/07-inventory.spec.ts; the other three were broken in production
-- with nothing failing.
--
-- Verified empirically against a throwaway three-table fixture on the E2E
-- project rather than reasoned from the docs: a composite PK of exactly two
-- single-column FKs produces PGRST201, and replacing it with ANY other primary
-- key removes the detection. A UNIQUE constraint on the same pair does NOT
-- trigger it — the detection keys on the PRIMARY KEY specifically.
--
-- The fix is to drop property_id rather than to bolt on a surrogate PK:
-- inventory_items is already a property-level table, so
-- inventory_consumption_stats.property_id was derivable from
-- inventory_item_id and could drift out of agreement with it. Dropping it
-- makes the true grain — one rolling aggregate per property-level inventory
-- item — the primary key, and a single-column PK can never be read as a
-- junction, so this cannot regress on this table.
--
-- org_id STAYS. It is equally derivable but is load-bearing for the RLS
-- policy, which is a deliberate denormalization rather than an accident.
--
-- Both projects held 0 rows when this ran, so no data migration is needed.

-- ── Rebuild the key ─────────────────────────────────────────────────────────

ALTER TABLE public.inventory_consumption_stats
  DROP CONSTRAINT IF EXISTS inventory_consumption_stats_pkey;

-- Drops the column, its FK to properties, and idx_inventory_consumption_stats_
-- item_id's reason to exist in one step.
ALTER TABLE public.inventory_consumption_stats
  DROP COLUMN IF EXISTS property_id;

DO $$ BEGIN
  ALTER TABLE public.inventory_consumption_stats
    ADD CONSTRAINT inventory_consumption_stats_pkey
    PRIMARY KEY (inventory_item_id);
EXCEPTION WHEN invalid_table_definition THEN NULL; END $$;

-- inventory_item_id is now the PK's only column, so the PK index covers that
-- FK and this separate index is a duplicate. (org_id keeps its own index —
-- scripts/check-db-invariants.mjs requires a covering index on every FK
-- column, and org_id is still an FK.)
DROP INDEX IF EXISTS public.idx_inventory_consumption_stats_item_id;

-- ── Guardrail ───────────────────────────────────────────────────────────────
-- Structural backstop so the next table with this shape fails CI instead of
-- silently breaking unrelated embeds. Returns one row per public table whose
-- PRIMARY KEY is exactly two columns, each a single-column FK to a different
-- table. scripts/check-db-invariants.mjs fails on any row it returns.
--
-- SECURITY INVOKER (the default) and read-only over pg_catalog: it exposes no
-- row data, only relationship shape, and the CI job already connects with the
-- service role.
CREATE OR REPLACE FUNCTION public.accidental_junction_tables()
RETURNS TABLE (junction_table text, pk_columns text[], parents text[])
LANGUAGE sql
STABLE
AS $$
  WITH pk AS (
    SELECT c.conrelid AS tbl,
           array_agg(a.attname ORDER BY a.attname) AS cols,
           count(*) AS n
    FROM pg_constraint c
    JOIN unnest(c.conkey) k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.contype = 'p'
      AND c.connamespace = 'public'::regnamespace
    GROUP BY c.conrelid
  ),
  fk AS (
    SELECT c.conrelid AS tbl,
           a.attname AS col,
           c.confrelid::regclass::text AS parent
    FROM pg_constraint c
    JOIN unnest(c.conkey) k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.contype = 'f'
      AND array_length(c.conkey, 1) = 1
  )
  SELECT pk.tbl::regclass::text,
         pk.cols,
         array_agg(DISTINCT fk.parent)
  FROM pk
  JOIN fk ON fk.tbl = pk.tbl AND fk.col = ANY (pk.cols)
  WHERE pk.n = 2
  GROUP BY pk.tbl, pk.cols
  HAVING count(DISTINCT fk.col) = 2
     AND count(DISTINCT fk.parent) = 2;
$$;

COMMENT ON FUNCTION public.accidental_junction_tables() IS
  'Tables PostgREST will read as many-to-many junctions (PK = exactly two '
  'single-column FKs to two different tables), making both parents'' embeds '
  'ambiguous with PGRST201. A genuine join table belongs in the allowlist in '
  'scripts/check-db-invariants.mjs; anything else is the 20260810214329 bug.';

GRANT EXECUTE ON FUNCTION public.accidental_junction_tables() TO service_role;

-- PostgREST caches the schema; without this the ambiguity persists until the
-- next reload even though the FK is gone.
NOTIFY pgrst, 'reload schema';
