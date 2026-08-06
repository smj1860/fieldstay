-- ============================================================================
-- organizations: remove the "any logged-in user may create an org" INSERT path.
--
-- The policy read:
--     orgs_insert  FOR INSERT  WITH CHECK ((SELECT auth.uid()) IS NOT NULL)
--
-- which is not a tenant check at all — it is "are you signed in". Any
-- authenticated user could POST /rest/v1/organizations directly and mint
-- unlimited organization rows. Nothing is created alongside them (no
-- organization_members row, so get_user_org_ids() never returns them and the
-- creator cannot even see what they made), and nothing reaps them, so each one
-- is a permanent orphan on the tenant-root table. Production carried exactly
-- one such orphan — a test org with 1 property and 0 members that no user
-- could reach — deleted in the same change.
--
-- The policy bought nothing, because the app has never inserted here with an
-- authenticated client. `createOrganization` (app/onboarding/actions.ts) calls
-- create_organization_with_owner(), a SECURITY DEFINER function granted to
-- service_role only, which inserts the org and its owner membership together
-- under one advisory lock. Service role bypasses RLS, so dropping this policy
-- does not touch the real signup path — verified: there is no
-- `.from('organizations').insert(` anywhere in app/ or lib/.
--
-- Both halves are dropped, because a policy and a GRANT are independent gates
-- and either one alone leaves a door: Postgres checks the GRANT before RLS
-- ever evaluates, so the revoke is what makes this fail with "permission
-- denied" rather than silently returning zero rows.
--
-- organizations keeps its SELECT and UPDATE policies, so it does not become a
-- policy-less table and does not need an entry in check-db-invariants.mjs's
-- SERVICE_ROLE_ONLY_TABLES allowlist.
-- ============================================================================

DROP POLICY IF EXISTS orgs_insert ON public.organizations;

REVOKE INSERT ON public.organizations FROM authenticated;
REVOKE INSERT ON public.organizations FROM anon;

-- Same class, found while verifying the above: `authenticated` also held a
-- DELETE grant on organizations with NO DELETE policy to go with it. RLS
-- default-deny meant nothing could actually be deleted, so this was never
-- exploitable — but it is precisely the stale-grant shape CLAUDE.md's standing
-- audit calls out, where the policy SQL looks correct and the leftover GRANT
-- survives underneath it. Deleting a tenant root is a service-role operation
-- (app/api/account/delete), never a client one.
REVOKE DELETE ON public.organizations FROM authenticated;
REVOKE DELETE ON public.organizations FROM anon;

NOTIFY pgrst, 'reload schema';
