-- property_id: high-cardinality FK, always used in WHERE for per-property draft lookup
CREATE INDEX IF NOT EXISTS idx_inventory_count_drafts_property_id
  ON public.inventory_count_drafts (property_id);

-- submitted_by: the crew-member FK in this table (actual column name; not crew_member_id)
CREATE INDEX IF NOT EXISTS idx_inventory_count_drafts_submitted_by
  ON public.inventory_count_drafts (submitted_by);
