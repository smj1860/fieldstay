
ALTER TABLE public.inventory_template_items
  ADD COLUMN IF NOT EXISTS notes           text,
  ADD COLUMN IF NOT EXISTS catalog_item_id uuid
    REFERENCES public.inventory_catalog(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.inventory_template_items.notes IS
  'Optional notes shown to crew when item appears in a turnover checklist.';

COMMENT ON COLUMN public.inventory_template_items.catalog_item_id IS
  'Reference back to inventory_catalog. Used to skip duplicate items
   when applying a template to a property that already has the same item.';
