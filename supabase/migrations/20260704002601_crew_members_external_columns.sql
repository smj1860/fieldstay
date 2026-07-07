ALTER TABLE public.crew_members
  ADD COLUMN IF NOT EXISTS external_id     text,
  ADD COLUMN IF NOT EXISTS external_source text;

CREATE UNIQUE INDEX IF NOT EXISTS crew_members_external_unique
  ON public.crew_members (org_id, external_id, external_source)
  WHERE external_id IS NOT NULL;

COMMENT ON COLUMN public.crew_members.external_id IS
  'UUID from external PMS (e.g. Hospitable teammate UUID). NULL for manually-added crew.';
COMMENT ON COLUMN public.crew_members.external_source IS
  'Provider that owns this record (e.g. ''hospitable''). NULL for manually-added crew.';
