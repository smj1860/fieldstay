-- Progressive Asset Discovery master list: add asset_type enum values that
-- have no existing equivalent. Types that already exist (hvac, water_heater,
-- electrical_panel, pool_pump, hot_tub, refrigerator, oven_range, dishwasher,
-- microwave, washer, dryer, smart_lock, well_pump) are reused as-is — this
-- also means a property with an existing Asset Health record for one of
-- those types (make/model already populated) is correctly treated as
-- already-discovered.

ALTER TYPE public.asset_type ADD VALUE IF NOT EXISTS 'water_shutoff_valve';
ALTER TYPE public.asset_type ADD VALUE IF NOT EXISTS 'solar_inverter';
ALTER TYPE public.asset_type ADD VALUE IF NOT EXISTS 'whole_home_water_filter';
ALTER TYPE public.asset_type ADD VALUE IF NOT EXISTS 'heated_tile_system';
ALTER TYPE public.asset_type ADD VALUE IF NOT EXISTS 'range_hood_vent';
ALTER TYPE public.asset_type ADD VALUE IF NOT EXISTS 'coffee_station';
ALTER TYPE public.asset_type ADD VALUE IF NOT EXISTS 'toaster_oven';
ALTER TYPE public.asset_type ADD VALUE IF NOT EXISTS 'wifi_router';
ALTER TYPE public.asset_type ADD VALUE IF NOT EXISTS 'fire_extinguisher';
ALTER TYPE public.asset_type ADD VALUE IF NOT EXISTS 'thermostat';
