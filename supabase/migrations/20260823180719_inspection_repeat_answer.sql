-- The repeat visit: was this the same fault, or a new one?
--
-- INSPECTIONS_SPEC §6. `UNIQUE (source_inspection_item_id)` (20260823150044)
-- makes the Inngest RETRY safe and does nothing about the next INSPECTION: a
-- handrail that fails in March and again in June is two inspection_items with
-- two different ids, so two work orders, even with March's still open and
-- unstarted. Quarterly inspections make that the normal case, and the symptom
-- is a maintenance board that accumulates duplicates until a PM stops trusting
-- it.
--
-- WHY THIS IS AN ANSWER AND NOT A KEY
--
-- The spec's first design deduplicated on `(property_id, form_item_id)`. The
-- action model broke it, and the way it broke is the reason this column exists
-- rather than a smarter key:
--
--   "Refrigeration" fails in March because the water filter is due — Replace, a
--   purchase order. It fails in June because the compressor is not holding
--   temperature — Service, a work order. Same form_item_id, two unrelated
--   problems. A key-based rule finds March's open record, calls June a repeat,
--   and attaches a failing compressor to a water-filter task as a note.
--
-- A real fault disappearing into the notes of an unrelated job, quietly, is the
-- worst outcome available here — worse than the duplicate it was trying to
-- prevent. Widening the key to include the action helps and does not fix it:
-- two different Repairs on the same broad item are still two jobs.
--
-- So the inspector is ASKED, and this records what they said. They are standing
-- in front of the appliance, which makes them the only party who can actually
-- tell, and it cannot wrongly suppress a fault because a human confirmed it.
--
-- NULL IS A REAL STATE AND MEANS "NOT ASKED"
--
-- No open predecessor existed at fill time, or the device had no cached work
-- orders to check against. Remediation falls back to creating a work order and
-- noting the relationship, which is what it did before this column existed.
-- That fallback is why an offline device with a cold cache degrades to the old
-- behaviour rather than to silence.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inspection_repeat_answer') THEN
    CREATE TYPE inspection_repeat_answer AS ENUM ('same', 'new');
  END IF;
END $$;

ALTER TABLE inspection_items
  ADD COLUMN IF NOT EXISTS repeat_answer inspection_repeat_answer,
  -- The work order the inspector was SHOWN. Kept even when they answered
  -- "new": knowing which open job a finding was distinguished FROM is what
  -- lets whoever picks it up tell the two apart on the board.
  --
  -- ON DELETE SET NULL rather than CASCADE — deleting a work order must never
  -- delete an inspection finding, which is an immutable record of what someone
  -- saw at a property on a date. Remediation treats 'same' with a NULL
  -- reference as "the predecessor is gone" and creates a work order after all,
  -- so the finding cannot fall through the gap.
  ADD COLUMN IF NOT EXISTS repeat_of_work_order_id uuid
    REFERENCES work_orders(id) ON DELETE SET NULL;

-- The FK-covering-index invariant in scripts/check-db-invariants.mjs wants one
-- on every reference column. Partial, because the overwhelming majority of
-- findings are not repeats.
CREATE INDEX IF NOT EXISTS idx_inspection_items_repeat_of_work_order
  ON inspection_items (repeat_of_work_order_id)
  WHERE repeat_of_work_order_id IS NOT NULL;

-- An answer without the thing it is an answer about is not interpretable:
-- 'same' with no work order cannot be attached to anything, and 'new' with no
-- work order is indistinguishable from never having been asked. Enforced here
-- rather than in the client because the RPC is not the only possible writer.
ALTER TABLE inspection_items
  DROP CONSTRAINT IF EXISTS inspection_items_repeat_answer_needs_reference;
ALTER TABLE inspection_items
  ADD CONSTRAINT inspection_items_repeat_answer_needs_reference
  CHECK (repeat_answer IS NULL OR repeat_of_work_order_id IS NOT NULL);

COMMENT ON COLUMN inspection_items.repeat_answer IS
  'What the inspector said when shown an open work order for this concern: same fault, or a new one. NULL = never asked (no open predecessor, or no cached work orders on the device).';
COMMENT ON COLUMN inspection_items.repeat_of_work_order_id IS
  'The open work order the inspector was shown. Retained for both answers — "new" records what this finding was distinguished FROM.';
