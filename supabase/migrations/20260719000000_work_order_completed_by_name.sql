-- Captures which individual technician completed a vendor-assigned work
-- order, distinct from work_orders.vendor_id (the vendor company). Neither
-- the live completion_token flow nor the removed /wo/[token] flow ever
-- captured this — required going forward on vendor-portal completions.

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS completed_by_name text;
