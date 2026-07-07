
-- Add turnover_id to checklist_instance_items as a denormalised column.
-- PowerSync data queries must SELECT from a single table with no JOINs.
-- This allows: SELECT * FROM checklist_instance_items WHERE turnover_id = bucket.turnover_id

ALTER TABLE public.checklist_instance_items
  ADD COLUMN IF NOT EXISTS turnover_id uuid REFERENCES public.turnovers(id) ON DELETE CASCADE;

-- Backfill from checklist_instances
UPDATE public.checklist_instance_items cii
SET turnover_id = ci.turnover_id
FROM public.checklist_instances ci
WHERE ci.id = cii.instance_id;

-- Index for PowerSync data query performance
CREATE INDEX IF NOT EXISTS idx_checklist_instance_items_turnover_id
  ON public.checklist_instance_items(turnover_id)
  WHERE turnover_id IS NOT NULL;

-- Trigger: populate turnover_id on INSERT
CREATE OR REPLACE FUNCTION public.populate_checklist_item_turnover_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT ci.turnover_id INTO NEW.turnover_id
  FROM public.checklist_instances ci
  WHERE ci.id = NEW.instance_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_populate_checklist_item_turnover_id ON public.checklist_instance_items;
CREATE TRIGGER trg_populate_checklist_item_turnover_id
  BEFORE INSERT ON public.checklist_instance_items
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_checklist_item_turnover_id();

COMMENT ON COLUMN public.checklist_instance_items.turnover_id IS
  'Denormalised from checklist_instances.turnover_id. Kept in sync by trigger. Used by PowerSync data queries to avoid JOINs.';
