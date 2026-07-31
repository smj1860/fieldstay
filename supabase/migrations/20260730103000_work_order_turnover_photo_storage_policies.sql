-- H2 (pre-launch audit 2026-07-30) — the `work-order-photos` and
-- `turnover-photos` buckets have NO storage.objects policies at all, yet both
-- are written from the browser with the user's RLS client. With RLS enabled on
-- storage.objects and no policy, every one of those uploads is denied:
--
--   * app/(dashboard)/maintenance/CreateWorkOrderModal.tsx:104-110 counts the
--     failures into a non-blocking toast
--   * lib/turnovers/flag-photo-upload.ts:8 never checks the error at all
--   * lib/dexie/photo-sync.ts:207-210 (crew checklist/asset photos) surfaces
--     it only as a retry that can never succeed
--
-- so crew and PM photo evidence silently disappears.
--
-- ⚠️ PATH CONTRACT — these policies require an `${org_id}/` FIRST PATH SEGMENT,
-- which the current call sites do NOT produce. They must be changed in the
-- same release (tracked as a cross-file follow-up; those files are owned
-- elsewhere). Required formats:
--
--   work-order-photos  `${orgId}/${workOrderId}/${Date.now()}-${crypto.randomUUID()}.${ext}`
--                      (today: `wo-${workOrderId}/...`)
--   turnover-photos    `${orgId}/turnover-${turnoverId}/...`
--                      (today: `turnover-${turnoverId}/...`,
--                               `asset-discovery/${propertyId}/...`)
--
-- Until those call sites are updated, uploads stay denied — the same state as
-- before this migration, never worse. public.storage_org_prefix() (see
-- 20260730101000) returns NULL rather than raising 22P02 for the legacy
-- non-UUID prefixes, so existing objects fail the predicate cleanly instead of
-- erroring the query.
--
-- NOTE both buckets are `public: true`, so object DOWNLOADS go through the
-- public URL endpoint and bypass RLS entirely — the SELECT policies below
-- govern only authenticated API reads (list/signed URLs). Making these
-- buckets private is a separate, larger change: every consumer currently
-- builds a getPublicUrl()/`/object/public/...` URL.

-- ── work-order-photos ─────────────────────────────────────────────────────
-- Written from the PM dashboard only. The vendor-facing public-token routes
-- (app/api/work-orders/[token]/photos, app/actions/work-order-public.ts) use
-- the service client and are unaffected by RLS either way.
DROP POLICY IF EXISTS "work_order_photos_select" ON storage.objects;
DROP POLICY IF EXISTS "work_order_photos_insert" ON storage.objects;
DROP POLICY IF EXISTS "work_order_photos_update" ON storage.objects;
DROP POLICY IF EXISTS "work_order_photos_delete" ON storage.objects;

CREATE POLICY "work_order_photos_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'work-order-photos'
    AND (
      public.storage_org_prefix(name) IN (SELECT public.get_user_org_ids())
      OR public.storage_org_prefix(name) IN (SELECT public.get_crew_org_ids())
    )
  );

CREATE POLICY "work_order_photos_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'work-order-photos'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  );

CREATE POLICY "work_order_photos_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'work-order-photos'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  )
  WITH CHECK (
    bucket_id = 'work-order-photos'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  );

CREATE POLICY "work_order_photos_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'work-order-photos'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  );

-- ── turnover-photos ───────────────────────────────────────────────────────
-- Written by BOTH the PM dashboard (QuickFlagPanel → flag-photo-upload.ts)
-- and the crew PWA (lib/dexie/photo-sync.ts: checklist item/section photos
-- and asset-discovery photos). Crew hold no organization_members row, so the
-- crew branch goes through get_crew_org_ids() — without it every crew photo
-- upload stays denied. Upsert is used by photo-sync, hence the UPDATE policy.
DROP POLICY IF EXISTS "turnover_photos_select" ON storage.objects;
DROP POLICY IF EXISTS "turnover_photos_insert" ON storage.objects;
DROP POLICY IF EXISTS "turnover_photos_update" ON storage.objects;
DROP POLICY IF EXISTS "turnover_photos_delete" ON storage.objects;

CREATE POLICY "turnover_photos_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'turnover-photos'
    AND (
      public.storage_org_prefix(name) IN (SELECT public.get_user_org_ids())
      OR public.storage_org_prefix(name) IN (SELECT public.get_crew_org_ids())
    )
  );

CREATE POLICY "turnover_photos_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'turnover-photos'
    AND (
      public.is_org_member(
        public.storage_org_prefix(name),
        ARRAY['admin'::public.member_role, 'manager'::public.member_role]
      )
      OR public.storage_org_prefix(name) IN (SELECT public.get_crew_org_ids())
    )
  );

CREATE POLICY "turnover_photos_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'turnover-photos'
    AND (
      public.is_org_member(
        public.storage_org_prefix(name),
        ARRAY['admin'::public.member_role, 'manager'::public.member_role]
      )
      OR public.storage_org_prefix(name) IN (SELECT public.get_crew_org_ids())
    )
  )
  WITH CHECK (
    bucket_id = 'turnover-photos'
    AND (
      public.is_org_member(
        public.storage_org_prefix(name),
        ARRAY['admin'::public.member_role, 'manager'::public.member_role]
      )
      OR public.storage_org_prefix(name) IN (SELECT public.get_crew_org_ids())
    )
  );

-- Deleting stored evidence is a PM action — crew never delete.
CREATE POLICY "turnover_photos_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'turnover-photos'
    AND public.is_org_member(
      public.storage_org_prefix(name),
      ARRAY['admin'::public.member_role, 'manager'::public.member_role]
    )
  );
