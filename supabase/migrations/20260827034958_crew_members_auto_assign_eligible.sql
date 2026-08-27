-- Per-crew opt-out from turnover auto-assignment and suggestion.
--
-- ── Why a flag and not a role filter ────────────────────────────────────────
--
-- The obvious version of this feature is `.in('role', ['cleaning','general'])`
-- on the candidate query in lib/inngest/functions/auto-assign-turnover.ts —
-- one line, no migration. It was rejected for three reasons:
--
--   1. It is INVISIBLE. A PM sees a crew member on the roster who is never
--      suggested and has no way to learn that role = 'landscaping' is why.
--      crew-manage-client.tsx renders a role badge, but nothing there says the
--      role gates assignment.
--   2. It inherits a provider bug. lib/integrations/providers/hospitable.mappers.ts
--      checks `maintenance` BEFORE `cleaning`, so a teammate whose Hospitable
--      services include both lands on 'maintenance' and would silently stop
--      being suggested. Hostex ranks the same pair the other way. A role filter
--      makes that inconsistency load-bearing; a flag makes it irrelevant.
--   3. Role is a proxy for the real question. "Cleaning or general" is a guess
--      at "does this person do turnovers", and sometimes the maintenance tech
--      does. The flag asks the actual question.
--
-- ── Why DEFAULT true ────────────────────────────────────────────────────────
--
-- Opt-OUT, not opt-in. Crew rows created by the Hospitable/Hostex staff syncs
-- get it automatically, and — more importantly — an opt-in default would mean
-- auto-assignment silently stopping for every existing org the moment this
-- deploys. A behaviour change nobody asked for, with no error to trace it by,
-- is the worst possible way to ship a preference.
--
-- ── Deliberately additive: nothing reads this column yet ─────────────────────
--
-- This migration is behaviour-neutral on purpose. The candidate-query filter,
-- the crew-manage UI, and the decision about whether to backfill `false` for
-- existing landscaping/maintenance crew are a separate change. Splitting them
-- means this one cannot break anything, and the one that CAN is reviewed on its
-- own merits rather than buried under a schema diff.
--
-- No new RLS policy or grant is needed: crew_members already has RLS enabled
-- with an UPDATE policy gated on is_org_member(org_id, ARRAY['admin','manager'])
-- in both USING and WITH CHECK ('owner' passes automatically), and the table's
-- authenticated UPDATE grant is table-wide rather than column-scoped, so the new
-- column inherits exactly the protection every other column on it has.

ALTER TABLE public.crew_members
  ADD COLUMN IF NOT EXISTS auto_assign_eligible boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.crew_members.auto_assign_eligible IS
  'Whether this crew member may be picked by turnover auto-assignment and '
  'suggestion (lib/inngest/functions/auto-assign-turnover.ts). Opt-out: '
  'DEFAULT true so new and provider-synced crew are eligible without action. '
  'Does NOT gate manual assignment — a PM can still assign anyone by hand from '
  'the turnover board; this only governs what the engine proposes.';
