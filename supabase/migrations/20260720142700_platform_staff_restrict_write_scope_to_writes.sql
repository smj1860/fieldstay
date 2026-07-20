-- platform_staff_restrict_write was FOR ALL with qual/with_check = false —
-- intended purely to block direct INSERT/UPDATE/DELETE via any
-- authenticated role (writes to this table happen through a SECURITY
-- DEFINER path only). Because it's FOR ALL, it also counted as a second
-- applicable permissive policy for SELECT (alongside
-- platform_staff_self_select), even though `false` never grants anything —
-- the advisor still flags its mere presence. Splitting it into
-- INSERT/UPDATE/DELETE-only policies (still `false`, still blocks all
-- direct writes identically) removes it from SELECT's policy set entirely
-- without changing what it blocks.
DROP POLICY IF EXISTS "platform_staff_restrict_write" ON platform_staff;

CREATE POLICY "platform_staff_restrict_insert" ON platform_staff FOR INSERT
  WITH CHECK (false);
CREATE POLICY "platform_staff_restrict_update" ON platform_staff FOR UPDATE
  USING (false) WITH CHECK (false);
CREATE POLICY "platform_staff_restrict_delete" ON platform_staff FOR DELETE
  USING (false);
