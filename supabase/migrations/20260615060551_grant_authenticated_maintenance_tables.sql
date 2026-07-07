-- maintenance_catalog_items — PM dashboard reads catalog when building work orders
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.maintenance_catalog_items TO authenticated;

-- maintenance_completions — PM dashboard reads completion records on work orders
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.maintenance_completions TO authenticated;
