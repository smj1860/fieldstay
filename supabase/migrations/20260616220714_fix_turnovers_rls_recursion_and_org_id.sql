
-- ================================================================
-- FIX 1: Infinite RLS recursion on turnovers / turnover_assignments
-- ================================================================

-- Step 1: Add org_id to turnover_assignments (missing column)
ALTER TABLE turnover_assignments
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

-- Backfill org_id from the parent turnovers row
UPDATE turnover_assignments ta
SET org_id = t.org_id
FROM turnovers t
WHERE ta.turnover_id = t.id
  AND ta.org_id IS NULL;

-- Index for policy performance
CREATE INDEX IF NOT EXISTS idx_turnover_assignments_org_id
  ON turnover_assignments(org_id);

-- Step 2: SECURITY DEFINER helper — reads turnover_assignments without
-- triggering RLS, breaking the circular policy dependency.
CREATE OR REPLACE FUNCTION get_crew_turnover_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT ta.turnover_id
  FROM turnover_assignments ta
  JOIN crew_members cm ON ta.crew_member_id = cm.id
  WHERE cm.user_id = auth.uid()
$$;

-- Step 3: Drop the recursive policies
DROP POLICY IF EXISTS "turnovers_crew_select"    ON turnovers;
DROP POLICY IF EXISTS "turnovers_crew_update"    ON turnovers;
DROP POLICY IF EXISTS "assignments_select"       ON turnover_assignments;
DROP POLICY IF EXISTS "assignments_manage"       ON turnover_assignments;
DROP POLICY IF EXISTS "assignments_crew_select"  ON turnover_assignments;

-- Step 4: Recreate turnovers crew policies using the safe helper
CREATE POLICY "turnovers_crew_select"
  ON turnovers FOR SELECT
  USING (id IN (SELECT get_crew_turnover_ids()));

CREATE POLICY "turnovers_crew_update"
  ON turnovers FOR UPDATE
  USING (id IN (SELECT get_crew_turnover_ids()));

-- Step 5: Recreate turnover_assignments policies using org_id directly —
-- no join back through turnovers, recursion eliminated.
CREATE POLICY "assignments_select"
  ON turnover_assignments FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "assignments_manage"
  ON turnover_assignments FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY "assignments_crew_select"
  ON turnover_assignments FOR SELECT
  USING (
    crew_member_id IN (
      SELECT id FROM crew_members WHERE user_id = auth.uid()
    )
  );
