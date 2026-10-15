-- protect_checklist_instances_crew_columns() rejected ANY crew change to
-- section_photo_path, while lib/dexie/photo-sync.ts sends exactly that PATCH
-- from the crew session after a successful Storage upload. Result: every crew
-- section photo uploaded fine and then dead-lettered on the path write, so the
-- PM never saw it. Crew may now SET or REPLACE the section photo path. They
-- still may not CLEAR it: removing evidence stays a PM action, matching the
-- turnover_photos_delete storage policy.
CREATE OR REPLACE FUNCTION public.protect_checklist_instances_crew_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  is_pm boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = auth.uid()
      AND org_id  = NEW.org_id
      AND role IN ('admin'::public.member_role, 'manager'::public.member_role, 'owner'::public.member_role)
  ) INTO is_pm;

  IF is_pm THEN
    RETURN NEW;
  END IF;

  IF NEW.org_id             IS DISTINCT FROM OLD.org_id
     OR NEW.turnover_id     IS DISTINCT FROM OLD.turnover_id
     OR NEW.template_id     IS DISTINCT FROM OLD.template_id
     OR NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot
     OR NEW.status          IS DISTINCT FROM OLD.status
     OR (NEW.started_at IS DISTINCT FROM OLD.started_at AND pg_trigger_depth() <= 1)
     OR (NEW.section_photo_path IS DISTINCT FROM OLD.section_photo_path AND NEW.section_photo_path IS NULL)
  THEN
    RAISE EXCEPTION 'crew members may only update completed_at, completed_by_crew_id and section_photo_path on checklist_instances';
  END IF;

  RETURN NEW;
END;
$$;
