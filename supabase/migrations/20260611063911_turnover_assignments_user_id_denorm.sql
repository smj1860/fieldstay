
-- Add user_id to turnover_assignments as a denormalised column.
-- PowerSync parameter queries require single-table SELECTs with no JOINs,
-- so we cannot resolve crew_member_id → user_id at query time.
-- This column is kept in sync by a trigger on crew_members.

ALTER TABLE public.turnover_assignments
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Backfill existing rows
UPDATE public.turnover_assignments ta
SET user_id = cm.user_id
FROM public.crew_members cm
WHERE cm.id = ta.crew_member_id;

-- Index for PowerSync parameter query performance
CREATE INDEX IF NOT EXISTS idx_turnover_assignments_user_id
  ON public.turnover_assignments(user_id)
  WHERE user_id IS NOT NULL;

-- Trigger function: keep user_id in sync when crew_members.user_id changes
CREATE OR REPLACE FUNCTION public.sync_turnover_assignment_user_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    UPDATE public.turnover_assignments
    SET user_id = NEW.user_id
    WHERE crew_member_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_turnover_assignment_user_id ON public.crew_members;
CREATE TRIGGER trg_sync_turnover_assignment_user_id
  AFTER UPDATE OF user_id ON public.crew_members
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_turnover_assignment_user_id();

-- Also denormalise property_id from turnovers into turnover_assignments
-- so PowerSync can resolve user_id → property_id in a single table.
ALTER TABLE public.turnover_assignments
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.properties(id) ON DELETE SET NULL;

-- Backfill
UPDATE public.turnover_assignments ta
SET property_id = t.property_id
FROM public.turnovers t
WHERE t.id = ta.turnover_id;

-- Index
CREATE INDEX IF NOT EXISTS idx_turnover_assignments_property_id
  ON public.turnover_assignments(property_id)
  WHERE property_id IS NOT NULL;

-- Trigger: keep property_id in sync when turnovers.property_id changes
CREATE OR REPLACE FUNCTION public.sync_turnover_assignment_property_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.property_id IS DISTINCT FROM NEW.property_id THEN
    UPDATE public.turnover_assignments
    SET property_id = NEW.property_id
    WHERE turnover_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_turnover_assignment_property_id ON public.turnovers;
CREATE TRIGGER trg_sync_turnover_assignment_property_id
  AFTER UPDATE OF property_id ON public.turnovers
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_turnover_assignment_property_id();

-- Trigger: populate both columns on INSERT of new assignment
CREATE OR REPLACE FUNCTION public.populate_turnover_assignment_denorm()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     uuid;
  v_property_id uuid;
BEGIN
  SELECT cm.user_id INTO v_user_id
  FROM public.crew_members cm
  WHERE cm.id = NEW.crew_member_id;

  SELECT t.property_id INTO v_property_id
  FROM public.turnovers t
  WHERE t.id = NEW.turnover_id;

  NEW.user_id     := v_user_id;
  NEW.property_id := v_property_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_populate_turnover_assignment_denorm ON public.turnover_assignments;
CREATE TRIGGER trg_populate_turnover_assignment_denorm
  BEFORE INSERT ON public.turnover_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_turnover_assignment_denorm();

COMMENT ON COLUMN public.turnover_assignments.user_id IS
  'Denormalised from crew_members.user_id. Kept in sync by trigger. Used by PowerSync parameter queries.';
COMMENT ON COLUMN public.turnover_assignments.property_id IS
  'Denormalised from turnovers.property_id. Kept in sync by trigger. Used by PowerSync parameter queries.';
