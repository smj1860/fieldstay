-- ============================================================================
-- Crew could INSERT a discovered asset but never UPDATE one.
--
-- property_assets_insert has a deliberate crew branch (assigned to a turnover
-- or work order at that property, and every PM/financial column left NULL).
-- property_assets_update was left as admin/manager only. Progressive Asset
-- Discovery needs both, and the gap silently broke the half that matters:
--
--   • lib/dexie/photo-sync.ts, after the blob reaches Storage, enqueues a
--     property_assets PATCH setting photo_url. Under RLS that UPDATE matched
--     ZERO rows, so uploadPropertyAssetPhotoUpdate threw
--     "matched zero rows for id …" — a plain Error, not an UploadDataError, so
--     the outbox treats it as transient and retries it forever.
--   • That throw happens BEFORE the scan request is fired, so the vision scan
--     that fills in make/model from the photo never ran for a crew capture.
--   • A retried upsert whose first attempt had actually committed (lost
--     response, flaky connection) takes the ON CONFLICT DO UPDATE branch and
--     was refused outright with 42501.
--
-- Verified against the E2E project as a user proven NOT to be an org member
-- (is_org_member(admin,manager)=false): INSERT ok, photo PATCH 0 rows, upsert
-- conflict 42501. Production agrees that this has never once worked — 0 assets
-- with scan_status set, 0 with an asset-discovery photo path, ever, against
-- 660 asset-discovery checklist items handed out.
--
-- WHAT THE CREW BRANCH ALLOWS, AND WHY IT IS SHAPED THIS WAY
--
-- Postgres RLS cannot compare OLD to NEW — USING sees the existing row, WITH
-- CHECK sees the resulting one, and neither can see the other. Column-level
-- immutability would need a trigger or a column GRANT, and a column GRANT is
-- role-wide (`authenticated` covers PMs too), so it would break the PM's own
-- editing. The workable equivalent is to require the row to be
-- DISCOVERY-SHAPED both before and after: every PM/financial/lifecycle column
-- NULL. A crew member therefore cannot wipe a purchase price, because a row
-- that has one is not a row they can target at all.
--
-- Three columns are deliberately NOT frozen, and each has a reason:
--
--   health_score, health_score_updated_at — written by the daily asset-health
--     cron. Freezing them would mean a capture made offline on Monday and
--     synced on Thursday is refused because a cron scored the row in between:
--     the same silent, delayed failure this migration exists to remove.
--   make, model — the vision scan writes these server-side after the photo
--     lands, and a crew re-capture legitimately sets them.
--   scan_status — the crew client sets it to 'pending' on capture.
--
-- verified_at stays frozen (NULL) exactly as the INSERT policy has it, so the
-- asset-manual-lookup Inngest function stamping it graduates the row out of
-- crew reach. Nothing reads it for discovery — lib/asset-discovery/engine.ts
-- keys on make/model/photo_url/is_na — so this costs the flow nothing.
-- ============================================================================

DROP POLICY IF EXISTS property_assets_update ON public.property_assets;

CREATE POLICY property_assets_update
  ON public.property_assets FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR (
      EXISTS (
        SELECT 1 FROM public.properties p
         WHERE p.id = property_assets.property_id
           AND p.org_id = property_assets.org_id
      )
      AND (
        property_id IN (
          SELECT DISTINCT t.property_id
            FROM public.turnovers t
            JOIN public.turnover_assignments ta ON ta.turnover_id = t.id
            JOIN public.crew_members cm         ON ta.crew_member_id = cm.id
           WHERE cm.user_id = (SELECT auth.uid())
             AND cm.org_id  = property_assets.org_id
        )
        OR property_id IN (
          SELECT wo.property_id
            FROM public.work_orders wo
            JOIN public.crew_members cm ON wo.assigned_crew_member_id = cm.id
           WHERE cm.user_id = (SELECT auth.uid())
             AND cm.org_id  = property_assets.org_id
        )
      )
      AND serial_number              IS NULL
      AND installation_date          IS NULL
      AND manufacture_date           IS NULL
      AND purchase_price             IS NULL
      AND estimated_replacement_cost IS NULL
      AND expected_lifespan_years    IS NULL
      AND warranty_expiry_date       IS NULL
      AND warranty_provider          IS NULL
      AND warranty_notes             IS NULL
      AND placed_in_service_date     IS NULL
      AND replaced_by_asset_id       IS NULL
      AND verified_at                IS NULL
      AND macrs_class         = '5_year'::macrs_class
      AND depreciation_method = 'macrs'
      AND salvage_value       = 0
      AND replacement_status  = 'projected'
      AND is_active           = true
    )
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR (
      EXISTS (
        SELECT 1 FROM public.properties p
         WHERE p.id = property_assets.property_id
           AND p.org_id = property_assets.org_id
      )
      AND (
        property_id IN (
          SELECT DISTINCT t.property_id
            FROM public.turnovers t
            JOIN public.turnover_assignments ta ON ta.turnover_id = t.id
            JOIN public.crew_members cm         ON ta.crew_member_id = cm.id
           WHERE cm.user_id = (SELECT auth.uid())
             AND cm.org_id  = property_assets.org_id
        )
        OR property_id IN (
          SELECT wo.property_id
            FROM public.work_orders wo
            JOIN public.crew_members cm ON wo.assigned_crew_member_id = cm.id
           WHERE cm.user_id = (SELECT auth.uid())
             AND cm.org_id  = property_assets.org_id
        )
      )
      AND serial_number              IS NULL
      AND installation_date          IS NULL
      AND manufacture_date           IS NULL
      AND purchase_price             IS NULL
      AND estimated_replacement_cost IS NULL
      AND expected_lifespan_years    IS NULL
      AND warranty_expiry_date       IS NULL
      AND warranty_provider          IS NULL
      AND warranty_notes             IS NULL
      AND placed_in_service_date     IS NULL
      AND replaced_by_asset_id       IS NULL
      AND verified_at                IS NULL
      AND macrs_class         = '5_year'::macrs_class
      AND depreciation_method = 'macrs'
      AND salvage_value       = 0
      AND replacement_status  = 'projected'
      AND is_active           = true
    )
  );

NOTIFY pgrst, 'reload schema';
