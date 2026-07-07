-- Fix "no unique or exclusion constraint matching the ON CONFLICT
-- specification" error thrown by the Hospitable teammates upsert.
-- crew_members_external_unique was a PARTIAL unique index
-- (WHERE external_id IS NOT NULL), which Postgres cannot use as an
-- ON CONFLICT arbiter unless the same WHERE predicate is repeated in the
-- ON CONFLICT clause -- something the Supabase JS client's
-- .upsert({ onConflict: '...' }) has no way to supply. Replace it with a
-- full (non-partial) unique index; NULLs are still treated as distinct
-- from each other, so manually-created crew members with no external_id
-- still never collide.
DROP INDEX IF EXISTS public.crew_members_external_unique;

CREATE UNIQUE INDEX IF NOT EXISTS crew_members_external_unique
  ON public.crew_members (org_id, external_id, external_source);
