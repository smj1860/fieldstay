-- BLOCKER B2 (pre-launch audit 2026-07-30) — cross-tenant exposure of vendor
-- compliance documents.
--
-- The three live storage.objects policies for the `compliance-documents`
-- bucket qualify on `bucket_id = 'compliance-documents'` AND NOTHING ELSE:
--
--   compliance_docs_select  USING      (bucket_id = 'compliance-documents')
--   compliance_docs_insert  WITH CHECK (bucket_id = 'compliance-documents')
--   compliance_docs_delete  USING      (bucket_id = 'compliance-documents')
--
-- so any authenticated user of any tenant can list, download, overwrite and
-- DELETE every other org's vendor COIs, W-9s, contractor licenses and bonding
-- certificates. No migration defines them — they are untracked Supabase
-- dashboard drift, which is why code review never saw them.
--
-- Objects are already written under `${orgId}/${vendorId}/{ts}-{uuid}.{ext}`
-- (app/(dashboard)/vendors/[id]/compliance-section.tsx:60-66, verified
-- 2026-07-30), so the scoping data is present and simply unused. This
-- migration replaces all three with the org-scoped pattern already proven in
-- 20260726120000_guidebook_property_photos_storage_policies.sql.
--
-- ── storage_org_prefix(): why a helper instead of an inline cast ───────────
-- The guidebook policies inline `(storage.foldername(name))[1]::uuid`. That
-- is safe there only because every object in that bucket happens to be
-- org-prefixed: an object whose first path segment is NOT a UUID makes the
-- cast raise 22P02 (invalid input syntax for type uuid) rather than evaluate
-- to false, and Postgres does not guarantee that the `bucket_id = ...`
-- conjunct is evaluated first. Buckets with pre-existing non-UUID-prefixed
-- objects (work-order-photos and turnover-photos — see the companion
-- migration) would therefore error the whole query instead of just hiding the
-- row. This helper does the guard inside a CASE, where evaluation order IS
-- guaranteed, and returns NULL for any non-UUID prefix. NULL then fails both
-- `IN (SELECT get_user_org_ids())` and `is_org_member(NULL, ...)` — deny, not
-- error.

CREATE OR REPLACE FUNCTION public.storage_org_prefix(object_name text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (storage.foldername(object_name))[1]
         ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN ((storage.foldername(object_name))[1])::uuid
    ELSE NULL
  END
$$;

COMMENT ON FUNCTION public.storage_org_prefix(text) IS
  'Owning org_id parsed from a storage object path of the form ${org_id}/... , or NULL when the first path segment is not a UUID. Used by the org-scoped storage.objects RLS policies.';

REVOKE EXECUTE ON FUNCTION public.storage_org_prefix(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.storage_org_prefix(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "compliance_docs_select" ON storage.objects;
DROP POLICY IF EXISTS "compliance_docs_insert" ON storage.objects;
DROP POLICY IF EXISTS "compliance_docs_update" ON storage.objects;
DROP POLICY IF EXISTS "compliance_docs_delete" ON storage.objects;

-- Any member of the owning org may read their own org's documents.
CREATE POLICY "compliance_docs_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'compliance-documents'
    AND public.storage_org_prefix(name) IN (SELECT public.get_user_org_ids())
  );

-- Uploading, replacing and removing a compliance document is a management
-- action — admin/manager only ('owner' passes is_org_member() implicitly).
CREATE POLICY "compliance_docs_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'compliance-documents'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  );

CREATE POLICY "compliance_docs_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'compliance-documents'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  )
  WITH CHECK (
    bucket_id = 'compliance-documents'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  );

CREATE POLICY "compliance_docs_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'compliance-documents'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  );
