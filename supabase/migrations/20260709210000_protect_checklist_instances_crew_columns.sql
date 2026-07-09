-- checklist_instances_crew_update (added in 20260708234410) is gated only on
-- turnover_id, not per-column — RLS is row-level, not column-level, so a
-- crew session calling Supabase directly (outside the app's own UI, which
-- only ever sends completed_at/completed_by_crew_id via
-- lib/dexie/syncService.ts) could otherwise legally rewrite org_id,
-- turnover_id, template_id, template_snapshot, status, or section_photo_path
-- on any row it's allowed to touch. This trigger makes the app's own
-- allowlist a DB-level guarantee instead of just a client-side convention.
--
-- updated_at is deliberately excluded from the guarded column list — the
-- pre-existing checklist_instances_updated_at trigger (fieldstay_v1_turnovers
-- migration) legitimately changes it on every UPDATE regardless of who
-- performed it.
CREATE OR REPLACE FUNCTION protect_checklist_instances_crew_columns() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  -- completed_at/completed_by_crew_id. Reject anything else outright
  -- rather than silently reverting it, so a client-side bug surfaces
  -- immediately instead of masking a write that silently didn't apply.
  IF NEW.org_id             IS DISTINCT FROM OLD.org_id
     OR NEW.turnover_id     IS DISTINCT FROM OLD.turnover_id
     OR NEW.template_id     IS DISTINCT FROM OLD.template_id
     OR NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot
     OR NEW.status          IS DISTINCT FROM OLD.status
     OR NEW.started_at      IS DISTINCT FROM OLD.started_at
     OR NEW.section_photo_path IS DISTINCT FROM OLD.section_photo_path
  THEN
    RAISE EXCEPTION 'crew members may only update completed_at and completed_by_crew_id on checklist_instances';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS checklist_instances_protect_crew_columns ON checklist_instances;
CREATE TRIGGER checklist_instances_protect_crew_columns
  BEFORE UPDATE ON checklist_instances
  FOR EACH ROW EXECUTE FUNCTION protect_checklist_instances_crew_columns();
