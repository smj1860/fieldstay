-- Phase H: half-day availability, the crew "running late" signal, and the
-- lookup behind co-assignee names on a crew card.

-- ── 1. Half-day availability ────────────────────────────────────────────────
--
-- crew_availability has been a whole-day boolean. A cleaner with a dentist
-- appointment at 9am had two options: mark the whole day off (and lose the
-- afternoon's work) or mark nothing (and get auto-assigned a 10am checkout).
--
-- A PART-OF-DAY dimension rather than free times, deliberately. Free times
-- would need a scheduler to reason about arbitrary intervals, and the thing
-- being protected is a hard exclusion in autopilot where nobody reviews the
-- result. Three named windows are something a PM can read off a screen and a
-- scorer can compare against a planned start without interval arithmetic.
--
-- ONE canonical way to say each thing, which is what the CHECK enforces:
--   is_available = false, parts NULL   → the whole day is off
--   is_available = true,  parts NULL   → fully available (every existing row)
--   is_available = true,  parts {…}    → available except those windows
-- An empty array and all three windows are both rejected: the first is NULL
-- wearing a disguise, the second is the whole-day form written the long way,
-- and a column with two spellings for one state is a column every reader has
-- to normalise.
--
-- Duplicates inside the array are NOT rejected: a CHECK cannot hold the
-- subquery that would detect them. Readers treat the array as a set, so
-- {'morning','morning'} means what it looks like.
ALTER TABLE public.crew_availability
  ADD COLUMN IF NOT EXISTS unavailable_parts text[];

ALTER TABLE public.crew_availability
  DROP CONSTRAINT IF EXISTS crew_availability_parts_valid;

ALTER TABLE public.crew_availability
  ADD CONSTRAINT crew_availability_parts_valid CHECK (
    unavailable_parts IS NULL
    OR (
      unavailable_parts <@ ARRAY['morning', 'afternoon', 'evening']::text[]
      AND array_length(unavailable_parts, 1) IS NOT NULL
      AND array_length(unavailable_parts, 1) < 3
      AND is_available = true
    )
  );

COMMENT ON COLUMN public.crew_availability.unavailable_parts IS
  'Part-of-day windows this crew member is NOT available on available_date. '
  'NULL means the row is whole-day, governed by is_available. Non-NULL requires '
  'is_available = true. Windows are resolved in FRICTION_TIMEZONE by '
  'lib/scheduling/part-of-day.ts.';

-- ── 2. The crew "running late" signal ───────────────────────────────────────
--
-- Phase F INFERS lateness from a checklist that is behind. This is the other
-- direction: the person doing the work says so, before the inference could
-- possibly know (stuck in traffic, a guest still in the property, a key that
-- is not where it should be). One tap, offline-capable through the existing
-- outbox, and the PM hears it immediately.
--
-- Two columns rather than one: the timestamp is the signal, and WHO raised it
-- matters on a turnover with more than one assignee. A PM looking at it an
-- hour later needs to know which of the two to call.
--
-- ON DELETE SET NULL, chosen rather than left to default: removing a crew
-- member must neither delete the turnover nor be blocked by a months-old
-- signal. The timestamp survives, which keeps the history honest.
ALTER TABLE public.turnovers
  ADD COLUMN IF NOT EXISTS crew_running_late_at timestamptz,
  ADD COLUMN IF NOT EXISTS crew_running_late_by_crew_member_id uuid
    REFERENCES public.crew_members(id) ON DELETE SET NULL;

-- A plain index, not a partial one, even though the column is mostly NULL:
-- scripts/check-db-invariants.mjs check 3 requires a covering index on every
-- FK column, and a partial index is not one for its purposes.
CREATE INDEX IF NOT EXISTS idx_turnovers_running_late_by_crew
  ON public.turnovers (crew_running_late_by_crew_member_id);

-- ── 3. Co-assignee names for a crew card ────────────────────────────────────
--
-- turnover_assignments_select lets a crew member see their OWN assignment rows
-- and nothing else, so a crew member on a shared turnover cannot see who else
-- is on it. The card has always rendered nobody for that reason.
--
-- WHY AN RPC rather than widening that policy: widening it would hand every
-- crew member the other assignees' rows wholesale (planned times included) and
-- would still not resolve a NAME, since crew_members is scoped to self too.
-- This returns exactly what the card needs and nothing else.
--
-- SECURITY DEFINER with the gate INSIDE the function. The argument only
-- NARROWS; what a caller may see is derived from auth.uid() via the EXISTS
-- clause, so passing another org's turnover ids returns zero rows rather than
-- that org's roster. (A SECURITY DEFINER function that trusts a caller-supplied
-- scope is the vulnerability class 20260801280000 exists to close.)
CREATE OR REPLACE FUNCTION public.get_turnover_coassignees(p_turnover_ids uuid[])
RETURNS TABLE (turnover_id uuid, crew_member_id uuid, crew_member_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT ta.turnover_id, ta.crew_member_id, cm.name
  FROM public.turnover_assignments ta
  JOIN public.crew_members cm ON cm.id = ta.crew_member_id
  WHERE ta.turnover_id = ANY (p_turnover_ids)
    AND EXISTS (
      SELECT 1
      FROM public.turnover_assignments mine
      JOIN public.crew_members me ON me.id = mine.crew_member_id
      WHERE mine.turnover_id = ta.turnover_id
        AND me.user_id = (SELECT auth.uid())
    );
$$;

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on a new public function
-- to authenticated already; REVOKE FROM PUBLIC does NOT remove that, so anon
-- and PUBLIC are revoked by name and authenticated is granted deliberately.
REVOKE ALL ON FUNCTION public.get_turnover_coassignees(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_turnover_coassignees(uuid[]) TO authenticated;
