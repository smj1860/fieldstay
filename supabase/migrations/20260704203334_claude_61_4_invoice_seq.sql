-- ─────────────────────────────────────────────────────────────────────────
-- NOT RECORDED IN LIVE MIGRATION HISTORY: verified via Supabase MCP
-- list_migrations against project vpmznjktllhmmbfnxuvk on 2026-07-08 that
-- this file's version is absent from supabase_migrations.schema_migrations.
-- Spot-checking the schema objects it defines (tables, columns, indexes,
-- functions, policies, enum values, dropped objects) against the live
-- database confirms they already exist — this SQL was applied previously,
-- most likely by hand or under a different, already-tracked migration
-- timestamp, and this file is a historical/duplicate copy rather than a
-- pending change. Do not assume `supabase db push` needs to run it, and
-- verify against the live schema before treating it as authoritative —
-- some statements here (UPDATEs, INSERTs, ALTER TYPE ... ADD VALUE) are
-- not safely re-runnable if actually executed again.
-- ─────────────────────────────────────────────────────────────────────────
-- CLAUDE_61_4: Invoice number atomic sequence
--
-- Replaces the COUNT-then-INSERT invoice number pattern which is a TOCTOU race:
-- two concurrent vendor sign-offs get the same COUNT result and both try to
-- create INV-YYYY-NNNNN with the same number. One fails or gets a duplicate.
--
-- A Postgres sequence is atomic — nextval() always returns a unique value
-- even under high concurrency.

CREATE SEQUENCE IF NOT EXISTS public.work_order_invoice_seq
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

-- The sequence is global (not per-org) which is fine:
-- invoice numbers don't need to be contiguous per org,
-- they just need to be unique and monotonically increasing.

GRANT USAGE ON SEQUENCE public.work_order_invoice_seq TO service_role;

-- The audit's proposed client call — supabase.rpc('nextval', { seq_name: ... })
-- — cannot work as written: Postgres's built-in nextval() lives in pg_catalog,
-- is not exposed over PostgREST, and its (regclass) argument has no name
-- PostgREST could bind a JSON { seq_name } body to. A thin wrapper in the
-- public schema is required to call it as an RPC. Named distinctly (not
-- "nextval") to avoid any ambiguity with the built-in of the same name once
-- resolved against a text argument.
CREATE OR REPLACE FUNCTION public.next_work_order_invoice_seq()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT nextval('public.work_order_invoice_seq');
$$;

REVOKE ALL ON FUNCTION public.next_work_order_invoice_seq() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_work_order_invoice_seq() TO service_role;
