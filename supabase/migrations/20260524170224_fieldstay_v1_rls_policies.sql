
-- PROFILES
CREATE POLICY "Users manage own profile"
  ON profiles FOR ALL
  USING (id = auth.uid());

-- ORGANIZATIONS
CREATE POLICY "Members can view their org"
  ON organizations FOR SELECT
  USING (id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins can update their org"
  ON organizations FOR UPDATE
  USING (is_org_member(id, ARRAY['admin']::member_role[]));

-- ORGANIZATION MEMBERS
CREATE POLICY "Members can view org roster"
  ON organization_members FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins manage org members"
  ON organization_members FOR ALL
  USING (is_org_member(org_id, ARRAY['admin']::member_role[]));

-- PROPERTIES
CREATE POLICY "Org members can view properties"
  ON properties FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage properties"
  ON properties FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- PROPERTY OWNERS
CREATE POLICY "Admins and managers manage property owners"
  ON property_owners FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- OWNER PORTAL TOKENS
CREATE POLICY "Admins and managers manage portal tokens"
  ON owner_portal_tokens FOR ALL
  USING (
    property_owner_id IN (
      SELECT id FROM property_owners
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

-- ICAL FEEDS
CREATE POLICY "Admins and managers manage ical feeds"
  ON ical_feeds FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- BOOKINGS
CREATE POLICY "Org members can view bookings"
  ON bookings FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage bookings"
  ON bookings FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- CREW MEMBERS
CREATE POLICY "Org members can view crew"
  ON crew_members FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage crew"
  ON crew_members FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

CREATE POLICY "Crew can view own record"
  ON crew_members FOR SELECT
  USING (user_id = auth.uid());

-- VENDORS
CREATE POLICY "Org members can view vendors"
  ON vendors FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage vendors"
  ON vendors FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- CHECKLIST TEMPLATES
CREATE POLICY "Org members can view checklist templates"
  ON checklist_templates FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage checklist templates"
  ON checklist_templates FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- CHECKLIST TEMPLATE SECTIONS
CREATE POLICY "Org members can view template sections"
  ON checklist_template_sections FOR SELECT
  USING (
    template_id IN (
      SELECT id FROM checklist_templates
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins and managers manage template sections"
  ON checklist_template_sections FOR ALL
  USING (
    template_id IN (
      SELECT id FROM checklist_templates
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

-- CHECKLIST TEMPLATE ITEMS
CREATE POLICY "Org members can view template items"
  ON checklist_template_items FOR SELECT
  USING (
    template_id IN (
      SELECT id FROM checklist_templates
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins and managers manage template items"
  ON checklist_template_items FOR ALL
  USING (
    template_id IN (
      SELECT id FROM checklist_templates
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

-- TURNOVERS
CREATE POLICY "Org members can view turnovers"
  ON turnovers FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage turnovers"
  ON turnovers FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

CREATE POLICY "Crew can view their assigned turnovers"
  ON turnovers FOR SELECT
  USING (
    id IN (
      SELECT ta.turnover_id
      FROM turnover_assignments ta
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

CREATE POLICY "Crew can update their assigned turnover status"
  ON turnovers FOR UPDATE
  USING (
    id IN (
      SELECT ta.turnover_id
      FROM turnover_assignments ta
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

-- TURNOVER ASSIGNMENTS
CREATE POLICY "Org members can view assignments"
  ON turnover_assignments FOR SELECT
  USING (
    turnover_id IN (
      SELECT id FROM turnovers
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins and managers manage assignments"
  ON turnover_assignments FOR ALL
  USING (
    turnover_id IN (
      SELECT id FROM turnovers
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

CREATE POLICY "Crew can view own assignments"
  ON turnover_assignments FOR SELECT
  USING (
    crew_member_id IN (
      SELECT id FROM crew_members WHERE user_id = auth.uid()
    )
  );

-- CHECKLIST INSTANCES
CREATE POLICY "Org members can view checklist instances"
  ON checklist_instances FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage checklist instances"
  ON checklist_instances FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

CREATE POLICY "Crew can view instances for their turnovers"
  ON checklist_instances FOR SELECT
  USING (
    turnover_id IN (
      SELECT ta.turnover_id
      FROM turnover_assignments ta
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

-- CHECKLIST INSTANCE ITEMS
CREATE POLICY "Org members can view instance items"
  ON checklist_instance_items FOR SELECT
  USING (
    instance_id IN (
      SELECT id FROM checklist_instances
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins and managers manage instance items"
  ON checklist_instance_items FOR ALL
  USING (
    instance_id IN (
      SELECT id FROM checklist_instances
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

CREATE POLICY "Crew can update items for their turnovers"
  ON checklist_instance_items FOR UPDATE
  USING (
    instance_id IN (
      SELECT ci.id FROM checklist_instances ci
      JOIN turnover_assignments ta ON ci.turnover_id = ta.turnover_id
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

-- INVENTORY CATALOG (public read)
CREATE POLICY "Anyone can read inventory catalog"
  ON inventory_catalog FOR SELECT
  USING (true);

-- INVENTORY ITEMS
CREATE POLICY "Org members can view inventory items"
  ON inventory_items FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage inventory items"
  ON inventory_items FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

CREATE POLICY "Crew can view inventory for assigned properties"
  ON inventory_items FOR SELECT
  USING (
    property_id IN (
      SELECT DISTINCT t.property_id
      FROM turnovers t
      JOIN turnover_assignments ta ON ta.turnover_id = t.id
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

-- INVENTORY COUNTS
CREATE POLICY "Admins and managers can view all counts"
  ON inventory_counts FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Crew can submit inventory counts"
  ON inventory_counts FOR INSERT
  WITH CHECK (
    submitted_by_crew_id IN (
      SELECT id FROM crew_members WHERE user_id = auth.uid()
    )
  );

-- INVENTORY COUNT ITEMS
CREATE POLICY "Org members can view count items"
  ON inventory_count_items FOR SELECT
  USING (
    count_id IN (
      SELECT id FROM inventory_counts
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Crew can insert count items"
  ON inventory_count_items FOR INSERT
  WITH CHECK (
    count_id IN (
      SELECT ic.id FROM inventory_counts ic
      JOIN crew_members cm ON ic.submitted_by_crew_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

-- PURCHASE ORDERS
CREATE POLICY "Admins and managers manage purchase orders"
  ON purchase_orders FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

CREATE POLICY "Admins and managers manage PO items"
  ON purchase_order_items FOR ALL
  USING (
    purchase_order_id IN (
      SELECT id FROM purchase_orders
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

-- WORK ORDERS
CREATE POLICY "Org members can view work orders"
  ON work_orders FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage work orders"
  ON work_orders FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- WORK ORDER UPDATES
CREATE POLICY "Org members can view work order updates"
  ON work_order_updates FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers insert work order updates"
  ON work_order_updates FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- WORK ORDER PHOTOS
CREATE POLICY "Org members can view work order photos"
  ON work_order_photos FOR SELECT
  USING (
    work_order_id IN (
      SELECT id FROM work_orders
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins and managers manage work order photos"
  ON work_order_photos FOR ALL
  USING (
    work_order_id IN (
      SELECT id FROM work_orders
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

-- MAINTENANCE SCHEDULES
CREATE POLICY "Org members can view maintenance schedules"
  ON maintenance_schedules FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage maintenance schedules"
  ON maintenance_schedules FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- GUEST MESSAGE TEMPLATES
CREATE POLICY "Admins and managers manage message templates"
  ON guest_message_templates FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- GUEST MESSAGES SENT
CREATE POLICY "Admins and managers can view sent messages"
  ON guest_messages_sent FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- OWNER TRANSACTIONS
CREATE POLICY "Admins and managers manage transactions"
  ON owner_transactions FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));
