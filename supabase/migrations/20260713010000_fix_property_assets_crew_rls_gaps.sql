-- Self-audit fix — two real gaps found in property_assets_crew_select/insert
-- (20260712140100_property_assets_crew_rls.sql):
--
-- 1. CRITICAL: neither policy bound the row's own org_id to the property's
--    real org, or to the org the crew_members match was found in. A
--    crew_members row is only unique per (org_id, user_id) — the same
--    auth.uid() can have separate crew_members rows in multiple orgs (a
--    supported case per 20260707190000_crew_members_external_unique.sql's
--    contractor-import scenario). That meant a crew member who is crew in
--    both Org A (with a real assignment at property P1) and Org B (with no
--    assignment at all) could insert a property_assets row for
--    (property_id: P1, org_id: B) — passing both branches of the WITH CHECK
--    independently — corrupting Org A's asset record and leaking it into
--    Org B's view via the ordinary org-scoped SELECT policy.
--
-- 2. HIGH: the INSERT policy had no column restrictions, so a crew member
--    driving the Supabase client directly (not through the app's discovery
--    form) could set purchase_price/warranty/health_score/macrs_class etc.
--    on their own insert — fields that are otherwise admin/manager-only
--    everywhere else in the schema and feed owner-facing financial
--    reporting. WITH CHECK now pins every one of those fields to the exact
--    default the legitimate discovery-capture UI already sends (verified
--    against the live column defaults), so a crew-sourced row can only ever
--    carry name/asset_type/make/model/photo_url/is_na/scan_status —
--    everything else stays at its untouched default until a PM edits it.

DROP POLICY IF EXISTS "property_assets_crew_select" ON public.property_assets;
CREATE POLICY "property_assets_crew_select"
  ON public.property_assets FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM properties p WHERE p.id = property_assets.property_id AND p.org_id = property_assets.org_id)
    AND (
      property_id IN (
        SELECT DISTINCT t.property_id
        FROM turnovers t
        JOIN turnover_assignments ta ON ta.turnover_id = t.id
        JOIN crew_members cm ON ta.crew_member_id = cm.id
        WHERE cm.user_id = (select auth.uid())
          AND cm.org_id = property_assets.org_id
      )
      OR property_id IN (
        SELECT wo.property_id
        FROM work_orders wo
        JOIN crew_members cm ON wo.assigned_crew_member_id = cm.id
        WHERE cm.user_id = (select auth.uid())
          AND cm.org_id = property_assets.org_id
      )
    )
  );

DROP POLICY IF EXISTS "property_assets_crew_insert" ON public.property_assets;
CREATE POLICY "property_assets_crew_insert"
  ON public.property_assets FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM properties p WHERE p.id = property_assets.property_id AND p.org_id = property_assets.org_id)
    AND (
      property_id IN (
        SELECT DISTINCT t.property_id
        FROM turnovers t
        JOIN turnover_assignments ta ON ta.turnover_id = t.id
        JOIN crew_members cm ON ta.crew_member_id = cm.id
        WHERE cm.user_id = (select auth.uid())
          AND cm.org_id = property_assets.org_id
      )
      OR property_id IN (
        SELECT wo.property_id
        FROM work_orders wo
        JOIN crew_members cm ON wo.assigned_crew_member_id = cm.id
        WHERE cm.user_id = (select auth.uid())
          AND cm.org_id = property_assets.org_id
      )
    )
    -- Column lockdown — crew inserts may only set discovery-capture fields.
    -- Everything financial/health/warranty-related must stay at its default
    -- until a PM (who has the unrestricted property_assets_insert policy)
    -- edits it.
    AND serial_number IS NULL
    AND installation_date IS NULL
    AND manufacture_date IS NULL
    AND purchase_price IS NULL
    AND estimated_replacement_cost IS NULL
    AND expected_lifespan_years IS NULL
    AND warranty_expiry_date IS NULL
    AND warranty_provider IS NULL
    AND warranty_notes IS NULL
    AND placed_in_service_date IS NULL
    AND health_score IS NULL
    AND health_score_updated_at IS NULL
    AND replaced_by_asset_id IS NULL
    AND verified_at IS NULL
    AND macrs_class = '5_year'
    AND depreciation_method = 'macrs'
    AND salvage_value = 0
    AND replacement_status = 'projected'
    AND is_active = true
  );
