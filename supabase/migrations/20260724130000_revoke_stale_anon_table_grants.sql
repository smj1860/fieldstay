-- Revoke stale anon grants on public tables (defense-in-depth).
--
-- Audit findings (2026-07-24): 20 production tables carried anon grants
-- (audit_events, organization_members, owner_transactions, work_orders, ...)
-- left over from how they were originally created — none are needed. Every
-- unauthenticated surface in the app (guidebook, owner portal, media kit,
-- vendor-connect) reads server-side through the service client, the auth
-- pages call supabase.auth.* only, and every browser-side table read runs
-- with an authenticated session. RLS was already blocking anon on org-scoped
-- tables (auth.uid() IS NULL fails every policy), but tables with open read
-- policies (e.g. integration_providers' "Anyone can read active providers")
-- were world-readable through the REST API with just the public anon key.
--
-- Grants to `authenticated` are untouched — RLS depends on them
-- (see 20260710200000_grant_authenticated_missing_tables.sql).
--
-- Enforced going forward by scripts/check-db-invariants.mjs (CI
-- db-invariants job): any future table that picks up an anon grant fails CI.

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Stop future tables/sequences created by this role from getting anon
-- grants via default privileges (no-op if the defaults never included anon).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
