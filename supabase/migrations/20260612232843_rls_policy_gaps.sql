-- ── H-1: stripe_processed_events — deny-all (service role manages) ──────────
CREATE POLICY stripe_events_deny_all
  ON public.stripe_processed_events
  FOR ALL
  USING (false);

-- ── H-2: wo_number_counters — deny-all (DB trigger manages) ─────────────────
CREATE POLICY wo_counters_deny_all
  ON public.wo_number_counters
  FOR ALL
  USING (false);

-- ── H-3: integration_connections — explicit deny for writes ─────────────────
CREATE POLICY integration_connections_deny_insert
  ON public.integration_connections FOR INSERT WITH CHECK (false);

CREATE POLICY integration_connections_deny_update
  ON public.integration_connections FOR UPDATE USING (false);

CREATE POLICY integration_connections_deny_delete
  ON public.integration_connections FOR DELETE USING (false);

-- ── H-4: audit_events — enforce append-only at DB layer ─────────────────────
CREATE POLICY audit_events_deny_update
  ON public.audit_events FOR UPDATE USING (false);

CREATE POLICY audit_events_deny_delete
  ON public.audit_events FOR DELETE USING (false);

-- ── H-5: messages — add DELETE for right-to-erasure + moderation ────────────
CREATE POLICY messages_delete
  ON public.messages FOR DELETE
  USING (
    sender_id = auth.uid()
    OR
    org_id IN (
      SELECT org_id FROM organization_members
      WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin')
        AND invite_accepted_at IS NOT NULL
    )
  );

-- ── H-7: work_order_line_items — add UPDATE policy ───────────────────────────
CREATE POLICY work_order_line_items_update
  ON public.work_order_line_items FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

-- ── H-8: inventory_counts — add UPDATE and DELETE for manager corrections ────
CREATE POLICY inventory_counts_update
  ON public.inventory_counts FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY inventory_counts_delete
  ON public.inventory_counts FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );
