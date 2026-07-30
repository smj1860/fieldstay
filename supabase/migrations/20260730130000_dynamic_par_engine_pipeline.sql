-- Dynamic PAR engine, pass 2 — idempotent consumption sample log + carry the
-- pass-1 par config columns through clone_inventory_from_property.

-- ── Raw consumption samples ─────────────────────────────────────────────────
-- One row per (count source, item). The UNIQUE constraint is the idempotency
-- guard: an Inngest retry or a double-fired event re-inserting the same
-- (source_type, source_id, inventory_item_id) hits ON CONFLICT DO NOTHING and
-- the derived rolling average stays correct. Stats in
-- inventory_consumption_stats are always recomputed FROM these rows (bounded
-- window), never incrementally mutated, so replays are safe.

CREATE TABLE IF NOT EXISTS public.inventory_consumption_samples (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id            uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  inventory_item_id      uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  source_type            text NOT NULL CHECK (source_type IN ('count', 'count_draft')),
  source_id              uuid NOT NULL,
  consumed_qty           numeric NOT NULL CHECK (consumed_qty >= 0),
  rate_per_guest_night   numeric NOT NULL CHECK (rate_per_guest_night >= 0),
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, inventory_item_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_consumption_samples_prop_item
  ON public.inventory_consumption_samples (property_id, inventory_item_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_consumption_samples_org_id
  ON public.inventory_consumption_samples (org_id);

ALTER TABLE public.inventory_consumption_samples ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.inventory_consumption_samples TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory_consumption_samples TO service_role;

-- Read-only for org members (mirrors inventory_consumption_stats): writes are
-- service-role Inngest steps only.
CREATE POLICY "inventory_consumption_samples_select"
  ON public.inventory_consumption_samples FOR SELECT
  USING (org_id IN (SELECT org_id FROM public.organization_members WHERE user_id = auth.uid()));

-- ── clone_inventory_from_property: carry par config to the target ───────────
-- Full re-create preserving the body from
-- 20260722005345_atomic_template_item_replace_pin_search_path.sql exactly,
-- with ONLY the INSERT column list / SELECT list extended.

CREATE OR REPLACE FUNCTION public.clone_inventory_from_property(p_org_id uuid, p_source_property_id uuid, p_target_property_id uuid)
 RETURNS TABLE(added integer, skipped integer, source_count integer)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_count integer;
  v_added        integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('clone_inventory_from_property'), hashtext(p_target_property_id::text));

  IF NOT EXISTS (
    SELECT 1 FROM public.properties
    WHERE id = p_target_property_id AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Target property not found in this organization';
  END IF;

  SELECT count(*) INTO v_source_count
  FROM public.inventory_items
  WHERE property_id = p_source_property_id
    AND org_id = p_org_id
    AND is_active = true;

  INSERT INTO public.inventory_items (
    property_id, org_id, catalog_item_id, name, category, unit,
    par_level, current_quantity, low_stock_threshold_pct, preferred_brand, is_active,
    par_mode, smart_group, base_qty, auto_adjust
  )
  SELECT
    p_target_property_id, p_org_id, s.catalog_item_id, s.name, s.category, s.unit,
    s.par_level, 0, COALESCE(s.low_stock_threshold_pct, 20), s.preferred_brand, true,
    s.par_mode, s.smart_group, s.base_qty, s.auto_adjust
  FROM public.inventory_items s
  WHERE s.property_id = p_source_property_id
    AND s.org_id = p_org_id
    AND s.is_active = true
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_items t
      WHERE t.property_id = p_target_property_id
        AND t.org_id = p_org_id
        AND t.is_active = true
        AND lower(t.name) = lower(s.name)
    );

  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN QUERY SELECT v_added, GREATEST(v_source_count - v_added, 0), v_source_count;
END;
$function$;
