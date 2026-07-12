-- Seed asset_type_standards rows for the three new types added in
-- 20260712130000_add_kitchen_asset_types_enum.sql. age_weight/condition_weight
-- default to 60/40 at the column level, matching every other asset type.

INSERT INTO asset_type_standards
  (asset_type, display_name, lifespan_min_years, lifespan_max_years,
   avg_replacement_cost_low, avg_replacement_cost_high, macrs_class_default,
   vendor_specialty_default, notes)
VALUES
  ('ice_maker',        'Ice Maker',         5,  8,   300, 2000, '5_year', 'general',  'Standalone undercounter/freestanding icemaker — not a fridge-integrated dispenser'),
  ('garbage_disposal', 'Garbage Disposal', 10, 12,   150,  500, '5_year', 'plumbing', 'Under-sink disposal unit'),
  ('trash_compactor',  'Trash Compactor',  10, 15,   400, 1200, '5_year', 'general',  NULL)
ON CONFLICT (asset_type) DO NOTHING;
