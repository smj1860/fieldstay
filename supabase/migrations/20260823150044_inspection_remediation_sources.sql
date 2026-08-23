-- Remediation sources: where a work order or purchase order came from.
--
-- INSPECTIONS_SPEC §6. On completion each `fail` with remediation != 'none'
-- creates its record, and these columns are what tie the record back to the
-- finding — both for provenance and, via the partial unique indexes, for
-- idempotency.
--
-- WHY PARTIAL UNIQUE AND NOT PLAIN UNIQUE
--
-- Every pre-existing work order has a NULL here, and in Postgres NULLs are
-- distinct by default — so a plain UNIQUE would technically work. A partial
-- index is still the right shape: it says the constraint is about
-- inspection-sourced rows specifically, and it keeps the index off the
-- overwhelming majority of rows that will never have one.
--
-- WHAT THEY DO AND DO NOT PROTECT
--
-- They make the Inngest RETRY safe: a step that created three of five work
-- orders and then failed can re-run and collide instead of duplicating.
--
-- They do NOTHING about the repeat VISIT. §6 is explicit: a handrail that
-- fails in March and again in June produces two inspection_items with two
-- different ids, so two work orders — even when March's is still open and
-- unstarted. Quarterly inspections make that the normal case. §6's answer is
-- to ASK the inspector rather than deduplicate silently, because widening the
-- key cannot work: once the inspector picks the action, one item no longer
-- means one fault. "Refrigeration" failing for a water filter in March and a
-- compressor in June is the same form_item_id and two unrelated problems, and
-- silent attachment would file a failing compressor as a note on a
-- water-filter task.

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS source_inspection_item_id uuid
    REFERENCES inspection_items(id) ON DELETE SET NULL;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS source_inspection_id uuid
    REFERENCES inspections(id) ON DELETE SET NULL;

-- Plain lookup indexes: the FK-covering-index invariant in
-- scripts/check-db-invariants.mjs wants one on every reference column.
CREATE INDEX IF NOT EXISTS idx_work_orders_source_inspection_item
  ON work_orders (source_inspection_item_id)
  WHERE source_inspection_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_source_inspection
  ON purchase_orders (source_inspection_id)
  WHERE source_inspection_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_source_inspection_item
  ON work_orders (source_inspection_item_id)
  WHERE source_inspection_item_id IS NOT NULL;

-- One PO per inspection, not per item: §6, "a PM who needs three bulbs, a fire
-- extinguisher and an HVAC filter wants one order, not three."
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_source_inspection
  ON purchase_orders (source_inspection_id)
  WHERE source_inspection_id IS NOT NULL;

COMMENT ON COLUMN work_orders.source_inspection_item_id IS
  'The failed inspection answer this work order came from. Partial-unique, which is what makes the remediation retry idempotent.';
COMMENT ON COLUMN purchase_orders.source_inspection_id IS
  'The inspection whose failed purchasable items became this PO. Partial-unique: one PO per inspection.';
