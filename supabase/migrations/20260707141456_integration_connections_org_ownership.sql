-- integration_connections is user-keyed with org_id retrofitted. Harden the
-- org-ownership boundary the app already assumes:
--   1. Backfill any NULL org_id from the connecting user's accepted membership.
--   2. Enforce at most ONE active connection per (org_id, provider_id) so two
--      members of the same org can't create competing/duplicate syncs.

UPDATE public.integration_connections c
SET org_id = (
  SELECT m.org_id
  FROM   public.organization_members m
  WHERE  m.user_id = c.user_id
    AND  m.invite_accepted_at IS NOT NULL
  ORDER BY m.created_at ASC
  LIMIT 1
)
WHERE c.org_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_org_provider_active_uniq
  ON public.integration_connections (org_id, provider_id)
  WHERE status = 'active' AND org_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
