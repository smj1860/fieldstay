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
-- store_integration_refresh_token / read_integration_refresh_token were
-- created without explicit grants, so Postgres defaulted to EXECUTE granted
-- to PUBLIC (including anon/authenticated via PostgREST RPC). Lock these
-- down to match store_integration_token / read_integration_token, which are
-- service-role only.
REVOKE EXECUTE ON FUNCTION public.store_integration_refresh_token(uuid, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.read_integration_refresh_token(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.store_integration_refresh_token(uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_integration_refresh_token(uuid, text) TO service_role;
