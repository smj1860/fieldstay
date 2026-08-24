-- One cleaning work order per inspection, and a crew member to suggest for it.
--
-- INSPECTIONS_SPEC §5 is explicit that cleaning is NOT a fourth remediation
-- type, and the reason is dispatch economics rather than taxonomy: a stained
-- rug, a dirty oven and cobwebs found on one walk are ONE visit. Three work
-- orders would be three dispatches for a job somebody does in a single trip.
-- So `needs_cleaning` is an independent boolean on every finding, and the
-- roll-up happens at completion.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A NEW COLUMN RATHER THAN REUSING source_inspection_item_id
--
-- The per-finding work orders key on `source_inspection_item_id`, which is
-- partial-unique and is what makes the remediation retry idempotent. The
-- cleaning roll-up covers MANY findings, so attaching it to one of them would
-- be a lie with teeth: `createWorkOrders` pre-checks that column to decide
-- which findings already have a work order, so a cleaning roll-up squatting on
-- an item's id would make that item look already-handled and SUPPRESS its own
-- repair work order.
--
-- That is not hypothetical. A finding can be both — a stained rug whose fitting
-- also needs repairing is `needs_cleaning = true` AND
-- `remediation = 'work_order'`.
--
-- ONLY THE CLEANING ROLL-UP SETS THIS COLUMN
--
-- Which is what lets the unique index be a plain partial one rather than
-- something conditioned on `category`: per-finding work orders leave
-- source_inspection_id NULL and key on the item instead. If another
-- one-per-inspection work order is ever added, it needs its own discriminator
-- rather than sharing this key.
--
-- Mirrors purchase_orders.source_inspection_id (20260823150044) exactly — same
-- shape, same reasoning, same one-per-inspection guarantee.

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS source_inspection_id uuid
    REFERENCES inspections(id) ON DELETE SET NULL;

-- The FK-covering-index invariant wants one on every reference column.
CREATE INDEX IF NOT EXISTS idx_work_orders_source_inspection
  ON work_orders (source_inspection_id)
  WHERE source_inspection_id IS NOT NULL;

-- One per inspection. Turns a replayed remediation step into a collision
-- rather than a second cleaning visit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_source_inspection
  ON work_orders (source_inspection_id)
  WHERE source_inspection_id IS NOT NULL;

COMMENT ON COLUMN work_orders.source_inspection_id IS
  'The inspection whose needs_cleaning findings rolled up into this ONE cleaning work order. Partial-unique. Set ONLY by the cleaning roll-up — per-finding work orders use source_inspection_item_id instead.';

-- ─────────────────────────────────────────────────────────────────────────────
-- SUGGESTING A CREW MEMBER, NOT A VENDOR
--
-- A cleaning job found on an inspection goes to CREW. The existing suggestion
-- trio on this table is vendor-shaped in one of its three columns only —
-- `suggested_vendor_ids` — while `suggestion_reasoning` and `suggestion_status`
-- are about the suggestion itself and carry over unchanged. So this adds the
-- one missing column rather than a second parallel trio.
--
-- WHICH MAKES THE SHARED suggestion_status A REAL CONSTRAINT, NOT A HAPPY
-- ACCIDENT.
--
-- One status column cannot describe two live suggestions: accepting the crew
-- one would flip a pending vendor suggestion to `accepted` without a vendor
-- ever being assigned. Today nothing can produce both — the cleaning roll-up
-- never sends `work-order/vendor-suggestion.requested`, and the two senders
-- that do (create-work-order-helpers.ts, cron/work-order-ops.ts) never touch an
-- inspection-sourced row. That is a fact about today's call sites, which is
-- exactly the kind of fact that stops being true without anyone noticing.
--
-- The CHECK makes the collision impossible instead of merely unlikely. It fails
-- the WRITE that would create the second suggestion, which is loud — an Inngest
-- step that retries and a Sentry error — rather than silently clobbering a crew
-- suggestion with a vendor one. Setting either array to NULL or empty always
-- satisfies it, so no referential cleanup can trip over it.
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS suggested_crew_member_ids uuid[];

ALTER TABLE work_orders
  DROP CONSTRAINT IF EXISTS work_orders_one_suggestion_kind;

ALTER TABLE work_orders
  ADD CONSTRAINT work_orders_one_suggestion_kind CHECK (
    coalesce(cardinality(suggested_vendor_ids),      0) = 0
    OR
    coalesce(cardinality(suggested_crew_member_ids), 0) = 0
  );

COMMENT ON COLUMN work_orders.suggested_crew_member_ids IS
  'Crew members suggested for this work order — the crew-side twin of suggested_vendor_ids, sharing suggestion_reasoning and suggestion_status. Mutually exclusive with suggested_vendor_ids (work_orders_one_suggestion_kind), because one suggestion_status cannot describe two live suggestions.';
