
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS vendor_rating SMALLINT CHECK (vendor_rating BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS vendor_rating_notes TEXT;
