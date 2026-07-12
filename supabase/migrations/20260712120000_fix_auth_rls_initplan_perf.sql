-- Performance advisor: auth_rls_initplan
-- 11 RLS policies call auth.uid() as a plain function inside USING/WITH CHECK,
-- which Postgres re-evaluates once per row instead of once per query. Wrapping
-- each call as a scalar subquery (select auth.uid()) lets the planner hoist it
-- into an InitPlan, evaluated once. Policy logic is otherwise unchanged.
-- https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select

-- ── checklist_instances ──────────────────────────────────────────────────────

DROP POLICY IF EXISTS "checklist_instances_crew_update" ON public.checklist_instances;
CREATE POLICY "checklist_instances_crew_update"
  ON public.checklist_instances FOR UPDATE
  USING (
    turnover_id IN (
      SELECT ta.turnover_id
      FROM turnover_assignments ta
      JOIN crew_members cm ON cm.id = ta.crew_member_id
      WHERE cm.user_id = (select auth.uid())
    )
  )
  WITH CHECK (
    turnover_id IN (
      SELECT ta.turnover_id
      FROM turnover_assignments ta
      JOIN crew_members cm ON cm.id = ta.crew_member_id
      WHERE cm.user_id = (select auth.uid())
    )
  );

-- ── inventory_items ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "inventory_items_update" ON public.inventory_items;
CREATE POLICY "inventory_items_update"
  ON public.inventory_items FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR property_id IN (
      SELECT DISTINCT t.property_id
      FROM turnovers t
      JOIN turnover_assignments ta ON ta.turnover_id = t.id
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = (select auth.uid())
    )
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR property_id IN (
      SELECT DISTINCT t.property_id
      FROM turnovers t
      JOIN turnover_assignments ta ON ta.turnover_id = t.id
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = (select auth.uid())
    )
  );

-- ── platform_admins ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_can_check_own_platform_admin_status" ON public.platform_admins;
CREATE POLICY "users_can_check_own_platform_admin_status"
  ON public.platform_admins FOR SELECT
  TO authenticated
  USING (user_id = (select auth.uid()));

-- ── platform_staff ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "platform_staff_select_own" ON public.platform_staff;
CREATE POLICY "platform_staff_select_own"
  ON public.platform_staff FOR SELECT
  TO authenticated
  USING (user_id = (select auth.uid()));

-- ── push_subscriptions ────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "crew manage own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "crew manage own push subscriptions"
  ON public.push_subscriptions FOR ALL
  USING (
    crew_member_id IN (
      SELECT crew_members.id FROM crew_members
      WHERE crew_members.user_id = (select auth.uid())
    )
  )
  WITH CHECK (
    crew_member_id IN (
      SELECT crew_members.id FROM crew_members
      WHERE crew_members.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "org members manage own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "org members manage own push subscriptions"
  ON public.push_subscriptions FOR ALL
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- ── support_conversations ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "org members access own conversations" ON public.support_conversations;
CREATE POLICY "org members access own conversations"
  ON public.support_conversations FOR ALL
  USING (
    user_id = (select auth.uid())
    AND org_id IN (
      SELECT organization_members.org_id FROM organization_members
      WHERE organization_members.user_id = (select auth.uid())
    )
  )
  WITH CHECK (
    user_id = (select auth.uid())
    AND org_id IN (
      SELECT organization_members.org_id FROM organization_members
      WHERE organization_members.user_id = (select auth.uid())
    )
  );

-- ── support_messages ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "org members access own conversation messages" ON public.support_messages;
CREATE POLICY "org members access own conversation messages"
  ON public.support_messages FOR ALL
  USING (
    conversation_id IN (
      SELECT support_conversations.id FROM support_conversations
      WHERE support_conversations.user_id = (select auth.uid())
        AND support_conversations.org_id IN (
          SELECT organization_members.org_id FROM organization_members
          WHERE organization_members.user_id = (select auth.uid())
        )
    )
  )
  WITH CHECK (
    conversation_id IN (
      SELECT support_conversations.id FROM support_conversations
      WHERE support_conversations.user_id = (select auth.uid())
        AND support_conversations.org_id IN (
          SELECT organization_members.org_id FROM organization_members
          WHERE organization_members.user_id = (select auth.uid())
        )
    )
  );

-- ── system_job_runs ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "platform_admins_can_view_job_runs" ON public.system_job_runs;
CREATE POLICY "platform_admins_can_view_job_runs"
  ON public.system_job_runs FOR SELECT
  TO authenticated
  USING (
    (select auth.uid()) IN (SELECT platform_admins.user_id FROM platform_admins)
  );

-- ── work_orders ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "wo_crew_member_read" ON public.work_orders;
CREATE POLICY "wo_crew_member_read"
  ON public.work_orders FOR SELECT
  USING (
    assigned_crew_member_id IN (
      SELECT crew_members.id FROM crew_members
      WHERE crew_members.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "work_orders_insert" ON public.work_orders;
CREATE POLICY "work_orders_insert"
  ON public.work_orders FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR (
      source = 'crew_flag'::wo_source
      AND org_id IN (
        SELECT crew_members.org_id FROM crew_members
        WHERE crew_members.user_id = (select auth.uid())
      )
    )
  );
