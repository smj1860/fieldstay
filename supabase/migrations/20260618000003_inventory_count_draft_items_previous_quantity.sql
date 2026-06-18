-- inventory_count_draft_items was missing previous_quantity, which the crew
-- inventory-count submission route and the PM review UI have always relied
-- on to render the before/after diff. Snapshotting at submission time (vs.
-- a live lookup at review time) avoids the diff changing if current_quantity
-- is updated by something else between submission and review.

ALTER TABLE public.inventory_count_draft_items
  ADD COLUMN IF NOT EXISTS previous_quantity integer NOT NULL DEFAULT 0;
