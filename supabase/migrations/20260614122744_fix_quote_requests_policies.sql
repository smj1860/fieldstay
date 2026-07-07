
-- Task 12: Standardize quote_requests to a single consistent policy set
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'quote_requests' LOOP
    EXECUTE 'DROP POLICY IF EXISTS "' || r.policyname || '" ON quote_requests';
  END LOOP;
END $$;

-- All org members can read quote requests for their org
CREATE POLICY "quote_requests_org_read" ON quote_requests
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

-- Admin/manager only for writes
CREATE POLICY "quote_requests_org_write" ON quote_requests
  FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- Service role bypass for Inngest/webhooks
CREATE POLICY "quote_requests_service_role" ON quote_requests
  TO service_role USING (true) WITH CHECK (true);
