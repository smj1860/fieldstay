-- Fix "no unique or exclusion constraint matching the ON CONFLICT
-- specification" error thrown by the Hospitable teammates upsert
-- (lib/inngest/functions/hospitable/initial-sync.ts).
--
-- crew_members_external_unique (added in
-- 20260704000001_crew_members_external_columns.sql) is a PARTIAL unique
-- index (`WHERE external_id IS NOT NULL`). Postgres only lets
-- `ON CONFLICT (cols)` use a partial index as its arbiter if the same
-- WHERE predicate is repeated in the ON CONFLICT clause itself — and the
-- Supabase JS client's `.upsert({ onConflict: 'org_id,external_id,external_source' })`
-- has no way to supply that predicate. With no matching non-partial
-- constraint on those columns, Postgres rejects the upsert outright.
--
-- The partial predicate was never necessary: a plain (non-partial) unique
-- index already treats NULL as distinct from NULL, so manually-created
-- crew members with external_id IS NULL never collide with each other.
-- Replacing it with a full unique index gives ON CONFLICT a real arbiter
-- to match against.
DROP INDEX IF EXISTS public.crew_members_external_unique;

CREATE UNIQUE INDEX IF NOT EXISTS crew_members_external_unique
  ON public.crew_members (org_id, external_id, external_source);
