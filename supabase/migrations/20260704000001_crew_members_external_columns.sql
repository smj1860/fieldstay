-- Add external sync columns to crew_members so Hospitable teammates
-- can be upserted idempotently without creating duplicates on re-sync.

ALTER TABLE public.crew_members
  ADD COLUMN IF NOT EXISTS external_id     text,
  ADD COLUMN IF NOT EXISTS external_source text;

-- Unique index scoped to (org_id, external_id, external_source).
-- Including org_id is non-negotiable — guarantees tenant isolation so an
-- upsert for org A can never overwrite a crew member row belonging to org B
-- even if Hospitable ever reuses UUIDs across accounts.
-- Partial index (WHERE external_id IS NOT NULL) avoids conflicts on
-- manually-created crew members that have no external_id.
CREATE UNIQUE INDEX IF NOT EXISTS crew_members_external_unique
  ON public.crew_members (org_id, external_id, external_source)
  WHERE external_id IS NOT NULL;

COMMENT ON COLUMN public.crew_members.external_id IS
  'UUID from external PMS (e.g. Hospitable teammate UUID). NULL for manually-added crew.';
COMMENT ON COLUMN public.crew_members.external_source IS
  'Provider that owns this record (e.g. ''hospitable''). NULL for manually-added crew.';
