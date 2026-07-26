-- Crew Sync v2 Phase 2: broadcast wake-up signals for the crew PWA.
-- Statement-level triggers call realtime.send() on topic 'crew:{user_id}'
-- with a minimal {entity} payload. Signal-only: no row data, no PII.
-- Deploys dark — no client subscribes until the Phase 3 cutover.

-- ── Shared send helper ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_crew_sync(p_user_ids uuid[], p_entity text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF p_user_ids IS NULL THEN
    RETURN;
  END IF;
  FOR v_user_id IN SELECT DISTINCT u FROM unnest(p_user_ids) AS u WHERE u IS NOT NULL
  LOOP
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('entity', p_entity),  -- payload: signal only, never row data
        'sync',                                  -- event
        'crew:' || v_user_id::text,              -- topic
        true                                     -- private channel
      );
    EXCEPTION WHEN OTHERS THEN
      -- A broadcast failure must never break the write that triggered it.
      RAISE WARNING 'notify_crew_sync: send failed for user % (%): %',
        v_user_id, p_entity, SQLERRM;
    END;
  END LOOP;
END;
$$;

-- Not callable by clients — trigger-context only. An authenticated user
-- must not be able to spam arbitrary crew topics through this definer fn.
REVOKE EXECUTE ON FUNCTION public.notify_crew_sync(uuid[], text) FROM PUBLIC, anon, authenticated;

-- ── turnover_assignments → 'turnovers' ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.crew_sync_on_turnover_assignments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM new_rows r
    JOIN public.crew_members cm ON cm.id = r.crew_member_id
    WHERE cm.user_id IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM old_rows r
    JOIN public.crew_members cm ON cm.id = r.crew_member_id
    WHERE cm.user_id IS NOT NULL;
  ELSE  -- UPDATE: notify both the previous and the new crew member
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM (
      SELECT crew_member_id FROM new_rows
      UNION
      SELECT crew_member_id FROM old_rows
    ) r
    JOIN public.crew_members cm ON cm.id = r.crew_member_id
    WHERE cm.user_id IS NOT NULL;
  END IF;

  PERFORM public.notify_crew_sync(v_user_ids, 'turnovers');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS crew_sync_turnover_assignments_ins ON public.turnover_assignments;
CREATE TRIGGER crew_sync_turnover_assignments_ins
  AFTER INSERT ON public.turnover_assignments
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_turnover_assignments();

DROP TRIGGER IF EXISTS crew_sync_turnover_assignments_upd ON public.turnover_assignments;
CREATE TRIGGER crew_sync_turnover_assignments_upd
  AFTER UPDATE ON public.turnover_assignments
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_turnover_assignments();

DROP TRIGGER IF EXISTS crew_sync_turnover_assignments_del ON public.turnover_assignments;
CREATE TRIGGER crew_sync_turnover_assignments_del
  AFTER DELETE ON public.turnover_assignments
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_turnover_assignments();

-- ── turnovers (UPDATE only) → 'turnovers' ──────────────────────────────
-- INSERT is pointless (a brand-new turnover has no assignments yet — the
-- assignment INSERT is the signal). DELETE is covered by the FK cascade
-- firing crew_sync_turnover_assignments_del.
CREATE OR REPLACE FUNCTION public.crew_sync_on_turnovers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
  FROM new_rows r
  JOIN public.turnover_assignments ta ON ta.turnover_id = r.id
  JOIN public.crew_members cm ON cm.id = ta.crew_member_id
  WHERE cm.user_id IS NOT NULL;

  PERFORM public.notify_crew_sync(v_user_ids, 'turnovers');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS crew_sync_turnovers_upd ON public.turnovers;
CREATE TRIGGER crew_sync_turnovers_upd
  AFTER UPDATE ON public.turnovers
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_turnovers();

-- ── checklist_instances (INSERT, UPDATE) → 'checklists' ────────────────
CREATE OR REPLACE FUNCTION public.crew_sync_on_checklist_instances()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
  FROM new_rows r
  JOIN public.turnover_assignments ta ON ta.turnover_id = r.turnover_id
  JOIN public.crew_members cm ON cm.id = ta.crew_member_id
  WHERE cm.user_id IS NOT NULL;

  PERFORM public.notify_crew_sync(v_user_ids, 'checklists');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS crew_sync_checklist_instances_ins ON public.checklist_instances;
CREATE TRIGGER crew_sync_checklist_instances_ins
  AFTER INSERT ON public.checklist_instances
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_checklist_instances();

DROP TRIGGER IF EXISTS crew_sync_checklist_instances_upd ON public.checklist_instances;
CREATE TRIGGER crew_sync_checklist_instances_upd
  AFTER UPDATE ON public.checklist_instances
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_checklist_instances();

-- ── checklist_instance_items (INSERT, UPDATE) → 'checklists' ───────────
CREATE OR REPLACE FUNCTION public.crew_sync_on_checklist_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
  FROM new_rows r
  JOIN public.checklist_instances ci ON ci.id = r.instance_id
  JOIN public.turnover_assignments ta ON ta.turnover_id = ci.turnover_id
  JOIN public.crew_members cm ON cm.id = ta.crew_member_id
  WHERE cm.user_id IS NOT NULL;

  PERFORM public.notify_crew_sync(v_user_ids, 'checklists');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS crew_sync_checklist_items_ins ON public.checklist_instance_items;
CREATE TRIGGER crew_sync_checklist_items_ins
  AFTER INSERT ON public.checklist_instance_items
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_checklist_items();

DROP TRIGGER IF EXISTS crew_sync_checklist_items_upd ON public.checklist_instance_items;
CREATE TRIGGER crew_sync_checklist_items_upd
  AFTER UPDATE ON public.checklist_instance_items
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_checklist_items();

-- ── work_orders (INSERT, UPDATE, DELETE) → 'work_orders' ───────────────
CREATE OR REPLACE FUNCTION public.crew_sync_on_work_orders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM new_rows r
    JOIN public.crew_members cm ON cm.id = r.assigned_crew_member_id
    WHERE r.assigned_crew_member_id IS NOT NULL AND cm.user_id IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM old_rows r
    JOIN public.crew_members cm ON cm.id = r.assigned_crew_member_id
    WHERE r.assigned_crew_member_id IS NOT NULL AND cm.user_id IS NOT NULL;
  ELSE  -- UPDATE: notify previous and new assignee (covers reassignment)
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM (
      SELECT assigned_crew_member_id FROM new_rows
      UNION
      SELECT assigned_crew_member_id FROM old_rows
    ) r
    JOIN public.crew_members cm ON cm.id = r.assigned_crew_member_id
    WHERE r.assigned_crew_member_id IS NOT NULL AND cm.user_id IS NOT NULL;
  END IF;

  PERFORM public.notify_crew_sync(v_user_ids, 'work_orders');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS crew_sync_work_orders_ins ON public.work_orders;
CREATE TRIGGER crew_sync_work_orders_ins
  AFTER INSERT ON public.work_orders
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_work_orders();

DROP TRIGGER IF EXISTS crew_sync_work_orders_upd ON public.work_orders;
CREATE TRIGGER crew_sync_work_orders_upd
  AFTER UPDATE ON public.work_orders
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_work_orders();

DROP TRIGGER IF EXISTS crew_sync_work_orders_del ON public.work_orders;
CREATE TRIGGER crew_sync_work_orders_del
  AFTER DELETE ON public.work_orders
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_work_orders();

-- ── Lock down the trigger functions from PostgREST RPC ─────────────────
-- (Added after the initial spec SQL: Supabase security advisors flagged the
-- five SECURITY DEFINER trigger functions as executable by anon/authenticated
-- via /rest/v1/rpc/* — lints 0028/0029. Trigger functions are invoked by the
-- trigger machinery (EXECUTE is checked at trigger creation, not at fire
-- time), so client roles never need EXECUTE on them.)
REVOKE EXECUTE ON FUNCTION public.crew_sync_on_turnover_assignments() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crew_sync_on_turnovers() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crew_sync_on_checklist_instances() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crew_sync_on_checklist_items() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crew_sync_on_work_orders() FROM PUBLIC, anon, authenticated;

-- ── Authorize crew clients to receive their own private-topic broadcasts ─
-- Private Realtime channels authorize against RLS on realtime.messages.
-- A crew user may join exactly one topic: crew:{their own auth.uid()}.
DROP POLICY IF EXISTS "crew_receive_own_sync_broadcasts" ON realtime.messages;
CREATE POLICY "crew_receive_own_sync_broadcasts"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND realtime.topic() = 'crew:' || (SELECT auth.uid())::text
  );
