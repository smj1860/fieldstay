-- checklist_instances: started_at/completed_at already exist but were never
-- wired up; completed_by_crew_id is new — tracks who checked "Confirm
-- Checklist Complete".
ALTER TABLE checklist_instances
  ADD COLUMN IF NOT EXISTS completed_by_crew_id uuid REFERENCES crew_members(id) ON DELETE SET NULL;

-- turnovers: inventory confirmation tracking, mirroring checklist_instances'
-- shape. inventory_items has no per-turnover scoping at all (it's a
-- persistent property-level record edited across many turnovers), so
-- "inventory started/confirmed for THIS turnover" has nowhere else to live.
ALTER TABLE turnovers
  ADD COLUMN IF NOT EXISTS inventory_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS inventory_confirmed_complete_at timestamptz,
  ADD COLUMN IF NOT EXISTS inventory_confirmed_by_crew_id uuid REFERENCES crew_members(id) ON DELETE SET NULL;

-- Crew has never had UPDATE rights on checklist_instances (only on
-- checklist_instance_items) — needed now so the crew PWA can write the
-- "Confirm Checklist Complete" timestamp directly, matching the existing
-- local-first write pattern used everywhere else (rather than routing
-- through a dedicated API route). Mirrors the exact JOIN shape of the
-- existing checklist_instance_items crew UPDATE policy.
CREATE POLICY "checklist_instances_crew_update"
  ON checklist_instances FOR UPDATE
  USING (
    turnover_id IN (
      SELECT ta.turnover_id FROM turnover_assignments ta
      JOIN crew_members cm ON cm.id = ta.crew_member_id
      WHERE cm.user_id = auth.uid()
    )
  )
  WITH CHECK (
    turnover_id IN (
      SELECT ta.turnover_id FROM turnover_assignments ta
      JOIN crew_members cm ON cm.id = ta.crew_member_id
      WHERE cm.user_id = auth.uid()
    )
  );

-- Sets checklist_instances.started_at the moment the FIRST item on that
-- checklist is completed — atomically, so two crew members completing
-- what each thinks is "the first item" at nearly the same time can't race.
-- SECURITY DEFINER so this bookkeeping keeps working regardless of which
-- RLS grant let the underlying checklist_instance_items write through.
CREATE OR REPLACE FUNCTION set_checklist_instance_started_at() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.is_completed = true AND OLD.is_completed IS DISTINCT FROM true THEN
    UPDATE checklist_instances
    SET started_at = now()
    WHERE id = NEW.instance_id AND started_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS checklist_instance_items_set_started_at ON checklist_instance_items;
CREATE TRIGGER checklist_instance_items_set_started_at
  AFTER UPDATE ON checklist_instance_items
  FOR EACH ROW EXECUTE FUNCTION set_checklist_instance_started_at();

-- Realtime: crew devices need to see each other's confirmation writes (and
-- the resulting turnover completion) live, same as the checklist item sync
-- added in the previous migration.
ALTER PUBLICATION supabase_realtime ADD TABLE public.checklist_instances;
ALTER PUBLICATION supabase_realtime ADD TABLE public.turnovers;
