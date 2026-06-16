-- Fix 1: Grant SELECT on vendor_compliance_status view to authenticated role
-- (underlying tables vendors + vendor_compliance_documents already have full grants)
GRANT SELECT ON public.vendor_compliance_status TO authenticated;

-- Fix 2: Add FK from inventory_count_drafts.submitted_by to crew_members
-- Allows PostgREST to resolve the crew_members join in inventory draft queries
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'inventory_count_drafts'
      AND constraint_name = 'inventory_count_drafts_submitted_by_fkey'
  ) THEN
    ALTER TABLE public.inventory_count_drafts
      ADD CONSTRAINT inventory_count_drafts_submitted_by_fkey
      FOREIGN KEY (submitted_by) REFERENCES public.crew_members(id) ON DELETE SET NULL;
  END IF;
END;
$$;

-- Reload PostgREST schema cache to pick up new FK
-- (also resolves turnover_assignments -> crew_members nested join if cache was stale)
NOTIFY pgrst, 'reload schema';
