-- Inspections phase 3 — the `inspection-photos` bucket and its policies.
--
-- docs/INSPECTIONS_SPEC.md §8a surveyed the six existing buckets and none fits:
-- `turnover-photos` and `work-order-photos` are bound to a different parent,
-- `compliance-documents` is vendor paperwork, the two `guidebook-*` buckets are
-- guest-facing and public, and `crew-uploads` is dead infrastructure that was
-- only just made private (20260822054254).
--
-- PRIVATE, 10MB, mirroring `work-order-photos`. HEIC is in the allowed list
-- because iOS sends it, but compression re-encodes to JPEG before upload, so a
-- HEIC only reaches the bucket on the fallback path in lib/images/compress.ts.
--
-- ── The path contract, and why it is stated before anything writes here ─────
--
-- Every object MUST be `${orgId}/${inspectionId}/...`, produced by
-- orgScopedStoragePath(). The policies below read the first path segment via
-- public.storage_org_prefix() and there is no other tenant dimension on a
-- storage object — get that wrong and the bucket is either unwritable or
-- cross-readable.
--
-- 20260730103000 shipped exactly these policies for work-order-photos while the
-- call sites still wrote `wo-${id}/...`, which denied every upload until they
-- were fixed. That is not a hazard here only because nothing writes to this
-- bucket yet: the writer and the contract land together, and
-- unit/guardrails/org-scoped-storage-paths.test.ts covers the new bucket for
-- free once it is listed there.
--
-- ── Who may do what ─────────────────────────────────────────────────────────
--
-- INSERT/UPDATE/DELETE: admin|manager (is_org_member passes 'owner'
-- unconditionally). §5's letterhead note is explicit that whoever the PM hands
-- the tablet to counts as the inspector, but that person still signs in as a
-- team member — there is no crew path to an inspection.
--
-- SELECT: any member of the owning org. DELIBERATELY NARROWER than
-- work-order-photos, which additionally admits get_crew_org_ids(): crew never
-- read inspections, and a photo of a property interior is not something to
-- widen access to on the chance it might be convenient later.
--
-- The OWNER PORTAL needs no policy here. It is token-gated and runs through the
-- service client, which bypasses RLS — same as every other owner-facing read.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'inspection-photos',
  'inspection-photos',
  false,
  10485760,                                    -- 10MB, matching work-order-photos
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "inspection_photos_select" ON storage.objects;
DROP POLICY IF EXISTS "inspection_photos_insert" ON storage.objects;
DROP POLICY IF EXISTS "inspection_photos_update" ON storage.objects;
DROP POLICY IF EXISTS "inspection_photos_delete" ON storage.objects;

CREATE POLICY "inspection_photos_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'inspection-photos'
    AND public.storage_org_prefix(name) IN (SELECT public.get_user_org_ids())
  );

CREATE POLICY "inspection_photos_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'inspection-photos'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  );

-- UPDATE needs BOTH USING and WITH CHECK: USING decides which objects are
-- visible to the update, WITH CHECK what they may be changed TO. Without the
-- second, an object could be renamed into another org's prefix.
CREATE POLICY "inspection_photos_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'inspection-photos'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  )
  WITH CHECK (
    bucket_id = 'inspection-photos'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  );

CREATE POLICY "inspection_photos_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'inspection-photos'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  );
