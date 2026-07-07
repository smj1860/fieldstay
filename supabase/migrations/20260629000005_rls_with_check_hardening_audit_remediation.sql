
-- ─────────────────────────────────────────────────────────────────────────────
-- RLS WITH CHECK hardening — audit remediation 2026-06-28
--
-- Adds explicit WITH CHECK clauses to every FOR ALL / FOR UPDATE / FOR INSERT
-- policy that was missing one. Postgres falls back to USING for new-row
-- validation when WITH CHECK is absent, but this codebase mandates explicit
-- WITH CHECK on all write-capable policies. Deny policies (USING = false) are
-- intentionally excluded — their effective WITH CHECK is false via fallback.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. organization_members — CRITICAL (all other RLS depends on this table) ─
DROP POLICY IF EXISTS "org_members_admin_manage" ON organization_members;
CREATE POLICY "org_members_admin_manage" ON organization_members
  FOR UPDATE
  USING     (is_org_member(org_id, ARRAY['admin'::member_role]))
  WITH CHECK(is_org_member(org_id, ARRAY['admin'::member_role]));

-- ── 2. organizations ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "orgs_update" ON organizations;
CREATE POLICY "orgs_update" ON organizations
  FOR UPDATE
  USING     (is_org_member(id, ARRAY['admin'::member_role]))
  WITH CHECK(is_org_member(id, ARRAY['admin'::member_role]));

-- ── 3. ical_feeds ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "ical_feeds_manage" ON ical_feeds;
CREATE POLICY "ical_feeds_manage" ON ical_feeds
  FOR ALL
  USING     (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK(is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ── 4. org_invites ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Owners can manage org invites" ON org_invites;
CREATE POLICY "Owners can manage org invites" ON org_invites
  FOR ALL
  USING (
    org_id IN (
      SELECT organization_members.org_id
      FROM   organization_members
      WHERE  organization_members.user_id = (SELECT auth.uid())
        AND  organization_members.role = 'owner'::member_role
    )
  )
  WITH CHECK (
    org_id IN (
      SELECT organization_members.org_id
      FROM   organization_members
      WHERE  organization_members.user_id = (SELECT auth.uid())
        AND  organization_members.role = 'owner'::member_role
    )
  );

-- ── 5. org_master_checklist_items ────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins and managers manage master checklist" ON org_master_checklist_items;
CREATE POLICY "Admins and managers manage master checklist" ON org_master_checklist_items
  FOR ALL
  USING     (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK(is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

-- ── 6. org_master_maintenance_schedules ──────────────────────────────────────
DROP POLICY IF EXISTS "Admins managers owners manage master maintenance" ON org_master_maintenance_schedules;
CREATE POLICY "Admins managers owners manage master maintenance" ON org_master_maintenance_schedules
  FOR ALL
  USING     (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK(is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

-- ── 7. owner_portal_tokens ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "portal_tokens_manage" ON owner_portal_tokens;
CREATE POLICY "portal_tokens_manage" ON owner_portal_tokens
  FOR ALL
  USING (
    property_owner_id IN (
      SELECT property_owners.id
      FROM   property_owners
      WHERE  is_org_member(property_owners.org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    )
  )
  WITH CHECK (
    property_owner_id IN (
      SELECT property_owners.id
      FROM   property_owners
      WHERE  is_org_member(property_owners.org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    )
  );

-- ── 8. profiles ──────────────────────────────────────────────────────────────
-- WITH CHECK prevents a user from updating their profile's id to someone else's
DROP POLICY IF EXISTS "profiles_own" ON profiles;
CREATE POLICY "profiles_own" ON profiles
  FOR ALL
  USING     (id = (SELECT auth.uid()))
  WITH CHECK(id = (SELECT auth.uid()));

-- ── 9. purchase_order_items ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "po_items_manage" ON purchase_order_items;
CREATE POLICY "po_items_manage" ON purchase_order_items
  FOR ALL
  USING (
    purchase_order_id IN (
      SELECT purchase_orders.id
      FROM   purchase_orders
      WHERE  is_org_member(purchase_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    )
  )
  WITH CHECK (
    purchase_order_id IN (
      SELECT purchase_orders.id
      FROM   purchase_orders
      WHERE  is_org_member(purchase_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    )
  );

-- ── 10. push_subscriptions ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "Crew members manage own push subscriptions" ON push_subscriptions;
CREATE POLICY "Crew members manage own push subscriptions" ON push_subscriptions
  FOR ALL
  USING (
    crew_member_id IN (
      SELECT crew_members.id
      FROM   crew_members
      WHERE  crew_members.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    crew_member_id IN (
      SELECT crew_members.id
      FROM   crew_members
      WHERE  crew_members.user_id = (SELECT auth.uid())
    )
  );
