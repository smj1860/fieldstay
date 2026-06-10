-- Activate RepuGuard for all orgs with an active OwnerRez connection.
-- Covers existing users who never clicked the old activate button.
-- integration_connections has no org_id column (yet), so join through
-- organization_members on user_id instead.
UPDATE public.organizations o
SET    repuguard_status = 'active'
WHERE  repuguard_status IN ('inactive', 'cancelled')
AND    EXISTS (
  SELECT 1
  FROM   public.integration_connections ic
  JOIN   public.organization_members om
    ON   om.user_id = ic.user_id
    AND  om.org_id  = o.id
  WHERE  ic.provider_id = 'ownerrez'
  AND    ic.status      = 'active'
);
