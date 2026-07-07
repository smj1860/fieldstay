
-- Properly tracked migration for asset_type_standards RLS.
-- Policies were already applied directly to DB via an improperly-named file
-- ("new asset_type_standards_rls" with no timestamp/extension) that was
-- silently skipped by supabase db push. This migration re-applies them
-- idempotently and fixes the missing WITH CHECK on the UPDATE deny policy.

ALTER TABLE public.asset_type_standards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "asset_type_standards_select"   ON public.asset_type_standards;
DROP POLICY IF EXISTS "asset_type_standards_no_insert" ON public.asset_type_standards;
DROP POLICY IF EXISTS "asset_type_standards_no_update" ON public.asset_type_standards;
DROP POLICY IF EXISTS "asset_type_standards_no_delete" ON public.asset_type_standards;

-- Global lookup table — any authenticated user can read
CREATE POLICY "asset_type_standards_select"
  ON public.asset_type_standards
  FOR SELECT
  USING ((SELECT auth.role()) = 'authenticated');

-- Block all writes from application layer; service role bypasses RLS
CREATE POLICY "asset_type_standards_no_insert"
  ON public.asset_type_standards
  FOR INSERT
  WITH CHECK (false);

CREATE POLICY "asset_type_standards_no_update"
  ON public.asset_type_standards
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

CREATE POLICY "asset_type_standards_no_delete"
  ON public.asset_type_standards
  FOR DELETE
  USING (false);
