-- Consolidates the "multiple permissive policies" advisor finding on the
-- 10 tables deliberately skipped by the earlier
-- split_manage_policies_reduce_permissive_overlap.sql migration, because
-- each had multiple policies for genuinely distinct actor scopes (crew vs.
-- admin, platform staff vs. org member) rather than the simple
-- "_manage FOR ALL + _select" template.
--
-- The technique here is different from that earlier migration: instead of
-- splitting one policy into several, this MERGES multiple policies that
-- already apply to the same command into one policy whose USING/WITH CHECK
-- is the logical OR of the originals. This is not a judgment call about
-- acceptable risk — for multiple PERMISSIVE policies applying to the same
-- command, Postgres already evaluates them as `qual1 OR qual2 OR ...`
-- before this migration; writing that same OR expression into a single
-- policy produces the identical effective access control, just evaluated
-- as one policy instead of N. Every qual/with_check below is transcribed
-- verbatim from the live pg_policies definitions (byte-for-byte, structure
-- preserved) — nothing is being tightened, loosened, or reinterpreted.
--
-- One exception, flagged rather than silently changed: crew_feedback had
-- an INSERT-blocking policy (cf_restrict_insert, WITH CHECK false) whose
-- name suggests inserts were meant to be service-role-only (matches
-- CLAUDE.md: "crew_feedback — Inserted via service client through
-- /api/crew/feedback only"). But crew_feedback_manage's FOR ALL policy
-- already independently grants admin/manager direct INSERT access, and
-- since multiple permissive policies OR together, cf_restrict_insert's
-- `false` never actually blocked anything — admin/manager could already
-- insert directly. This migration preserves that existing (likely
-- unintended) behavior rather than changing it; worth a follow-up decision
-- on whether admin/manager direct insert into crew_feedback is intended.

-- ── checklist_instances ─────────────────────────────────────────────────
-- Two UPDATE policies (crew's own turnover vs. admin/manager) merge to one.
DROP POLICY IF EXISTS "checklist_instances_crew_update" ON checklist_instances;
DROP POLICY IF EXISTS "checklist_instances_update" ON checklist_instances;

CREATE POLICY "checklist_instances_update" ON checklist_instances FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR (turnover_id IN (
      SELECT ta.turnover_id FROM turnover_assignments ta
      JOIN crew_members cm ON cm.id = ta.crew_member_id
      WHERE cm.user_id = (SELECT auth.uid())
    ))
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR (turnover_id IN (
      SELECT ta.turnover_id FROM turnover_assignments ta
      JOIN crew_members cm ON cm.id = ta.crew_member_id
      WHERE cm.user_id = (SELECT auth.uid())
    ))
  );

-- ── crew_feedback ────────────────────────────────────────────────────────
-- cf_org_members_select and crew_feedback_select were byte-identical
-- duplicates — drop one outright, then merge the remaining SELECT policies.
DROP POLICY IF EXISTS "cf_org_members_select" ON crew_feedback;
DROP POLICY IF EXISTS "crew_feedback_select" ON crew_feedback;
DROP POLICY IF EXISTS "crew_feedback_staff_select" ON crew_feedback;

CREATE POLICY "crew_feedback_select" ON crew_feedback FOR SELECT
  USING (
    (org_id IN (SELECT get_user_org_ids()))
    OR is_platform_staff()
  );

-- Split crew_feedback_manage (FOR ALL) into INSERT/UPDATE/DELETE, folding
-- in cf_restrict_insert's always-false check (a no-op when OR'd — see the
-- flagged note above; behavior is unchanged).
DROP POLICY IF EXISTS "crew_feedback_manage" ON crew_feedback;
DROP POLICY IF EXISTS "cf_restrict_insert" ON crew_feedback;

CREATE POLICY "crew_feedback_insert" ON crew_feedback FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "crew_feedback_update" ON crew_feedback FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "crew_feedback_delete" ON crew_feedback FOR DELETE
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ── work_orders ──────────────────────────────────────────────────────────
-- Two SELECT policies (crew's own assigned WOs vs. org member) merge to one.
DROP POLICY IF EXISTS "wo_crew_member_read" ON work_orders;
DROP POLICY IF EXISTS "work_orders_select" ON work_orders;

CREATE POLICY "work_orders_select" ON work_orders FOR SELECT
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR (org_id IN (SELECT get_user_org_ids()))
    OR (assigned_crew_member_id IN (
      SELECT crew_members.id FROM crew_members WHERE crew_members.user_id = (SELECT auth.uid())
    ))
  );

-- ── property_assets ──────────────────────────────────────────────────────
-- Two SELECT policies and two INSERT policies (crew-scoped discovery vs.
-- admin/manager) each merge to one.
DROP POLICY IF EXISTS "property_assets_crew_select" ON property_assets;
DROP POLICY IF EXISTS "property_assets_select" ON property_assets;

CREATE POLICY "property_assets_select" ON property_assets FOR SELECT
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR (org_id IN (SELECT get_user_org_ids()))
    OR (
      (EXISTS (SELECT 1 FROM properties p WHERE p.id = property_assets.property_id AND p.org_id = property_assets.org_id))
      AND (
        (property_id IN (
          SELECT DISTINCT t.property_id FROM turnovers t
          JOIN turnover_assignments ta ON ta.turnover_id = t.id
          JOIN crew_members cm ON ta.crew_member_id = cm.id
          WHERE cm.user_id = (SELECT auth.uid()) AND cm.org_id = property_assets.org_id
        ))
        OR (property_id IN (
          SELECT wo.property_id FROM work_orders wo
          JOIN crew_members cm ON wo.assigned_crew_member_id = cm.id
          WHERE cm.user_id = (SELECT auth.uid()) AND cm.org_id = property_assets.org_id
        ))
      )
    )
  );

DROP POLICY IF EXISTS "property_assets_crew_insert" ON property_assets;
DROP POLICY IF EXISTS "property_assets_insert" ON property_assets;

CREATE POLICY "property_assets_insert" ON property_assets FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR (
      (EXISTS (SELECT 1 FROM properties p WHERE p.id = property_assets.property_id AND p.org_id = property_assets.org_id))
      AND (
        (property_id IN (
          SELECT DISTINCT t.property_id FROM turnovers t
          JOIN turnover_assignments ta ON ta.turnover_id = t.id
          JOIN crew_members cm ON ta.crew_member_id = cm.id
          WHERE cm.user_id = (SELECT auth.uid()) AND cm.org_id = property_assets.org_id
        ))
        OR (property_id IN (
          SELECT wo.property_id FROM work_orders wo
          JOIN crew_members cm ON wo.assigned_crew_member_id = cm.id
          WHERE cm.user_id = (SELECT auth.uid()) AND cm.org_id = property_assets.org_id
        ))
      )
      AND serial_number IS NULL
      AND installation_date IS NULL
      AND manufacture_date IS NULL
      AND purchase_price IS NULL
      AND estimated_replacement_cost IS NULL
      AND expected_lifespan_years IS NULL
      AND warranty_expiry_date IS NULL
      AND warranty_provider IS NULL
      AND warranty_notes IS NULL
      AND placed_in_service_date IS NULL
      AND health_score IS NULL
      AND health_score_updated_at IS NULL
      AND replaced_by_asset_id IS NULL
      AND verified_at IS NULL
      AND macrs_class = '5_year'::macrs_class
      AND depreciation_method = 'macrs'::text
      AND salvage_value = (0)::numeric
      AND replacement_status = 'projected'::text
      AND is_active = true
    )
  );

-- ── platform_staff ───────────────────────────────────────────────────────
-- platform_staff_select_own ({authenticated}) and platform_staff_self_select
-- ({public}) had the identical qual — the {public}-scoped one is a strict
-- superset, so the {authenticated}-scoped duplicate is dropped outright.
-- platform_staff_restrict_write (FOR ALL, qual/with_check = false) is left
-- untouched — it's the sole guard blocking direct writes via any
-- authenticated role and is out of scope for this performance-only pass.
DROP POLICY IF EXISTS "platform_staff_select_own" ON platform_staff;

-- ── push_subscriptions ───────────────────────────────────────────────────
-- Two of the three FOR ALL policies were byte-identical duplicates
-- ("Crew members manage own..." / "crew manage own..."); merge the
-- remaining two distinct scopes (crew-linked vs. direct user_id) into one.
DROP POLICY IF EXISTS "Crew members manage own push subscriptions" ON push_subscriptions;
DROP POLICY IF EXISTS "crew manage own push subscriptions" ON push_subscriptions;
DROP POLICY IF EXISTS "org members manage own push subscriptions" ON push_subscriptions;

CREATE POLICY "push_subscriptions_manage" ON push_subscriptions FOR ALL
  USING (
    (crew_member_id IN (SELECT crew_members.id FROM crew_members WHERE crew_members.user_id = (SELECT auth.uid())))
    OR (user_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    (crew_member_id IN (SELECT crew_members.id FROM crew_members WHERE crew_members.user_id = (SELECT auth.uid())))
    OR (user_id = (SELECT auth.uid()))
  );

-- ── support_conversations ────────────────────────────────────────────────
-- "org members access own conversations" was FOR ALL; split into per-command
-- policies and merge the SELECT/UPDATE overlap with the staff policies.
DROP POLICY IF EXISTS "org members access own conversations" ON support_conversations;
DROP POLICY IF EXISTS "support_conversations_staff_select" ON support_conversations;
DROP POLICY IF EXISTS "support_conversations_staff_update" ON support_conversations;

CREATE POLICY "support_conversations_insert" ON support_conversations FOR INSERT
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND org_id IN (SELECT organization_members.org_id FROM organization_members WHERE organization_members.user_id = (SELECT auth.uid()))
  );

CREATE POLICY "support_conversations_select" ON support_conversations FOR SELECT
  USING (
    (
      user_id = (SELECT auth.uid())
      AND org_id IN (SELECT organization_members.org_id FROM organization_members WHERE organization_members.user_id = (SELECT auth.uid()))
    )
    OR is_platform_staff()
  );

CREATE POLICY "support_conversations_update" ON support_conversations FOR UPDATE
  USING (
    (
      user_id = (SELECT auth.uid())
      AND org_id IN (SELECT organization_members.org_id FROM organization_members WHERE organization_members.user_id = (SELECT auth.uid()))
    )
    OR is_platform_staff()
  )
  WITH CHECK (
    (
      user_id = (SELECT auth.uid())
      AND org_id IN (SELECT organization_members.org_id FROM organization_members WHERE organization_members.user_id = (SELECT auth.uid()))
    )
    OR is_platform_staff()
  );

CREATE POLICY "support_conversations_delete" ON support_conversations FOR DELETE
  USING (
    user_id = (SELECT auth.uid())
    AND org_id IN (SELECT organization_members.org_id FROM organization_members WHERE organization_members.user_id = (SELECT auth.uid()))
  );

-- ── support_messages ─────────────────────────────────────────────────────
-- Same split-and-merge shape as support_conversations above.
DROP POLICY IF EXISTS "org members access own conversation messages" ON support_messages;
DROP POLICY IF EXISTS "support_messages_staff_insert" ON support_messages;
DROP POLICY IF EXISTS "support_messages_staff_select" ON support_messages;

CREATE POLICY "support_messages_insert" ON support_messages FOR INSERT
  WITH CHECK (
    (conversation_id IN (
      SELECT support_conversations.id FROM support_conversations
      WHERE support_conversations.user_id = (SELECT auth.uid())
        AND support_conversations.org_id IN (SELECT organization_members.org_id FROM organization_members WHERE organization_members.user_id = (SELECT auth.uid()))
    ))
    OR is_platform_staff()
  );

CREATE POLICY "support_messages_select" ON support_messages FOR SELECT
  USING (
    (conversation_id IN (
      SELECT support_conversations.id FROM support_conversations
      WHERE support_conversations.user_id = (SELECT auth.uid())
        AND support_conversations.org_id IN (SELECT organization_members.org_id FROM organization_members WHERE organization_members.user_id = (SELECT auth.uid()))
    ))
    OR is_platform_staff()
  );

CREATE POLICY "support_messages_update" ON support_messages FOR UPDATE
  USING (
    conversation_id IN (
      SELECT support_conversations.id FROM support_conversations
      WHERE support_conversations.user_id = (SELECT auth.uid())
        AND support_conversations.org_id IN (SELECT organization_members.org_id FROM organization_members WHERE organization_members.user_id = (SELECT auth.uid()))
    )
  )
  WITH CHECK (
    conversation_id IN (
      SELECT support_conversations.id FROM support_conversations
      WHERE support_conversations.user_id = (SELECT auth.uid())
        AND support_conversations.org_id IN (SELECT organization_members.org_id FROM organization_members WHERE organization_members.user_id = (SELECT auth.uid()))
    )
  );

CREATE POLICY "support_messages_delete" ON support_messages FOR DELETE
  USING (
    conversation_id IN (
      SELECT support_conversations.id FROM support_conversations
      WHERE support_conversations.user_id = (SELECT auth.uid())
        AND support_conversations.org_id IN (SELECT organization_members.org_id FROM organization_members WHERE organization_members.user_id = (SELECT auth.uid()))
    )
  );

-- ── inventory_counts ─────────────────────────────────────────────────────
-- Two INSERT policies (admin/manager vs. crew's own submission) merge to one.
DROP POLICY IF EXISTS "inventory_counts_admin_manager_insert" ON inventory_counts;
DROP POLICY IF EXISTS "inventory_counts_crew_insert" ON inventory_counts;

CREATE POLICY "inventory_counts_insert" ON inventory_counts FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR (submitted_by_crew_id IN (SELECT crew_members.id FROM crew_members WHERE crew_members.user_id = (SELECT auth.uid())))
  );

-- ── inventory_count_items ────────────────────────────────────────────────
-- Two INSERT policies (admin/manager vs. crew's own count) merge to one.
DROP POLICY IF EXISTS "count_items_admin_manager_insert" ON inventory_count_items;
DROP POLICY IF EXISTS "count_items_crew_insert" ON inventory_count_items;

CREATE POLICY "inventory_count_items_insert" ON inventory_count_items FOR INSERT
  WITH CHECK (
    (count_id IN (SELECT ic.id FROM inventory_counts ic WHERE is_org_member(ic.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
    OR (count_id IN (
      SELECT ic.id FROM inventory_counts ic
      JOIN crew_members cm ON ic.submitted_by_crew_id = cm.id
      WHERE cm.user_id = (SELECT auth.uid())
    ))
  );
