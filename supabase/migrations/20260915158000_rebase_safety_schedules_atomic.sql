-- ============================================================================
-- rebaseSafetySchedules() (lib/inspections/apply-safety-template.ts) performed
-- an UPDATE ... SET frequency and, as a SEPARATE await, an UPDATE ...
-- SET next_due_date, with no surrounding transaction or RPC.
--
-- If the process is interrupted between the two calls — a timeout, a
-- serverless function recycling, a network blip on the second request — the
-- org is left with the new cadence applied to every safety schedule but the
-- old due dates untouched, indefinitely, until something re-triggers the
-- whole call. In that stuck state next_due_date and frequency disagree with
-- each other for every affected property, and every downstream date
-- calculation (the overdue digest, the dashboard's Upcoming section) works
-- from an inconsistent row.
--
-- Fix: wrap both statements in one Postgres function so they commit or
-- roll back together — the same "one logical action, one transaction" pattern
-- already used elsewhere in this codebase for atomic multi-step writes.
--
-- SECURITY INVOKER, not DEFINER: the caller (saveSafetyCadence, a Server
-- Action) passes its own RLS-scoped session client today, via two separate
-- UPDATE statements that each went through RLS individually. Keeping this
-- SECURITY INVOKER preserves that exact authorization boundary — the RPC
-- runs as the calling role, so maintenance_schedules' own RLS policies still
-- apply, rather than silently widening access via a DEFINER bypass.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rebase_safety_schedules(
  p_org_id      uuid,
  p_form_id     uuid,
  p_frequency   schedule_frequency,
  p_due_date    date,
  p_today       date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE
  v_retimed integer;
BEGIN
  UPDATE maintenance_schedules
     SET frequency = p_frequency
   WHERE org_id = p_org_id
     AND creates = 'inspection'
     AND inspection_form_id = p_form_id;

  UPDATE maintenance_schedules
     SET next_due_date = p_due_date
   WHERE org_id = p_org_id
     AND creates = 'inspection'
     AND inspection_form_id = p_form_id
     AND next_due_date > p_today;

  GET DIAGNOSTICS v_retimed = ROW_COUNT;
  RETURN v_retimed;
END;
$function$;

COMMENT ON FUNCTION public.rebase_safety_schedules(uuid, uuid, schedule_frequency, date, date) IS
  'Atomically applies a new safety inspection cadence (frequency + rebased '
  'next_due_date) to every maintenance_schedules row for an org''s safety '
  'form, so a failure between the two writes can never leave frequency and '
  'next_due_date disagreeing. SECURITY INVOKER — runs under the caller''s '
  'own RLS, same as the two UPDATE statements it replaces.';

GRANT EXECUTE ON FUNCTION public.rebase_safety_schedules(uuid, uuid, schedule_frequency, date, date) TO authenticated;
