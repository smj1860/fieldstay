-- Task 2: Fix auth.<function>() initplan re-evaluation
-- Wraps bare auth.uid()/auth.jwt()/auth.role() calls in (select ...) so Postgres
-- evaluates them once per query instead of once per row. Authorization logic unchanged.

-- asset_type_standards.asset_type_standards_select
DROP POLICY IF EXISTS "asset_type_standards_select" ON asset_type_standards;
CREATE POLICY "asset_type_standards_select" ON asset_type_standards FOR SELECT
  USING (
    ((select auth.role()) = 'authenticated'::text)
  );

-- checklist_instance_items.checklist_instance_items_update
DROP POLICY IF EXISTS "checklist_instance_items_update" ON checklist_instance_items;
CREATE POLICY "checklist_instance_items_update" ON checklist_instance_items FOR UPDATE
  USING (
    ((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))) OR (instance_id IN ( SELECT ci.id
   FROM ((checklist_instances ci
     JOIN turnover_assignments ta ON ((ci.turnover_id = ta.turnover_id)))
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = (select auth.uid())))))
  )
  WITH CHECK (
    ((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))) OR (instance_id IN ( SELECT ci.id
   FROM ((checklist_instances ci
     JOIN turnover_assignments ta ON ((ci.turnover_id = ta.turnover_id)))
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = (select auth.uid())))))
  );

-- checklist_instances.checklist_instances_select
DROP POLICY IF EXISTS "checklist_instances_select" ON checklist_instances;
CREATE POLICY "checklist_instances_select" ON checklist_instances FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (turnover_id IN ( SELECT ta.turnover_id
   FROM (turnover_assignments ta
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = (select auth.uid())))) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

-- crew_availability.crew_availability_delete
DROP POLICY IF EXISTS "crew_availability_delete" ON crew_availability;
CREATE POLICY "crew_availability_delete" ON crew_availability FOR DELETE
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = (select auth.uid())))))
  );

-- crew_availability.crew_availability_insert
DROP POLICY IF EXISTS "crew_availability_insert" ON crew_availability;
CREATE POLICY "crew_availability_insert" ON crew_availability FOR INSERT
  WITH CHECK (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = (select auth.uid())))))
  );

-- crew_availability.crew_availability_select
DROP POLICY IF EXISTS "crew_availability_select" ON crew_availability;
CREATE POLICY "crew_availability_select" ON crew_availability FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = (select auth.uid())))) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

-- crew_availability.crew_availability_update
DROP POLICY IF EXISTS "crew_availability_update" ON crew_availability;
CREATE POLICY "crew_availability_update" ON crew_availability FOR UPDATE
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = (select auth.uid())))))
  )
  WITH CHECK (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = (select auth.uid())))))
  );

-- crew_members.crew_members_select
DROP POLICY IF EXISTS "crew_members_select" ON crew_members;
CREATE POLICY "crew_members_select" ON crew_members FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (user_id = (select auth.uid())))
  );

-- integration_connections.integration_connections_select
DROP POLICY IF EXISTS "integration_connections_select" ON integration_connections;
CREATE POLICY "integration_connections_select" ON integration_connections FOR SELECT
  USING (
    ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR ((select auth.uid()) = user_id))
  );

-- inventory_count_items.count_items_crew_insert
DROP POLICY IF EXISTS "count_items_crew_insert" ON inventory_count_items;
CREATE POLICY "count_items_crew_insert" ON inventory_count_items FOR INSERT
  WITH CHECK (
    (count_id IN ( SELECT ic.id
   FROM (inventory_counts ic
     JOIN crew_members cm ON ((ic.submitted_by_crew_id = cm.id)))
  WHERE (cm.user_id = (select auth.uid()))))
  );

-- inventory_counts.inventory_counts_crew_insert
DROP POLICY IF EXISTS "inventory_counts_crew_insert" ON inventory_counts;
CREATE POLICY "inventory_counts_crew_insert" ON inventory_counts FOR INSERT
  WITH CHECK (
    (submitted_by_crew_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = (select auth.uid()))))
  );

-- inventory_items.inventory_items_select
DROP POLICY IF EXISTS "inventory_items_select" ON inventory_items;
CREATE POLICY "inventory_items_select" ON inventory_items FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (property_id IN ( SELECT DISTINCT t.property_id
   FROM ((turnovers t
     JOIN turnover_assignments ta ON ((ta.turnover_id = t.id)))
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = (select auth.uid())))) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

-- maintenance_catalog_items.catalog_items_authenticated_read
DROP POLICY IF EXISTS "catalog_items_authenticated_read" ON maintenance_catalog_items;
CREATE POLICY "catalog_items_authenticated_read" ON maintenance_catalog_items FOR SELECT
  USING (
    (((select auth.uid()) IS NOT NULL) AND (is_active = true))
  );

-- messages.messages_delete
DROP POLICY IF EXISTS "messages_delete" ON messages;
CREATE POLICY "messages_delete" ON messages FOR DELETE
  USING (
    ((sender_id = (select auth.uid())) OR (org_id IN ( SELECT organization_members.org_id
   FROM organization_members
  WHERE ((organization_members.user_id = (select auth.uid())) AND (organization_members.role = ANY (ARRAY['owner'::member_role, 'admin'::member_role])) AND (organization_members.invite_accepted_at IS NOT NULL)))))
  );

-- messages.messages_insert
DROP POLICY IF EXISTS "messages_insert" ON messages;
CREATE POLICY "messages_insert" ON messages FOR INSERT
  WITH CHECK (
    ((sender_id = (select auth.uid())) AND ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (org_id IN ( SELECT crew_members.org_id
   FROM crew_members
  WHERE (crew_members.user_id = (select auth.uid()))))))
  );

-- messages.messages_select
DROP POLICY IF EXISTS "messages_select" ON messages;
CREATE POLICY "messages_select" ON messages FOR SELECT
  USING (
    ((sender_id = (select auth.uid())) OR (recipient_id = (select auth.uid())))
  );

-- messages.messages_mark_read
DROP POLICY IF EXISTS "messages_mark_read" ON messages;
CREATE POLICY "messages_mark_read" ON messages FOR UPDATE
  USING (
    (recipient_id = (select auth.uid()))
  )
  WITH CHECK (
    (recipient_id = (select auth.uid()))
  );

-- org_invites."Owners can manage org invites"
DROP POLICY IF EXISTS "Owners can manage org invites" ON org_invites;
CREATE POLICY "Owners can manage org invites" ON org_invites FOR ALL
  USING (
    (org_id IN ( SELECT organization_members.org_id
   FROM organization_members
  WHERE ((organization_members.user_id = (select auth.uid())) AND (organization_members.role = 'owner'::member_role))))
  );

-- organization_members.org_members_insert_self
DROP POLICY IF EXISTS "org_members_insert_self" ON organization_members;
CREATE POLICY "org_members_insert_self" ON organization_members FOR INSERT
  WITH CHECK (
    (user_id = (select auth.uid()))
  );

-- organizations.orgs_insert
DROP POLICY IF EXISTS "orgs_insert" ON organizations;
CREATE POLICY "orgs_insert" ON organizations FOR INSERT
  WITH CHECK (
    ((select auth.uid()) IS NOT NULL)
  );

-- profiles.profiles_own
DROP POLICY IF EXISTS "profiles_own" ON profiles;
CREATE POLICY "profiles_own" ON profiles FOR ALL
  USING (
    (id = (select auth.uid()))
  );

-- push_subscriptions."Crew members manage own push subscriptions"
DROP POLICY IF EXISTS "Crew members manage own push subscriptions" ON push_subscriptions;
CREATE POLICY "Crew members manage own push subscriptions" ON push_subscriptions FOR ALL
  USING (
    (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = (select auth.uid()))))
  );

-- reviews.reviews_select
DROP POLICY IF EXISTS "reviews_select" ON reviews;
CREATE POLICY "reviews_select" ON reviews FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]) OR (org_id IN ( SELECT organization_members.org_id
   FROM organization_members
  WHERE (organization_members.user_id = (select auth.uid())))))
  );

-- turnover_assignments.turnover_assignments_select
DROP POLICY IF EXISTS "turnover_assignments_select" ON turnover_assignments;
CREATE POLICY "turnover_assignments_select" ON turnover_assignments FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = (select auth.uid())))) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );
