-- ============================================================================
-- seasonal_profile: scalar -> ARRAY, and six enum values -> five
--
-- Two corrections to the column added 2026-09-12, made together because they
-- touch the same column and doing the enum half later would cost a second
-- migration once real data exists.
--
-- 1. A SCALAR forced a false either/or. A property can genuinely carry more
--    than one peak season: a Gatlinburg cabin has real summer national-park
--    tourism AND a real, arguably bigger, fall-foliage run. One value could
--    only ever describe half of that.
--
-- 2. `summer_lake` and `coastal_summer` were never actually different.
--    Checked against the scoring code before removing them: identical windows
--    (05-25..09-05), identical weight (0.15), identical spring-break
--    eligibility. The split was cosmetic and never affected behaviour. They
--    collapse into one `summer_vacation`, which ALSO covers summer-peaked
--    mountain markets that previously had no value at all — do not add a
--    third summer type; that redundancy is what this removes.
--
-- SAFE AS A STRAIGHT REPLACEMENT, not a data migration: verified immediately
-- before applying that all 29 live properties held NULL. Nothing has ever been
-- assigned, so there is nothing to preserve. If that is ever untrue again,
-- this file is NOT the template to copy — a backfill-aware migration is.
-- ============================================================================

ALTER TABLE public.properties DROP COLUMN seasonal_profile;
DROP TYPE seasonal_profile;

CREATE TYPE seasonal_profile AS ENUM (
  'none',
  'summer_vacation',
  'fall_foliage',
  'ski',
  'year_round_urban'
);

-- DEFAULT '{}' rather than NULL. With an array the "nobody has said" state is
-- the EMPTY array, which keeps the distinction the nullable scalar existed to
-- preserve: empty = derive from the ZIP, ['none'] = a human deliberately
-- saying this market has no seasonality. Without that gap the derivation
-- would silently overrule a person every night.
ALTER TABLE public.properties
  ADD COLUMN seasonal_profile seasonal_profile[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.properties.seasonal_profile IS
  'OVERRIDE ONLY, and an ARRAY: a property can genuinely carry more than one peak season (a Gatlinburg cabin has both real summer park tourism and a real fall-foliage run, and a scalar forced a false either/or). EMPTY — the normal case — means derive the market profiles from the ZIP via lib/scoring/seasonal-market.ts. A non-empty value is a deliberate human correction and wins; [none] is a deliberate "no seasonality" and is distinct from empty. Fixed MM-DD windows — a rough internal ops proxy, never a customer-facing precision claim.';
