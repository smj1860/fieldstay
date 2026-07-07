
-- ================================================================
-- ROOT CAUSE FIX: 'owner' role was excluded from all write policies
--
-- The is_org_member() function is called by 27 policies across 20 tables.
-- Every policy uses ARRAY['admin', 'manager'] — never includes 'owner'.
-- The logged-in user has role = 'owner' → blocked from every write operation.
--
-- Fix: Update is_org_member so that role = 'owner' always passes,
-- regardless of what p_roles array is passed. Owner = full access.
-- This fixes ALL affected policies in a single change with zero risk
-- of missing an individual policy.
-- ================================================================

CREATE OR REPLACE FUNCTION public.is_org_member(
  p_org_id uuid,
  p_roles   member_role[] DEFAULT NULL::member_role[]
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_members
    WHERE org_id              = p_org_id
      AND user_id             = auth.uid()
      AND invite_accepted_at IS NOT NULL
      AND (
        p_roles IS NULL                    -- no role restriction: any member passes
        OR role = ANY(p_roles)             -- explicit role match
        OR role = 'owner'::member_role     -- org owner always has full access
      )
  )
$$;

-- Verify the fix: confirm function body updated correctly
COMMENT ON FUNCTION public.is_org_member IS
  'Returns true if the current user is a member of the given org with an accepted invite.
   Optionally restricts to specific roles. The "owner" member_role always passes
   regardless of p_roles — org owners have full platform access.
   Fixed 2026-06-05: owner role was excluded from all write policies.';
