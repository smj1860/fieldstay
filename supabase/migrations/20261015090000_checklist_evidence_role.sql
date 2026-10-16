-- Which evidence slot a checklist item fills, so a claim packet can pair the
-- same room across consecutive turnovers by role rather than by task text.
-- NULL for every ordinary task. Set only by snapshotChecklist's injection.
ALTER TABLE public.checklist_instance_items
  ADD COLUMN IF NOT EXISTS evidence_role text,
  ADD COLUMN IF NOT EXISTS evidence_spot_id uuid;

ALTER TABLE public.checklist_instance_items
  DROP CONSTRAINT IF EXISTS checklist_instance_items_evidence_role_valid;
ALTER TABLE public.checklist_instance_items
  ADD CONSTRAINT checklist_instance_items_evidence_role_valid
    CHECK (evidence_role IS NULL OR evidence_role IN ('room_condition', 'claim_spot'));

-- Only a claim_spot item may name a spot. The reverse is deliberately NOT
-- enforced: the spot FK is ON DELETE SET NULL, and a claim_spot row whose spot
-- was removed (a property cascade, or a hard delete someone should not have
-- made) must survive as a claim_spot with a NULL spot rather than fail the
-- delete with a CHECK violation.
ALTER TABLE public.checklist_instance_items
  DROP CONSTRAINT IF EXISTS checklist_instance_items_evidence_spot_shape;
ALTER TABLE public.checklist_instance_items
  ADD CONSTRAINT checklist_instance_items_evidence_spot_shape
    CHECK (evidence_spot_id IS NULL OR evidence_role = 'claim_spot');

CREATE INDEX IF NOT EXISTS checklist_instance_items_evidence_role_idx
  ON public.checklist_instance_items (turnover_id, evidence_role)
  WHERE evidence_role IS NOT NULL;

COMMENT ON COLUMN public.checklist_instance_items.evidence_role IS
  'room_condition: the one doorway wide shot per section. claim_spot: a per-property high-claim spot. NULL: ordinary task.';

-- A non-deletable row's evidence_role may not be rewritten either. evidence_spot_id
-- is intentionally NOT guarded: its FK is ON DELETE SET NULL, and guarding it
-- would make that action fail on every non-deletable row.
CREATE OR REPLACE FUNCTION public.prevent_non_deletable_checklist_update()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.non_deletable = true AND (
    NEW.task          IS DISTINCT FROM OLD.task          OR
    NEW.section_name  IS DISTINCT FROM OLD.section_name  OR
    NEW.non_deletable IS DISTINCT FROM OLD.non_deletable OR
    NEW.evidence_role IS DISTINCT FROM OLD.evidence_role
  ) THEN
    RAISE EXCEPTION
      'checklist_instance_item % is marked non_deletable: task, section_name, evidence_role, and non_deletable cannot be changed.',
      OLD.id
    USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
