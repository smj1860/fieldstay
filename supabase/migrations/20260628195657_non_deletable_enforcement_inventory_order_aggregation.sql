
-- ─────────────────────────────────────────────────────────────
-- DB-level enforcement for non_deletable checklist items.
-- A BEFORE DELETE/UPDATE trigger rejects mutations when
-- non_deletable = true, regardless of the calling role.
-- Consistent with the existing UI-only guard — now enforced at
-- the data layer so direct API calls cannot bypass it.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_non_deletable_checklist_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.non_deletable = true THEN
    RAISE EXCEPTION
      'checklist_instance_item % is marked non_deletable and cannot be deleted or have its task/section mutated.',
      OLD.id
    USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_checklist_items_non_deletable_delete
  ON checklist_instance_items;
DROP TRIGGER IF EXISTS trg_checklist_items_non_deletable_update
  ON checklist_instance_items;

CREATE TRIGGER trg_checklist_items_non_deletable_delete
  BEFORE DELETE ON checklist_instance_items
  FOR EACH ROW EXECUTE FUNCTION prevent_non_deletable_checklist_mutation();

-- Update trigger only blocks changes to the non_deletable and task columns;
-- completion state (is_completed, completed_at, crew_notes, photo_storage_path)
-- must still be writeable by crew during a turnover.
CREATE OR REPLACE FUNCTION prevent_non_deletable_checklist_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.non_deletable = true AND (
    NEW.task         IS DISTINCT FROM OLD.task         OR
    NEW.section_name IS DISTINCT FROM OLD.section_name OR
    NEW.non_deletable IS DISTINCT FROM OLD.non_deletable
  ) THEN
    RAISE EXCEPTION
      'checklist_instance_item % is marked non_deletable — task, section_name, and non_deletable cannot be changed.',
      OLD.id
    USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_checklist_items_non_deletable_update
  BEFORE UPDATE ON checklist_instance_items
  FOR EACH ROW EXECUTE FUNCTION prevent_non_deletable_checklist_update();

-- ─────────────────────────────────────────────────────────────
-- Per-item notes on inventory count draft items
-- ─────────────────────────────────────────────────────────────
ALTER TABLE inventory_count_draft_items
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- ─────────────────────────────────────────────────────────────
-- Order email aggregation tracking on purchase_orders
-- Tracks whether the PM order email has been sent for this PO.
-- false = queued for end-of-day batch; true = already sent.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS order_email_sent    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_same_day_flip    BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_pending_email
  ON purchase_orders(org_id, created_at)
  WHERE order_email_sent = false;
