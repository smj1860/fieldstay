-- Task 0: RLS policy so crew members can manage their own push subscription rows
CREATE POLICY "crew manage own push subscriptions"
  ON push_subscriptions
  FOR ALL
  USING (
    crew_member_id IN (
      SELECT id FROM crew_members WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    crew_member_id IN (
      SELECT id FROM crew_members WHERE user_id = auth.uid()
    )
  );

-- Task 2 Step 3: Generalise push_subscriptions to also support PM/manager subscriptions.
ALTER TABLE push_subscriptions ALTER COLUMN crew_member_id DROP NOT NULL;
ALTER TABLE push_subscriptions ADD COLUMN user_id uuid NULL REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_one_owner
  CHECK ((crew_member_id IS NOT NULL) <> (user_id IS NOT NULL));

ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_crew_member_id_endpoint_key;
CREATE UNIQUE INDEX push_subscriptions_crew_endpoint_key
  ON push_subscriptions (crew_member_id, endpoint) WHERE crew_member_id IS NOT NULL;
CREATE UNIQUE INDEX push_subscriptions_user_endpoint_key
  ON push_subscriptions (user_id, endpoint) WHERE user_id IS NOT NULL;

CREATE POLICY "org members manage own push subscriptions"
  ON push_subscriptions
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
