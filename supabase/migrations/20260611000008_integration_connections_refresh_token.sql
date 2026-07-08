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
-- Prepare integration_connections for providers that issue refresh tokens.
-- NULL for providers without expiring tokens (e.g. OwnerRez). No code change
-- needed until a refresh-token provider is actually onboarded.
ALTER TABLE public.integration_connections
  ADD COLUMN IF NOT EXISTS refresh_token_vault_secret_id uuid,
  ADD COLUMN IF NOT EXISTS expires_at                    timestamptz;

COMMENT ON COLUMN public.integration_connections.refresh_token_vault_secret_id IS
  'FK → vault.secrets.id for the refresh token. NULL for non-expiring providers (e.g. OwnerRez).';

COMMENT ON COLUMN public.integration_connections.expires_at IS
  'When the access token expires. NULL for non-expiring tokens.';
