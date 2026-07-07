
-- Restrict UPDATE on guidebook_configurations to service_role only.
-- All writes to this table go through createServiceClient() in Inngest functions.
-- User-scoped clients should never modify is_active or grace_period_ends_at directly.
-- Consistent with the existing gc_restrict_insert and gc_restrict_delete deny policies.

DROP POLICY IF EXISTS "gc_org_members_update" ON guidebook_configurations;

CREATE POLICY "gc_restrict_update" ON guidebook_configurations
  FOR UPDATE USING (false) WITH CHECK (false);
