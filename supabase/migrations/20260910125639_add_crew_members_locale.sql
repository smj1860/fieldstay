-- Crew member language preference — Spanish toggle for the crew PWA.
--
-- Opt-in via DEFAULT 'en': every existing and newly-created crew row keeps
-- rendering in English until a crew member explicitly switches, so this
-- migration is behaviour-neutral on deploy, same rationale as
-- 20260827034958_crew_members_auto_assign_eligible.sql.
--
-- ── Why no new RLS policy ────────────────────────────────────────────────────
--
-- crew_members' existing UPDATE policy is
-- is_org_member(org_id, ARRAY['admin','manager']) — a plain 'crew' role
-- member cannot update their OWN row through it, unlike crew_availability
-- (which has its own self-scoped policy). Rather than carve a narrowed
-- self-update grant + policy for one column (the NARROWED_UPDATE_GRANTS
-- pattern used for notifications.read_at etc.), the crew-facing Server
-- Action that flips this column writes through
-- createServiceClient({ crew }) — the pattern CLAUDE.md already documents
-- for crew routes — explicitly scoped with .eq('id', crew.id). Simpler than
-- adding schema surface for a single self-service field, and no less safe:
-- the scoping guarantee lives in the query, the same way
-- saveCrewAvailability's .eq('crew_member_id', crew.id) does.
--
-- The SELECT side needs nothing new either — requireCrewMember() already
-- reads a crew member's own row (id, org_id) under existing RLS; this column
-- just joins that same select.

ALTER TABLE public.crew_members
  ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.crew_members'::regclass
       AND conname  = 'crew_members_locale_check'
  ) THEN
    ALTER TABLE public.crew_members
      ADD CONSTRAINT crew_members_locale_check
      CHECK (locale IN ('en', 'es'));
  END IF;
END $$;

COMMENT ON COLUMN public.crew_members.locale IS
  'Crew member''s preferred UI language for the crew PWA. ''en'' or ''es''. '
  'Read by requireCrewMember() and cached in Dexie so it is known offline. '
  'Written only via createServiceClient({ crew }), scoped to the caller''s '
  'own row — see lib/crew-auth.ts and app/crew/settings/actions.ts.';
