-- Pre-launch audit 2026-07-30 (H2, part 2 of 2).
--
-- `work-order-photos` and `turnover-photos` are `public = true`, so EVERY
-- property-interior photo, work-order completion photo, and crew checklist
-- photo is world-readable to anyone holding the object URL — and those URLs
-- were embedded directly in dashboard pages (and reachable from anything that
-- ever leaked one). A public bucket also bypasses storage RLS entirely on
-- download, which makes the org-scoped SELECT policies added by
-- 20260730103000 decorative for the one operation that matters most.
--
-- This flips both buckets private. Reads now go through short-lived
-- (5-minute) signed URLs minted server-side after an org-ownership check:
--   * components/work-orders/work-order-detail.tsx
--       → getWorkOrderPhotoUrls() in app/(dashboard)/maintenance/actions.ts
--   * property_assets.photo_url / checklist photo paths are never rendered as
--     images today; they are read only by the data-plate scan pipeline, which
--     downloads with the service-role client (unaffected by bucket privacy).
--
-- Companion code change in the same release adopts the `${org_id}/` first
-- path segment the 20260730103000 policies require, at every upload site.

-- ── 1. Make both buckets private ─────────────────────────────────────────────
UPDATE storage.buckets
   SET public = false
 WHERE id IN ('work-order-photos', 'turnover-photos');

-- ── 2. Normalize stored values to bare object keys ───────────────────────────
--
-- Historically `property_assets.photo_url` stored a full
-- `<project>/storage/v1/object/public/turnover-photos/<key>` URL (built with
-- getPublicUrl()). That URL 400s against a private bucket, and it is not a
-- value any signed-URL/download call can take. Strip it back to the bare
-- object key, which is what every read path now expects and what
-- lib/storage/object-path.ts's toStorageObjectPath() produces.
--
-- ⚠️ What this migration deliberately does NOT do: re-prefix legacy keys
-- (`wo-<id>/…`, `turnover-<id>/…`, `asset-discovery/<property_id>/…`) with the
-- org id. The physical object still lives under its original key — Supabase
-- Storage resolves objects by `storage.objects.name`, so rewriting the name in
-- a DB column without moving the object would orphan the file. Legacy keys are
-- therefore left intact, and every read path tolerates them by signing with
-- the service-role client after authorizing the caller out-of-band.
--
-- Idempotent: the WHERE clauses only match values that still look like URLs,
-- so a re-run is a no-op.

-- Expression used by all four UPDATEs: drop everything up to and including
-- `/storage/v1/object/<public|sign|authenticated>/<bucket>/`, drop any query
-- string (signed URLs carry ?token=…), then decode the only escape our own
-- key generator could ever produce.
--
--   split_part(regexp_replace(col, '^.*/storage/v1/object/[^/]+/<bucket>/', ''), '?', 1)

UPDATE property_assets
   SET photo_url = replace(
         split_part(regexp_replace(photo_url, '^.*/storage/v1/object/[^/]+/turnover-photos/', ''), '?', 1),
         '%20', ' ')
 WHERE photo_url LIKE '%/storage/v1/object/%/turnover-photos/%';

UPDATE work_order_photos
   SET storage_path = replace(
         split_part(regexp_replace(storage_path, '^.*/storage/v1/object/[^/]+/work-order-photos/', ''), '?', 1),
         '%20', ' ')
 WHERE storage_path LIKE '%/storage/v1/object/%/work-order-photos/%';

UPDATE checklist_instance_items
   SET photo_storage_path = replace(
         split_part(regexp_replace(photo_storage_path, '^.*/storage/v1/object/[^/]+/turnover-photos/', ''), '?', 1),
         '%20', ' ')
 WHERE photo_storage_path LIKE '%/storage/v1/object/%/turnover-photos/%';

UPDATE checklist_instances
   SET section_photo_path = replace(
         split_part(regexp_replace(section_photo_path, '^.*/storage/v1/object/[^/]+/turnover-photos/', ''), '?', 1),
         '%20', ' ')
 WHERE section_photo_path LIKE '%/storage/v1/object/%/turnover-photos/%';

-- Live row counts on project vpmznjktllhmmbfnxuvk at authoring time
-- (2026-07-30): 0 rows matched any of the four UPDATEs, and both buckets held
-- 0 objects — this app has not launched. The backfill is written anyway
-- because the E2E project, local stacks, and any demo-seeded environment can
-- and do carry rows in the old shape.
