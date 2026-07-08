-- lib/inngest/functions/hospitable/initial-sync.ts upserts crew_members with
-- onConflict: 'org_id,external_id,external_source' but no matching unique
-- constraint has ever existed on this table (only crew_members_pkey and
-- crew_members_invite_token_key) — every Hospitable "teammates" import has
-- been failing with "no unique or exclusion constraint matching the ON
-- CONFLICT specification" since this sync was written. NULLs on manually-
-- created crew rows (external_id/external_source both NULL) don't collide
-- under a plain UNIQUE constraint, so this is safe to add without a partial
-- index.

ALTER TABLE public.crew_members
  ADD CONSTRAINT crew_members_org_external_unique
  UNIQUE (org_id, external_id, external_source);

NOTIFY pgrst, 'reload schema';
