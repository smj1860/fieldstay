-- Capture schema drift from direct-SQL changes made on production.
--
-- A full prod-vs-E2E diff (2026-07-24) found that a number of production
-- objects had been created or edited directly in the dashboard without a
-- matching migration file, so any environment built purely from
-- supabase/migrations/ (the E2E project) diverged:
--
--   * 12 functions differed and 1 was missing — including the RLS-critical
--     helpers get_user_org_ids / is_org_member / get_crew_member_id
--   * crew_feedback's timestamp column was renamed created_at → submitted_at
--     on prod only
--   * inventory_template_items.par_level was widened integer → numeric on
--     prod only
--   * the 23-row maintenance_catalog_items platform seed existed on prod only
--
-- (Policy drift found in the same diff is already covered by the existing
-- 20260723090000/20260723120000 migrations; the handle_new_user drift was
-- captured separately in 20260724150000.)
--
-- This migration is the prod-authoritative state as a file: a no-op where
-- the state already matches (both live projects at time of writing), the
-- fix everywhere else. Everything here is idempotent.

-- ── Column drift ─────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='crew_feedback' AND column_name='created_at')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='crew_feedback' AND column_name='submitted_at')
  THEN
    ALTER TABLE public.crew_feedback RENAME COLUMN created_at TO submitted_at;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='inventory_template_items'
               AND column_name='par_level' AND data_type <> 'numeric')
  THEN
    ALTER TABLE public.inventory_template_items ALTER COLUMN par_level TYPE numeric;
  END IF;
END $$;

-- ── Function drift (prod definitions, verbatim) ──────────────────────────

CREATE OR REPLACE FUNCTION public.get_user_org_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT org_id FROM organization_members
  WHERE user_id = auth.uid()
  AND invite_accepted_at IS NOT NULL
$function$;

CREATE OR REPLACE FUNCTION public.is_org_member(p_org_id uuid, p_roles member_role[] DEFAULT NULL::member_role[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM organization_members
    WHERE org_id              = p_org_id
      AND user_id             = auth.uid()
      AND invite_accepted_at IS NOT NULL
      AND (
        p_roles IS NULL                    -- no role restriction: any member passes
        OR role = ANY(p_roles)             -- explicit role match
        OR role = 'owner'::member_role     -- org owner always has full access
      )
  )
$function$;

CREATE OR REPLACE FUNCTION public.get_crew_member_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM crew_members WHERE user_id = auth.uid() LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.assign_wo_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.wo_number IS NULL THEN
    NEW.wo_number := next_wo_number(NEW.org_id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.next_wo_number(p_org_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_year   smallint := EXTRACT(YEAR FROM NOW())::smallint;
  v_number integer;
BEGIN
  INSERT INTO wo_number_counters (org_id, last_number, current_year)
  VALUES (p_org_id, 1, v_year)
  ON CONFLICT (org_id) DO UPDATE
    SET last_number  = CASE
                         WHEN wo_number_counters.current_year = v_year
                         THEN wo_number_counters.last_number + 1
                         ELSE 1
                       END,
        current_year = v_year
  RETURNING last_number INTO v_number;
  RETURN 'WO-' || v_year || '-' || LPAD(v_number::text, 4, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_oauth_states()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  DELETE FROM public.oauth_states WHERE expires_at < now();
$function$;

CREATE OR REPLACE FUNCTION public.set_comm_log_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- communication_logs has no updated_at; this is a no-op placeholder
  -- included for schema consistency
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_wo_actual_cost()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wo_id      uuid;
  v_item_count integer;
  v_total      numeric(10,2);
BEGIN
  v_wo_id := COALESCE(NEW.work_order_id, OLD.work_order_id);
  SELECT COUNT(*), COALESCE(SUM(line_total), 0)
  INTO v_item_count, v_total
  FROM work_order_line_items
  WHERE work_order_id = v_wo_id;
  IF v_item_count > 0 THEN
    UPDATE work_orders SET actual_cost = v_total WHERE id = v_wo_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.protect_checklist_instances_crew_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  is_pm boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE user_id = auth.uid()
      AND org_id  = NEW.org_id
      AND role IN ('admin'::member_role, 'manager'::member_role, 'owner'::member_role)
  ) INTO is_pm;

  IF is_pm THEN
    RETURN NEW;
  END IF;

  -- Not a PM on this org — a legitimate crew write only ever changes
  -- completed_at/completed_by_crew_id. Reject anything else outright
  -- rather than silently reverting it, so a client-side bug surfaces
  -- immediately instead of masking a write that silently didn't apply.
  IF NEW.org_id             IS DISTINCT FROM OLD.org_id
     OR NEW.turnover_id     IS DISTINCT FROM OLD.turnover_id
     OR NEW.template_id     IS DISTINCT FROM OLD.template_id
     OR NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot
     OR NEW.status          IS DISTINCT FROM OLD.status
     OR NEW.started_at      IS DISTINCT FROM OLD.started_at
     OR NEW.section_photo_path IS DISTINCT FROM OLD.section_photo_path
  THEN
    RAISE EXCEPTION 'crew members may only update completed_at and completed_by_crew_id on checklist_instances';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.purge_expired_audit_events()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_financial_cutoff    timestamptz := NOW() - INTERVAL '7 years';
  v_operational_cutoff  timestamptz := NOW() - INTERVAL '3 years';
  v_financial_deleted   integer;
  v_operational_deleted integer;
BEGIN
  -- Financial records: billing and owner transaction audit events (7-year IRS/GAAP retention)
  DELETE FROM audit_events
  WHERE created_at < v_financial_cutoff
    AND (action LIKE 'billing.%' OR action LIKE 'owner.transaction.%');
  GET DIAGNOSTICS v_financial_deleted = ROW_COUNT;

  -- Operational records: all other audit events (3-year SOC2/GDPR retention)
  DELETE FROM audit_events
  WHERE created_at < v_operational_cutoff
    AND action NOT LIKE 'billing.%'
    AND action NOT LIKE 'owner.transaction.%';
  GET DIAGNOSTICS v_operational_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'financial_deleted',   v_financial_deleted,
    'operational_deleted', v_operational_deleted,
    'run_at',              NOW()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_crew_score_recompute()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_scored_count   integer := 0;
  v_crew_count     integer := 0;
  v_capacity_count integer := 0;
BEGIN
  -- Atomically claim + score outcomes in one statement: candidates are
  -- computed, claimed (scored_at set), and folded into a per-crew delta, all
  -- within a single UPDATE ... FROM chain. A retry after any failure here
  -- rolls back entirely (functions run in the caller's transaction) and sees
  -- the exact same unscored candidates again — no partial-apply/double-count
  -- window like the two-phase JS loop this replaces.
  WITH candidates AS (
    SELECT
      ao.id,
      ao.crew_member_id,
      ao.was_missed,
      (
        NOT ao.was_missed
        AND ao.completed_at IS NOT NULL
        AND t.checkin_datetime IS NOT NULL
        AND ao.completed_at > t.checkin_datetime
      ) AS was_late,
      ao.pm_rating
    FROM assignment_outcomes ao
    LEFT JOIN turnovers t ON t.id = ao.turnover_id
    WHERE ao.scored_at IS NULL
      AND (ao.completed_at IS NOT NULL OR ao.was_missed = true)
  ),
  scored AS (
    UPDATE assignment_outcomes ao
    SET scored_at = now(),
        was_late  = candidates.was_late
    FROM candidates
    WHERE ao.id = candidates.id
    RETURNING ao.id, candidates.crew_member_id, candidates.was_missed, candidates.was_late, candidates.pm_rating
  ),
  deltas AS (
    SELECT
      crew_member_id,
      SUM(
        CASE
          WHEN was_missed THEN -0.15
          ELSE
            (CASE WHEN was_late THEN -0.05 ELSE 0.02 END)
            + COALESCE((pm_rating - 3) * 0.03, 0)
        END
      ) AS delta
    FROM scored
    GROUP BY crew_member_id
  ),
  updated_crew AS (
    UPDATE crew_members cm
    SET reliability_score = GREATEST(0, LEAST(1, COALESCE(cm.reliability_score, 1.0) + deltas.delta)),
        updated_at = now()
    FROM deltas
    WHERE cm.id = deltas.crew_member_id
    RETURNING cm.id
  )
  SELECT
    (SELECT count(*) FROM scored),
    (SELECT count(*) FROM updated_crew)
  INTO v_scored_count, v_crew_count;

  -- Capacity score: pure recompute-from-scratch every run (not a delta), so
  -- naturally idempotent/retry-safe on its own — no claim step needed.
  WITH capacity AS (
    SELECT
      crew_member_id,
      count(*) FILTER (WHERE property_bedrooms >= 4) AS large_count,
      count(*) AS total_count
    FROM assignment_outcomes
    WHERE property_bedrooms IS NOT NULL
      AND completed_at IS NOT NULL
    GROUP BY crew_member_id
    HAVING count(*) >= 3
  ),
  updated_capacity AS (
    UPDATE crew_members cm
    SET capacity_score = ROUND((capacity.large_count::numeric / capacity.total_count), 3),
        updated_at = now()
    FROM capacity
    WHERE cm.id = capacity.crew_member_id
    RETURNING cm.id
  )
  SELECT count(*) FROM updated_capacity INTO v_capacity_count;

  RETURN jsonb_build_object(
    'scored',          v_scored_count,
    'crewUpdated',     v_crew_count,
    'capacityUpdated', v_capacity_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_pending_integration_link(p_pending_link_token text, p_user_id uuid)
 RETURNS TABLE(provider_id text, external_user_id text, org_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_pending            public.pending_integration_links%ROWTYPE;
  v_org_id             uuid;
  v_old_secret_id      uuid;
  v_old_refresh_secret_id uuid;
BEGIN
  SELECT * INTO v_pending
  FROM public.pending_integration_links
  WHERE pending_link_token = p_pending_link_token
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('integration_connection:' || p_user_id::text || ':' || v_pending.provider_id, 0));

  SELECT om.org_id INTO v_org_id
  FROM public.organization_members om
  WHERE om.user_id = p_user_id
    AND om.invite_accepted_at IS NOT NULL
  ORDER BY om.created_at ASC
  LIMIT 1;

  -- Capture whatever secrets an existing connection row currently points at,
  -- before the upsert below overwrites those columns with the pending link's.
  SELECT vault_secret_id, refresh_token_vault_secret_id
    INTO v_old_secret_id, v_old_refresh_secret_id
  FROM public.integration_connections
  WHERE user_id = p_user_id AND provider_id = v_pending.provider_id;

  INSERT INTO public.integration_connections
    (user_id, org_id, provider_id, external_user_id, vault_secret_id, refresh_token_vault_secret_id, scope, metadata, status)
  VALUES
    (p_user_id, v_org_id, v_pending.provider_id, v_pending.external_user_id, v_pending.vault_secret_id,
     v_pending.refresh_token_vault_secret_id, v_pending.scope, v_pending.metadata, 'active')
  ON CONFLICT (user_id, provider_id) DO UPDATE
  SET vault_secret_id                = EXCLUDED.vault_secret_id,
      refresh_token_vault_secret_id  = EXCLUDED.refresh_token_vault_secret_id,
      external_user_id               = EXCLUDED.external_user_id,
      scope                          = EXCLUDED.scope,
      metadata                       = EXCLUDED.metadata,
      status                         = 'active',
      org_id                         = COALESCE(public.integration_connections.org_id, EXCLUDED.org_id),
      reconnect_email_sent_at        = NULL,
      updated_at                     = now();

  -- Now safe to delete the superseded secrets — the row no longer references them.
  IF v_old_secret_id IS NOT NULL AND v_old_secret_id IS DISTINCT FROM v_pending.vault_secret_id THEN
    DELETE FROM vault.secrets WHERE id = v_old_secret_id;
  END IF;
  IF v_old_refresh_secret_id IS NOT NULL AND v_old_refresh_secret_id IS DISTINCT FROM v_pending.refresh_token_vault_secret_id THEN
    DELETE FROM vault.secrets WHERE id = v_old_refresh_secret_id;
  END IF;

  DELETE FROM public.pending_integration_links WHERE id = v_pending.id;

  RETURN QUERY SELECT v_pending.provider_id, v_pending.external_user_id, v_org_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.store_integration_token(p_user_id uuid, p_provider_id text, p_access_token text, p_external_user_id text, p_scope text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_secret_id          uuid;
  v_existing_secret_id uuid;
  v_connection_exists  boolean := false;
  v_org_id             uuid;
  v_secret_name        text := p_provider_id || '_token_' || p_user_id::text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('integration_connection:' || p_user_id::text || ':' || p_provider_id, 0));

  SELECT org_id INTO v_org_id
  FROM public.organization_members
  WHERE user_id = p_user_id
    AND invite_accepted_at IS NOT NULL
  ORDER BY created_at ASC
  LIMIT 1;

  SELECT vault_secret_id, true
    INTO v_existing_secret_id, v_connection_exists
  FROM public.integration_connections
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  -- No connection row pointing at a secret — there may still be an orphaned
  -- one sitting in vault.secrets under this deterministic name (row deleted
  -- without going through revoke_integration_token). Reuse it if so.
  IF v_existing_secret_id IS NULL THEN
    SELECT id INTO v_existing_secret_id FROM vault.secrets WHERE name = v_secret_name;
  END IF;

  IF v_connection_exists THEN
    IF v_existing_secret_id IS NOT NULL THEN
      PERFORM vault.update_secret(v_existing_secret_id, p_access_token);
      v_secret_id := v_existing_secret_id;
    ELSE
      v_secret_id := vault.create_secret(p_access_token, v_secret_name, 'OAuth access token for ' || p_provider_id);
    END IF;

    UPDATE public.integration_connections
    SET vault_secret_id         = v_secret_id,
        external_user_id        = p_external_user_id,
        scope                   = p_scope,
        metadata                = COALESCE(metadata, '{}'::jsonb) || p_metadata,
        status                  = 'active',
        org_id                  = COALESCE(org_id, v_org_id),
        reconnect_email_sent_at = NULL,
        updated_at              = now()
    WHERE user_id     = p_user_id
      AND provider_id = p_provider_id;
  ELSE
    IF v_existing_secret_id IS NOT NULL THEN
      PERFORM vault.update_secret(v_existing_secret_id, p_access_token);
      v_secret_id := v_existing_secret_id;
    ELSE
      v_secret_id := vault.create_secret(p_access_token, v_secret_name, 'OAuth access token for ' || p_provider_id);
    END IF;

    INSERT INTO public.integration_connections
      (user_id, org_id, provider_id, external_user_id, vault_secret_id, scope, metadata)
    VALUES
      (p_user_id, v_org_id, p_provider_id, p_external_user_id, v_secret_id, p_scope, p_metadata);
  END IF;

  RETURN v_secret_id;
END;
$function$;

-- ── Platform seed data drift: maintenance_catalog_items (23 rows) ────────
-- Seeded on prod outside migrations; captured here so a from-migrations
-- rebuild has the catalog. ON CONFLICT keeps this a no-op on prod.

INSERT INTO public.maintenance_catalog_items (id, name, category, is_active, sort_order, description, asset_category, suggested_recurrence) VALUES
('030c9c10-375a-4805-9e3e-ff259502cee8', 'Pool service', 'water_features', true, 1, 'Water chemistry check, skimming, filter backwash, and equipment inspection. Seasonal frequency.', 'pool', 'weekly'),
('d3fe917e-6560-40a3-bc5c-c5f5cefb28d6', 'Hot tub / jacuzzi service', 'water_features', true, 2, 'Water chemistry balance, filter clean, inspect jets, heater, and cover.', 'hot_tub', 'monthly'),
('ef8ab673-2d7b-4df1-84e8-afb26e017dbb', 'Fountain service', 'water_features', true, 3, 'Clean basin, check pump, inspect for algae or debris buildup.', 'fountain', 'monthly'),
('36e22017-94e7-4708-9051-4dba05396c06', 'Dock / boat slip maintenance', 'water_features', true, 4, 'Inspect boards, cleats, lines, and lighting. Check for rot or structural issues.', 'dock', 'semi_annual'),
('7e808aeb-2304-4b28-9b60-7edac622ca9d', 'Chimney sweep & inspection', 'heating_fuel', true, 5, 'Clean flue, inspect cap, damper, firebox, and smoke chamber. Required for wood-burning fireplaces.', 'chimney', 'annual'),
('5a2c1dfb-ab5f-41a3-9fd3-995cb2481abf', 'Gas fireplace cleaning & inspection', 'heating_fuel', true, 6, 'Clean burner assembly, inspect igniter, thermocouple, and glass seal.', 'fireplace', 'annual'),
('1ec4a608-a863-4207-8e6c-46f6e119596e', 'Propane tank inspection', 'heating_fuel', true, 7, 'Check tank level, inspect regulator, supply lines, and connections for leaks.', 'propane', 'annual'),
('d5ddafa9-f17f-4a92-b216-c15ef12bdf02', 'Generator service & load test', 'heating_fuel', true, 8, 'Change oil and filter, test under load, inspect fuel system and battery connections.', 'generator', 'annual'),
('606942b8-150f-447d-8976-54dde8c2b2b7', 'Snow removal', 'outdoor_grounds', true, 9, 'Seasonal. Driveway, walkways, and all entry areas. Adjust frequency to snowfall.', 'grounds', 'weekly'),
('dff16c6c-86dc-41b5-aec0-4b7a6c89ea1a', 'Irrigation / sprinkler system service & winterization', 'outdoor_grounds', true, 10, 'Spring startup and fall winterization. Check heads, valves, timer, and inspect for leaks.', 'irrigation', 'semi_annual'),
('e3d83308-b353-4de5-937f-924b003c9f8d', 'Fence repair & staining', 'outdoor_grounds', true, 11, 'Inspect for loose boards, damaged posts, or rot. Restain or seal wood fencing as needed.', 'exterior', 'annual'),
('103902b9-840e-4bed-be13-7d35196c2d67', 'Driveway sealing', 'outdoor_grounds', true, 12, 'Clean surface and apply sealant to asphalt or concrete driveway. Fills cracks and extends life.', 'exterior', 'annual'),
('b9b66785-6ac4-4e80-84c5-979104d9525c', 'Outdoor kitchen cleaning & service', 'outdoor_grounds', true, 13, 'Deep clean grill grates, burners, and all surfaces. Inspect and test gas connections.', 'outdoor_kitchen', 'semi_annual'),
('28a903cd-220f-4715-a2d7-099c83e1a154', 'Water softener service', 'systems', true, 14, 'Refill salt, clean resin tank, verify settings and regeneration cycle are correct.', 'plumbing', 'semi_annual'),
('835fc06a-a99e-48f2-b7b8-59caa413befc', 'Sump pump inspection', 'systems', true, 15, 'Test pump operation by pouring water into pit, check float switch, inspect discharge line.', 'plumbing', 'semi_annual'),
('d8c3e08a-7904-462f-a0a6-c038ed8d2c1c', 'Well pump inspection', 'systems', true, 16, 'Inspect pressure tank, test pump output, check water quality, and inspect electrical connections.', 'plumbing', 'annual'),
('05ef5891-d49c-43d4-ae6e-677608fa0b40', 'Septic tank pumping', 'systems', true, 17, 'Pump every 3–5 years typical; inspect annually. Frequency depends on occupancy and tank size.', 'septic', 'annual'),
('0d19e11c-99ad-4f0d-adee-4c354bc99b44', 'Solar panel cleaning & inspection', 'systems', true, 18, 'Clean panels with soft brush and water, inspect mounting hardware and wiring, check inverter output.', 'solar', 'semi_annual'),
('384e6653-a856-4f5b-9c35-194a13d74d9c', 'EV charging station inspection', 'systems', true, 19, 'Test charge output at full load, inspect cable and connector for wear, check for firmware updates.', 'electrical', 'annual'),
('ee281f68-293c-47ff-8121-36d82deab9bf', 'Garage door service & lubrication', 'systems', true, 20, 'Lubricate rollers, hinges, and springs with lithium grease. Test auto-reverse safety function.', 'garage', 'annual'),
('97faad59-cdb1-4341-94b0-5dccfa013b9a', 'Elevator / stair lift service', 'systems', true, 21, 'Certified technician required. Inspect all safety systems, lubricate drive mechanism.', 'elevator', 'annual'),
('00be4f2d-f499-4597-b106-c0985e007dc7', 'Security camera system check', 'systems', true, 22, 'Verify all cameras are operational and recording. Clean lenses, check storage capacity, test motion alerts.', 'security', 'quarterly'),
('7fd52aaf-1711-4df1-a64d-2c59f6cc49f9', 'Sauna / steam room service', 'amenities', true, 23, 'Clean interior surfaces and benches, inspect heater and stones, check door seal and thermometer accuracy.', 'sauna', 'monthly')
ON CONFLICT (id) DO NOTHING;
