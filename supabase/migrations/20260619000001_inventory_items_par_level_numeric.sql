ALTER TABLE public.inventory_items
  ALTER COLUMN par_level TYPE numeric USING par_level::numeric;
