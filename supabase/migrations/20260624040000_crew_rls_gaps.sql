-- Crew-scoped RLS gaps found auditing the Dexie sync layer (lib/dexie/*):
--
-- 1. work_orders had no INSERT path for crew. app/api/crew/issue-reports/route.ts
--    inserts source='crew_flag' rows using the RLS-enforced client on behalf of
--    a crew member, but the only INSERT policy was admin/manager-only — every
--    "Report an Issue" submission from the crew PWA failed.
--
-- 2. inventory_items had no UPDATE path for crew. lib/dexie/syncService.ts's
--    inventory_items branch pushes crew-entered counts (queued from the
--    turnover detail page's inventory stepper) via a direct client-side
--    update, but the only UPDATE policy was admin/manager-only. Postgres
--    silently matches zero rows in this case rather than erroring, so the
--    count was dropped with no visible failure to the crew member or PM.
--
-- Both additions mirror the crew-via-turnover-assignment clause already used
-- by inventory_items_select.

DROP POLICY IF EXISTS "work_orders_insert" ON work_orders;
CREATE POLICY "work_orders_insert" ON work_orders FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  OR (
      source = 'crew_flag'
      AND org_id IN (
        SELECT crew_members.org_id FROM crew_members
        WHERE crew_members.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "inventory_items_update" ON inventory_items;
CREATE POLICY "inventory_items_update" ON inventory_items FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  OR (property_id IN ( SELECT DISTINCT t.property_id
       FROM ((turnovers t
         JOIN turnover_assignments ta ON ((ta.turnover_id = t.id)))
         JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
      WHERE (cm.user_id = auth.uid())))
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  OR (property_id IN ( SELECT DISTINCT t.property_id
       FROM ((turnovers t
         JOIN turnover_assignments ta ON ((ta.turnover_id = t.id)))
         JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
      WHERE (cm.user_id = auth.uid())))
  );
