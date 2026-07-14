-- Fix: guidebook_configurations UPDATE lockdown was silently negated.
--
-- 20260628162255_guidebook_configurations_restrict_update.sql intentionally
-- deny-alled UPDATE ("gc_restrict_update": USING (false) WITH CHECK (false))
-- because all writes to this table (is_active, grace_period_ends_at,
-- sponsor-tier/billing state) must go through createServiceClient() in
-- Inngest, never a user-scoped client.
--
-- 20260704182808_claude_61_0_security_hardening.sql / its byte-duplicate
-- 20260704182905, six days later, re-created a permissive "gc_org_members_update"
-- policy (org_id IN get_user_org_ids(), any role) while adding WITH CHECK to
-- it -- intended as a WITH-CHECK hardening pass, but it never dropped
-- gc_restrict_update, and both are PERMISSIVE, so Postgres ORs them:
-- false OR (org_id IN get_user_org_ids()) -- the deny-all became inert.
-- 20260710200000_grant_authenticated_missing_tables.sql then granted base
-- table UPDATE to authenticated/anon, making the reopened policy reachable.
--
-- Net effect: any accepted org member (including crew/viewer) could update
-- guidebook_configurations directly from their own session -- confined to
-- their own org, but defeating the deliberate service-role-only control on
-- billing/grace-period state.
--
-- Fix: drop the reopened permissive policy. gc_restrict_update already
-- exists and is sufficient on its own.

DROP POLICY IF EXISTS "gc_org_members_update" ON public.guidebook_configurations;

-- The 07-10 grant only unblocks the base privilege layer RLS sits on top
-- of; it was added preventively for guidebook_configurations/guidebook_sponsors
-- alongside two tables with a real read gap. guidebook_configurations has no
-- legitimate authenticated-role write path (see comment above), so revoke
-- the write-capable grants and leave SELECT (needed for gc_org_members_select)
-- in place.
REVOKE INSERT, UPDATE, DELETE ON public.guidebook_configurations FROM authenticated, anon;
