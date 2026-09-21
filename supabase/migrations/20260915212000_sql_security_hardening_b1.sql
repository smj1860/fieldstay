-- ============================================================================
-- Four independent security/RLS hardening fixes from the hostile SQL audit.
--
-- 1 & 2. protect_checklist_instances_crew_columns() and
--    apply_asset_health_scores() are SECURITY DEFINER with
--    `SET search_path = public` (not ''), and reference tables unqualified
--    (organization_members, property_assets). Postgres always searches the
--    caller's temp schema (pg_temp) FIRST for relation names, ahead of
--    whatever search_path a SECURITY DEFINER function sets, unless every
--    reference is schema-qualified or search_path is ''. A session with
--    CREATE TEMP TABLE privilege could shadow organization_members with a
--    fabricated one and forge is_pm = true, bypassing the crew-column guard
--    entirely. Not reachable through the app's normal PostgREST surface
--    today (authenticated has no path to CREATE TEMP TABLE), but every other
--    SECURITY DEFINER function in this schema already uses SET search_path
--    = '' plus public.-qualified references — these two were the outliers.
--
-- 3. mark_property_setup_step shipped with a GRANT EXECUTE TO authenticated
--    and no accompanying REVOKE ALL FROM PUBLIC, anon. CREATE FUNCTION
--    grants EXECUTE to PUBLIC by default, which on a Supabase project means
--    anon can call it over /rest/v1/rpc/ with the publishable key — the same
--    gotcha 20260807170000_guidebook_offer_open_count.sql's own comment
--    calls out and revokes against. SECURITY INVOKER plus the properties
--    UPDATE policy's is_org_member() check means an anon call fails at RLS
--    today (0 rows), but it is unauthenticated traffic reaching a mutating
--    RPC for no reason, one RLS regression away from a real write path.
--
-- 4. property_assets_update's crew branch grants indefinite, unbounded write
--    access: a crew member assigned to a SINGLE turnover or work order EVER,
--    including one from years ago or long since cancelled/completed, retains
--    permanent write access to that property's property_assets rows forever
--    — even after the assignment ends or the crew member leaves active
--    rotation. Tightened to require the assignment be non-cancelled/
--    non-terminal and recent, tracking current/active assignment rather than
--    ever-assigned.
-- ============================================================================

-- 1. protect_checklist_instances_crew_columns() — search_path + qualification
CREATE OR REPLACE FUNCTION public.protect_checklist_instances_crew_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  is_pm boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = auth.uid()
      AND org_id  = NEW.org_id
      AND role IN ('admin'::public.member_role, 'manager'::public.member_role, 'owner'::public.member_role)
  ) INTO is_pm;

  IF is_pm THEN
    RETURN NEW;
  END IF;

  -- Not a PM on this org — a legitimate crew write only ever changes
  -- completed_at/completed_by_crew_id directly, OR triggers a nested
  -- started_at write via set_checklist_instance_started_at() (depth > 1).
  -- Reject anything else outright rather than silently reverting it, so a
  -- client-side bug surfaces immediately instead of masking a write that
  -- silently didn't apply.
  IF NEW.org_id             IS DISTINCT FROM OLD.org_id
     OR NEW.turnover_id     IS DISTINCT FROM OLD.turnover_id
     OR NEW.template_id     IS DISTINCT FROM OLD.template_id
     OR NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot
     OR NEW.status          IS DISTINCT FROM OLD.status
     OR (NEW.started_at IS DISTINCT FROM OLD.started_at AND pg_trigger_depth() <= 1)
     OR NEW.section_photo_path IS DISTINCT FROM OLD.section_photo_path
  THEN
    RAISE EXCEPTION 'crew members may only update completed_at and completed_by_crew_id on checklist_instances';
  END IF;

  RETURN NEW;
END;
$$;

-- 2. apply_asset_health_scores() — search_path + qualification
CREATE OR REPLACE FUNCTION public.apply_asset_health_scores(
  p_org_id  uuid,
  p_updates jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'apply_asset_health_scores requires p_org_id';
  END IF;

  UPDATE public.property_assets AS pa
     SET health_score            = u.health_score,
         health_score_updated_at = u.health_score_updated_at
    FROM jsonb_to_recordset(p_updates)
      AS u(id uuid, health_score smallint, health_score_updated_at timestamptz)
   WHERE pa.id     = u.id
     AND pa.org_id = p_org_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_asset_health_scores(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_asset_health_scores(uuid, jsonb) TO service_role;

-- 3. mark_property_setup_step — close the default PUBLIC/anon EXECUTE grant
REVOKE ALL ON FUNCTION public.mark_property_setup_step(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_property_setup_step(uuid, uuid, text) TO authenticated;

-- 4. property_assets_update — crew branch tracks CURRENT/ACTIVE assignment,
-- not EVER-assigned. Excludes a cancelled turnover / a completed or
-- cancelled work order, and bounds the turnover branch to a recent checkout
-- so a years-old assignment cannot grant permanent write access.
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
             AND t.status <> 'cancelled'
             AND t.checkout_datetime > now() - interval '30 days'
        )
        OR property_id IN (
          SELECT wo.property_id
            FROM public.work_orders wo
            JOIN public.crew_members cm ON wo.assigned_crew_member_id = cm.id
           WHERE cm.user_id = (SELECT auth.uid())
             AND cm.org_id  = property_assets.org_id
             AND wo.status NOT IN ('completed', 'cancelled')
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
             AND t.status <> 'cancelled'
             AND t.checkout_datetime > now() - interval '30 days'
        )
        OR property_id IN (
          SELECT wo.property_id
            FROM public.work_orders wo
            JOIN public.crew_members cm ON wo.assigned_crew_member_id = cm.id
           WHERE cm.user_id = (SELECT auth.uid())
             AND cm.org_id  = property_assets.org_id
             AND wo.status NOT IN ('completed', 'cancelled')
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
