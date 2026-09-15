-- ============================================================================
-- Two related CRITICAL gaps in guidebook_sponsor_assignments, fixed together
-- because the same atomic-RPC change closes both:
--
-- 1. The 4-sponsors-per-property cap (MAX_SPONSORS_PER_PROPERTY in
--    lib/guidebook/assignment-constants.ts) was, per this table's own original
--    migration comment, "enforced in the resolver, not here." It was in fact
--    enforced in exactly ONE of the two app-level write paths
--    (setPropertySponsors, the secondary per-property dialog) and NOT AT ALL
--    in setSponsorProperties (the PRIMARY, sponsor-side bulk-assign path the
--    app's own comments call "how a thirty-property org is configured"), and
--    nowhere in the database. A property could silently accumulate more than
--    4 sponsors — all validly billed via sponsor-economics.ts, none of them
--    past the 4th ever rendered to a guest by resolveManual()'s
--    `.limit(MAX_SPONSORS_PER_PROPERTY)` — with the PM's "Save" reporting
--    success throughout.
--
-- 2. Both write paths did DELETE then INSERT as two separate REST calls, not
--    one transaction. A failed INSERT (e.g. the named-slot collision index
--    firing) left the DELETE committed — a property or a sponsor's whole
--    assignment set wiped to nothing, not rolled back to its prior state,
--    with the UI showing a generic error that gives no hint anything actually
--    changed.
--
-- Fix: enforce the cap as a real trigger (so a race can't beat it, and it
-- protects BOTH write paths and any future one), and move each write path's
-- delete+insert into a single RPC function — one function call is one
-- implicit transaction, so a cap or collision violation raised by the INSERT
-- rolls back that SAME call's earlier DELETE too, leaving either the full new
-- state or the full untouched old state.
--
-- EXECUTE is granted to service_role only, not authenticated: both existing
-- server actions (app/actions/sponsor-assignments.ts) already call through
-- createServiceClient() after requireOrgRole() has verified admin/manager
-- membership and IDOR-checked the sponsor/property ids — there is no
-- legitimate reason for these two functions to be reachable directly via
-- PostgREST by an arbitrary authenticated user, so unlike
-- replace_property_asset (see 20260915140000) this one is closed by simply
-- not exposing it, rather than by an internal is_org_member() check.
-- ============================================================================

-- ── The cap, as a real constraint ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guidebook_sponsor_assignment_enforce_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.guidebook_sponsor_assignments
   WHERE property_id = NEW.property_id;

  -- BEFORE INSERT: v_count is the count BEFORE this row, so >= (not >) is the
  -- correct boundary — a property already at 4 must reject the 5th.
  IF v_count >= 4 THEN
    RAISE EXCEPTION 'guidebook_sponsor_assignments: property % already carries the maximum of 4 sponsors', NEW.property_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guidebook_sponsor_assignment_enforce_cap_trg
  ON public.guidebook_sponsor_assignments;

CREATE TRIGGER guidebook_sponsor_assignment_enforce_cap_trg
  BEFORE INSERT ON public.guidebook_sponsor_assignments
  FOR EACH ROW EXECUTE FUNCTION public.guidebook_sponsor_assignment_enforce_cap();

-- ── Atomic replace for the per-property path (setPropertySponsors) ─────────
--
-- org_id/slot_type in the inserted rows are overwritten by the existing
-- guidebook_sponsor_assignment_derive_trg regardless of what is supplied here
-- (see that trigger and the original TS comment) — passed through only
-- because both columns are NOT NULL.
CREATE OR REPLACE FUNCTION public.replace_property_sponsors(
  p_org_id      uuid,
  p_property_id uuid,
  p_sponsor_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.guidebook_sponsor_assignments
   WHERE org_id = p_org_id AND property_id = p_property_id;

  INSERT INTO public.guidebook_sponsor_assignments (org_id, sponsor_id, property_id, slot_type)
  SELECT p_org_id, sid, p_property_id, 'general'
    FROM unnest(p_sponsor_ids) AS sid;
  -- Any exception here (the cap trigger, the named-slot collision index, the
  -- derive trigger's org/foreign-key checks) aborts this whole function call,
  -- including the DELETE above — Postgres rolls back everything a single
  -- function invocation did, not just the statement that raised.
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_property_sponsors(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.replace_property_sponsors(uuid, uuid, uuid[]) TO service_role;

-- ── Atomic diff-and-replace for the primary bulk path (setSponsorProperties) ─
--
-- Computes toAdd/toRemove from a fresh read INSIDE this function rather than
-- trusting a diff computed in TypeScript against a possibly-stale earlier
-- read, then applies both within the same implicit transaction as
-- replace_property_sponsors above. Returns the added/removed property ids so
-- the caller can still mark exactly those properties 'manual' and log the
-- same audit detail it did before.
CREATE OR REPLACE FUNCTION public.set_sponsor_properties(
  p_org_id      uuid,
  p_sponsor_id  uuid,
  p_property_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_current   uuid[];
  v_to_add    uuid[];
  v_to_remove uuid[];
BEGIN
  SELECT COALESCE(array_agg(property_id), ARRAY[]::uuid[]) INTO v_current
    FROM public.guidebook_sponsor_assignments
   WHERE org_id = p_org_id AND sponsor_id = p_sponsor_id;

  SELECT COALESCE(array_agg(pid), ARRAY[]::uuid[]) INTO v_to_add
    FROM unnest(p_property_ids) AS pid
   WHERE pid <> ALL(v_current);

  SELECT COALESCE(array_agg(pid), ARRAY[]::uuid[]) INTO v_to_remove
    FROM unnest(v_current) AS pid
   WHERE pid <> ALL(p_property_ids);

  IF array_length(v_to_remove, 1) > 0 THEN
    DELETE FROM public.guidebook_sponsor_assignments
     WHERE org_id = p_org_id
       AND sponsor_id = p_sponsor_id
       AND property_id = ANY(v_to_remove);
  END IF;

  IF array_length(v_to_add, 1) > 0 THEN
    INSERT INTO public.guidebook_sponsor_assignments (org_id, sponsor_id, property_id, slot_type)
    SELECT p_org_id, p_sponsor_id, pid, 'general'
      FROM unnest(v_to_add) AS pid;
    -- Same whole-function rollback guarantee as replace_property_sponsors:
    -- a cap/collision violation here undoes the removals above too.
  END IF;

  RETURN jsonb_build_object(
    'added',   COALESCE(v_to_add, ARRAY[]::uuid[]),
    'removed', COALESCE(v_to_remove, ARRAY[]::uuid[])
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_sponsor_properties(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_sponsor_properties(uuid, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';
