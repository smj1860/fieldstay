-- CRITICAL FIX: every crew checklist item completion has been silently
-- failing since 2026-07-09 — two triggers, added one day apart, directly
-- contradict each other.
--
-- set_checklist_instance_started_at() (20260708234410) fires AFTER UPDATE
-- on checklist_instance_items and, on the first item completed, does
-- `UPDATE checklist_instances SET started_at = now()`.
--
-- protect_checklist_instances_crew_columns() (20260709210000) fires BEFORE
-- UPDATE on checklist_instances and RAISEs for any non-PM caller who
-- changes started_at (among other guarded columns) — added the very next
-- day, apparently without realizing the previous day's trigger needed the
-- same exemption already carved out for updated_at (see that migration's
-- own comment: "updated_at is deliberately excluded... the pre-existing
-- trigger legitimately changes it... regardless of who performed it" —
-- started_at needed identical treatment and didn't get it).
--
-- Net effect, confirmed against live production data: 0 of 51
-- checklist_instances have ever had started_at set; 0 of 2911
-- checklist_instance_items have ever had completed_by_crew_id set; the most
-- recent successful item completion was 2026-06-23, before either trigger
-- existed. Every crew item-completion attempt since has raised inside
-- set_checklist_instance_started_at()'s nested UPDATE, rolling back the
-- ENTIRE outer statement — so the item's own is_completed write never
-- landed either, despite the crew PWA's optimistic local-first UI showing
-- it as checked. This also explains why the resulting broadcast
-- (crew_sync_on_checklist_items(), 20260725191358) never fired: the
-- realtime.send() call inside that trigger is in the same transaction as
-- everything else, so it rolled back too — a second crew member's device
-- never got the wake-up signal and fell through to the 5-minute safety
-- poll (which has nothing new to show either, since the write never
-- committed).
--
-- Fix: exempt started_at from the guard specifically when the UPDATE on
-- checklist_instances arrives via a nested trigger call (pg_trigger_depth()
-- > 1 — i.e. from set_checklist_instance_started_at()'s own UPDATE
-- statement, not a direct top-level UPDATE issued by the crew session
-- itself). This keeps the original security intent intact — a crew member
-- still cannot directly rewrite started_at via a crafted request against
-- checklist_instances (that would be a depth-1 call, still blocked) — while
-- letting the legitimate system-driven bookkeeping trigger succeed. Same
-- pg_trigger_depth() technique already used in this schema by
-- prevent_non_deletable_checklist_mutation() (20260727140000), just applied
-- to distinguish "legitimate nested trigger write" rather than "cascade
-- delete" there.

CREATE OR REPLACE FUNCTION public.protect_checklist_instances_crew_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_pm boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE user_id = auth.uid()
      AND org_id  = NEW.org_id
      AND role IN ('admin'::member_role, 'manager'::member_role, 'owner'::member_role)
  ) INTO is_pm;

  IF is_pm THEN
    RETURN NEW;
  END IF;

  -- Not a PM on this org — a legitimate crew write only ever changes
  -- completed_at/completed_by_crew_id directly, OR triggers a nested
  -- started_at write via set_checklist_instance_started_at() (depth > 1).
  -- Reject anything else outright rather than silently reverting it, so a
  -- client-side bug surfaces immediately instead of masking a write that
  -- silently didn't apply.
  IF NEW.org_id             IS DISTINCT FROM OLD.org_id
     OR NEW.turnover_id     IS DISTINCT FROM OLD.turnover_id
     OR NEW.template_id     IS DISTINCT FROM OLD.template_id
     OR NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot
     OR NEW.status          IS DISTINCT FROM OLD.status
     OR (NEW.started_at IS DISTINCT FROM OLD.started_at AND pg_trigger_depth() <= 1)
     OR NEW.section_photo_path IS DISTINCT FROM OLD.section_photo_path
  THEN
    RAISE EXCEPTION 'crew members may only update completed_at and completed_by_crew_id on checklist_instances';
  END IF;

  RETURN NEW;
END;
$$;
