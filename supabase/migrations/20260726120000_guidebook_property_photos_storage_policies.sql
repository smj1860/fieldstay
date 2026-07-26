-- Storage RLS for the guidebook-property-photos bucket (created by
-- 20260726100000_guidebook_v2_foundation.sql with public:true for guest-facing
-- reads via the public URL endpoint, which bypasses RLS entirely). This
-- migration governs writes/management from the PM dashboard only.
--
-- Uploads MUST use the path convention `${org_id}/${property_id}/{filename}`
-- so (storage.foldername(name))[1] resolves to the owning org_id.

DROP POLICY IF EXISTS "guidebook_property_photos_select" ON storage.objects;
DROP POLICY IF EXISTS "guidebook_property_photos_insert" ON storage.objects;
DROP POLICY IF EXISTS "guidebook_property_photos_update" ON storage.objects;
DROP POLICY IF EXISTS "guidebook_property_photos_delete" ON storage.objects;

CREATE POLICY "guidebook_property_photos_select"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'guidebook-property-photos'
    AND (storage.foldername(name))[1]::uuid IN (SELECT get_user_org_ids())
  );

CREATE POLICY "guidebook_property_photos_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'guidebook-property-photos'
    AND is_org_member((storage.foldername(name))[1]::uuid, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "guidebook_property_photos_update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'guidebook-property-photos'
    AND is_org_member((storage.foldername(name))[1]::uuid, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    bucket_id = 'guidebook-property-photos'
    AND is_org_member((storage.foldername(name))[1]::uuid, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "guidebook_property_photos_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'guidebook-property-photos'
    AND is_org_member((storage.foldername(name))[1]::uuid, ARRAY['admin'::member_role, 'manager'::member_role])
  );
