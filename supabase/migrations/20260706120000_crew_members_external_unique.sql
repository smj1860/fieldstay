-- Unique index for Hospitable teammate sync upsert
-- Scoped to org_id for tenant isolation — prevents cross-org UUID collision
CREATE UNIQUE INDEX IF NOT EXISTS crew_members_external_unique
  ON public.crew_members (org_id, external_id, external_source)
  WHERE external_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
