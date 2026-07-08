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
-- CLAUDE_61_5: Surface crew_feedback to platform staff
--
-- CLAUDE_61_5's premise ("crew_feedback does not exist") was incorrect — the
-- table, RLS, API route, and crew-facing modal already existed as of
-- 20260628000000_crew_feedback.sql. The real gap: crew feedback was only
-- visible to the crew member's own org (PMs), never to platform staff, so
-- nobody at FieldStay could see feedback trends across all orgs.
--
-- Follows the same pattern already established for support_conversations in
-- 20260630100200_support_staff_backfill.sql: a dedicated staff SELECT policy
-- gated on is_platform_staff(), read via the normal authenticated client
-- (not a service-role page fetch).

DROP POLICY IF EXISTS "crew_feedback_staff_select" ON public.crew_feedback;

CREATE POLICY "crew_feedback_staff_select" ON public.crew_feedback
  FOR SELECT USING (is_platform_staff());
