
-- Task 13: Remove duplicate ALL policies and add clean read/write/service_role set
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'property_owners' LOOP
    EXECUTE 'DROP POLICY IF EXISTS "' || r.policyname || '" ON property_owners';
  END LOOP;
END $$;

-- All org members can read property owner records for their org
CREATE POLICY "property_owners_org_read" ON property_owners
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

-- Admin/manager only for write operations
CREATE POLICY "property_owners_org_write" ON property_owners
  FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- Service role bypass
CREATE POLICY "property_owners_service_role" ON property_owners
  TO service_role USING (true) WITH CHECK (true);
