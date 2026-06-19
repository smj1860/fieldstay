-- Item 6 (dashboard walkthrough): new properties show every inventory item as
-- "critical" before any turnover, since current_quantity defaults to 0 and
-- 0 <= par_level is always true. A null first_count_recorded_at distinguishes
-- "never counted" from "counted and found at/below par" — stock-status logic
-- gates on this column being non-null before treating the item as critical/low.

ALTER TABLE public.inventory_items
  ADD COLUMN first_count_recorded_at timestamptz NULL;
