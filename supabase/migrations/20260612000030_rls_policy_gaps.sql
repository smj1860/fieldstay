-- ── H-1: stripe_processed_events — deny-all (service role manages) ──────────
-- This table is managed exclusively by the Stripe webhook handler via service
-- role. Deny-all documents intent and prevents accidental user-client access
-- that would silently return no rows and re-process events.
CREATE POLICY stripe_events_deny_all
  ON public.stripe_processed_events
  FOR ALL
  USING (false);

-- ── H-2: wo_number_counters — deny-all (DB trigger manages) ─────────────────
-- Work order numbers are incremented by a DB trigger running as trigger owner,
-- which bypasses RLS. Deny-all prevents user-context reads that would silently
-- return no rows and cause silent WO number generation failures.
CREATE POLICY wo_counters_deny_all
  ON public.wo_number_counters
  FOR ALL
  USING (false);

-- ── H-3: integration_connections — explicit deny for writes ─────────────────
-- All writes go through the service role client in lib/integrations/vault.ts.
-- Documenting this intent prevents future developer confusion and guards
-- against accidental user-context writes.
CREATE POLICY integration_connections_deny_insert
  ON public.integration_connections FOR INSERT WITH CHECK (false);

CREATE POLICY integration_connections_deny_update
  ON public.integration_connections FOR UPDATE USING (false);

CREATE POLICY integration_connections_deny_delete
  ON public.integration_connections FOR DELETE USING (false);

-- ── H-4: audit_events — enforce append-only at DB layer ─────────────────────
-- The audit log must be immutable. RLS enforces this even if service-role
-- conventions are ever bypassed. INSERT and SELECT policies already exist.
CREATE POLICY audit_events_deny_update
  ON public.audit_events FOR UPDATE USING (false);

CREATE POLICY audit_events_deny_delete
  ON public.audit_events FOR DELETE USING (false);

-- ── H-5: messages — add DELETE for right-to-erasure + moderation ────────────
CREATE POLICY messages_delete
  ON public.messages FOR DELETE
  USING (
    -- Sender can delete their own messages
    sender_id = auth.uid()
    OR
    -- Org admins and owners can delete any message in their org
    org_id IN (
      SELECT org_id FROM organization_members
      WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin')
        AND invite_accepted_at IS NOT NULL
    )
  );

-- ── H-6: guest_messages_sent — table does not yet exist in this project.
-- When the table is created, add:
--   CREATE POLICY guest_messages_deny_update ON public.guest_messages_sent FOR UPDATE USING (false);
--   CREATE POLICY guest_messages_deny_delete ON public.guest_messages_sent FOR DELETE USING (false);

-- ── H-7: work_order_line_items — add UPDATE policy ───────────────────────────
-- Without an UPDATE policy, managers cannot edit line items after insertion.
CREATE POLICY work_order_line_items_update
  ON public.work_order_line_items FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

-- ── H-8: inventory_counts — add UPDATE and DELETE for manager corrections ────
-- Without these, managers cannot correct an erroneous crew count submission.
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
