
-- Set earliest member of each org as owner
UPDATE public.organization_members
SET role = 'owner'
WHERE id IN (
  SELECT DISTINCT ON (org_id) id
  FROM public.organization_members
  ORDER BY org_id, created_at ASC
);

-- Pending org invitations
CREATE TABLE IF NOT EXISTS public.org_invites (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid         NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invited_by   uuid         NOT NULL REFERENCES auth.users(id),
  email        text         NOT NULL,
  role         member_role  NOT NULL DEFAULT 'admin',
  token        text         NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  expires_at   timestamptz  NOT NULL DEFAULT now() + interval '7 days',
  accepted_at  timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT org_invites_role_check CHECK (role = 'admin')
);

CREATE INDEX IF NOT EXISTS idx_org_invites_token  ON public.org_invites(token);
CREATE INDEX IF NOT EXISTS idx_org_invites_org_id ON public.org_invites(org_id);
CREATE INDEX IF NOT EXISTS idx_org_invites_email  ON public.org_invites(email);

ALTER TABLE public.org_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can manage org invites"
  ON public.org_invites FOR ALL
  USING (
    org_id IN (
      SELECT org_id FROM public.organization_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_invites          TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_members TO anon, authenticated;
