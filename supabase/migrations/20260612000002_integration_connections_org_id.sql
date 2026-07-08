-- integration_connections is currently keyed by (user_id, provider_id) only.
-- Org-scoped integrations (e.g. Kroger cart automation, OwnerRez PMS sync)
-- need to be looked up by org_id from Inngest steps and server actions that
-- only have org context. Add org_id and backfill from organization_members.
ALTER TABLE public.integration_connections
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_integration_connections_org_id
  ON public.integration_connections(org_id);

-- Backfill: assign each existing connection to one org the connecting user
-- belongs to (the user's first accepted membership).
UPDATE public.integration_connections ic
SET    org_id = om.org_id
FROM   public.organization_members om
WHERE  om.user_id = ic.user_id
  AND  om.invite_accepted_at IS NOT NULL
  AND  ic.org_id IS NULL;

-- Existing RLS only lets a user see their OWN connection row
-- (users_view_own_connections). Org admins/managers need to see what a
-- teammate connected (e.g. who connected Kroger) on the Settings page.
-- Read-only — vault_secret_id columns are opaque without the
-- security-definer read_integration_token()/read_integration_refresh_token()
-- RPCs, so this does not expose token contents.
CREATE POLICY "org_members_view_org_connections"
  ON public.integration_connections FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
