-- ============================================================================
-- property_defaults_report(): structural-enforcement DB-side half for
-- lib/properties/defaults.ts's withPropertyDefaults().
--
-- withPropertyDefaults() hand-copies ten `properties` column DEFAULTs as JS
-- literals (bedrooms ?? 1, same_day_premium_pct ?? 25.0, etc.), justified by
-- its own header comment as "Verified against information_schema.columns.
-- column_default" — a point-in-time manual check, not an enforced invariant.
-- Unlike lib/db-enums.ts (generated from the live schema) or types/database.ts
-- (guarded by check-type-drift.mjs), nothing re-checked these numbers against
-- the live column DEFAULTs. A future migration changing one of them (a
-- pricing-policy change to same_day_premium_pct's DEFAULT, say) would leave
-- this file silently returning the OLD value for any row genuinely written
-- with NULL by a non-app path (a backfill, an integration sync, the Supabase
-- dashboard) — showing a PM or guest a number Postgres itself would no longer
-- choose, with nothing anywhere signalling the two had diverged.
--
-- Rather than diff the raw `column_default` TEXT (which varies in shape —
-- `1`, `1.0`, `'15:00:00'::time without time zone`, `'house'::property_type`
-- — and would need its own fragile parser to compare against a JS literal),
-- this function EVALUATES each column's default expression and returns the
-- actual value it produces, exactly the way scripts/check-property-defaults-
-- drift.mjs's caller wants it: something a plain `===`-shaped comparison
-- against the JS literal can check directly.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.property_defaults_report()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  col    text;
  expr   text;
  val    jsonb;
  result jsonb := '{}'::jsonb;
  -- The exact ten columns withPropertyDefaults() resolves. Keep this list in
  -- lockstep with that function's own set.
  cols   text[] := ARRAY[
    'property_type', 'bedrooms', 'bathrooms', 'max_guests', 'avg_stay_length',
    'avg_turnovers_per_month', 'checkin_time', 'checkout_time', 'same_day_premium_pct'
  ];
BEGIN
  FOREACH col IN ARRAY cols LOOP
    SELECT c.column_default INTO expr
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'properties' AND c.column_name = col;

    IF expr IS NOT NULL THEN
      EXECUTE format('SELECT to_jsonb(%s)', expr) INTO val;
      result := result || jsonb_build_object(col, val);
    END IF;
  END LOOP;

  RETURN result;
END;
$$;

-- Introspection-only, service-role-only, same posture as db_type_shape_report().
REVOKE EXECUTE ON FUNCTION public.property_defaults_report() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.property_defaults_report() TO service_role;
