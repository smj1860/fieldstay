
DROP POLICY IF EXISTS "maintenance_completions_update" ON maintenance_completions;

CREATE POLICY "maintenance_completions_update" ON maintenance_completions
  FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );
