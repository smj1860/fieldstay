-- oauth_states has RLS enabled with zero policies (functionally deny-all)
-- and is additionally protected by an explicit
-- REVOKE ALL ... FROM anon, authenticated (20260616160058). That REVOKE is
-- the only thing standing between this table and a future migration that
-- re-grants SELECT/UPDATE to authenticated (the exact pattern that
-- reopened guidebook_configurations — see
-- 20260714160100_fix_guidebook_configurations_update_policy.sql). Add an
-- explicit deny-all RLS policy as defense in depth, matching the pattern
-- already used on wo_number_counters / stripe_processed_events
-- (20260612000030_rls_policy_gaps.sql), so a future re-grant alone isn't
-- enough to expose this table.

DROP POLICY IF EXISTS "oauth_states_deny_all" ON public.oauth_states;

CREATE POLICY "oauth_states_deny_all"
  ON public.oauth_states
  FOR ALL
  USING (false)
  WITH CHECK (false);
