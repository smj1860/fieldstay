-- ============================================================================
-- notifications: GRANT the UPDATE its RLS policy has always assumed.
--
-- Production state before this migration:
--
--   GRANT  : SELECT only, to `authenticated`
--   POLICY : "Org members can view notifications"        (SELECT)
--   POLICY : "Org members can mark notifications read"   (UPDATE)  ← no GRANT
--
-- Postgres checks the GRANT *before* RLS is ever evaluated, so that UPDATE
-- policy has never been reachable. Every attempt by a real org member to mark
-- a notification read has failed with "permission denied for table
-- notifications" — the policy looks correct in isolation and does nothing.
-- This is the same defect that made the notification bell render "You're all
-- caught up" while the table was unreadable, closed by
-- 20260710200000_grant_authenticated_missing_tables.sql; that migration fixed
-- SELECT on this table and did not add UPDATE.
--
-- Why it went unnoticed: check-db-invariants.mjs HAS a policies_without_grant
-- check that catches exactly this, but it runs against the E2E project, and
-- that project carried a pg_default_acl entry granting `authenticated`
-- everything on every new table. The check could not fail there. Aligning E2E's
-- grants to production's (2026-08-06, docs/E2E_SETUP.md) armed the check for
-- the first time, and this was the first thing it found.
--
-- Scope note: the policy's USING/WITH CHECK is what limits members to their own
-- org's rows, and CLAUDE.md records that read_at is the only column members are
-- meant to change ("no column-level lock-down yet"). This grant does not narrow
-- that further — a column-level GRANT (UPDATE (read_at)) would, and is the
-- right follow-up, but it is a behaviour change to reason about separately
-- rather than something to slip into a fix for an unreachable policy.
-- ============================================================================

GRANT UPDATE ON public.notifications TO authenticated;

NOTIFY pgrst, 'reload schema';
