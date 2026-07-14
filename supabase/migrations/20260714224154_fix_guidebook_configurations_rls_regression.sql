-- Fixes a live RLS privilege-escalation regression: migration
-- 20260628162255_guidebook_configurations_restrict_update.sql intentionally
-- restricted UPDATE on guidebook_configurations to service_role only
-- (all app writes go through createServiceClient()), but a later
-- "security hardening" pass (20260704182808 / 20260704182905) re-added a
-- permissive org-member UPDATE policy while trying to fix an unrelated
-- missing-WITH-CHECK issue on four tables. Postgres ORs permissive
-- policies together, so the re-added policy fully negated the
-- service-role-only restriction, letting any org member (including
-- crew/viewer roles) update sponsor monetization gating, grace periods,
-- and trial dates directly via PostgREST.
--
-- No legitimate app code path depends on the org-member policy — every
-- write site (Inngest functions, app/actions/guidebook.ts) already uses
-- createServiceClient(), which bypasses RLS entirely. Safe to drop.

DROP POLICY IF EXISTS "gc_org_members_update" ON public.guidebook_configurations;

-- Recreate defensively in case a future migration re-adds the org-member
-- policy without realizing this table is service-role-write-only.
DROP POLICY IF EXISTS "gc_restrict_update" ON public.guidebook_configurations;
CREATE POLICY "gc_restrict_update" ON public.guidebook_configurations
  FOR UPDATE USING (false) WITH CHECK (false);
