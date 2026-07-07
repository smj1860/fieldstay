
-- Add missing checklist items to the existing seed org
-- Safe: skips any task that already exists for that org
INSERT INTO org_master_checklist_items (org_id, section, task, sort_order, source)
SELECT
  existing.org_id,
  v.section,
  v.task,
  v.sort_order,
  existing.source
FROM (
  SELECT DISTINCT org_id, source
  FROM org_master_checklist_items
  WHERE section = 'Final Checks'
  LIMIT 1
) existing
CROSS JOIN (VALUES
  -- Final Checks
  ('Final Checks', 'Verify smart lock code is set correctly for next guest',          7),
  ('Final Checks', 'Confirm WiFi is working — connect and test on a device',          8),
  ('Final Checks', 'Verify welcome amenities are staged and in place',                9),
  ('Final Checks', 'Quick-test smoke and CO detector in each room',                  10),
  ('Final Checks', 'Check all remote controls have working batteries',               11),
  ('Final Checks', 'Water any plants or indoor greenery',                            12),
  ('Final Checks', 'Confirm all outdoor spaces are clean and staged',               13),

  -- Living Areas
  ('Living Areas', 'Test TV and streaming devices — confirm they power on',          10),
  ('Living Areas', 'Check under and behind furniture for left items',               11),
  ('Living Areas', 'Wipe visible baseboards and trim',                              12),

  -- Kitchen
  ('Kitchen', 'Test garbage disposal',                                              12),
  ('Kitchen', 'Confirm coffee maker and small appliances are functioning',          13),
  ('Kitchen', 'Verify refrigerator temperature is set correctly',                   14),

  -- Bathrooms
  ('Bathrooms', 'Flush toilet — confirm no running water or leaking',               10),
  ('Bathrooms', 'Inspect for any mold or mildew — treat if found',                 11),

  -- Outdoor / Entry
  ('Outdoor / Entry', 'Check pool water level and clarity if applicable',            6),
  ('Outdoor / Entry', 'Check hot tub temperature and water condition if applicable', 7),
  ('Outdoor / Entry', 'Verify propane level or charcoal supply in grill',            8),
  ('Outdoor / Entry', 'Check outdoor lighting is functioning',                       9),
  ('Outdoor / Entry', 'Confirm fire pit or fireplace area is clean if applicable',  10)
) AS v(section, task, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM org_master_checklist_items c
  WHERE c.task = v.task AND c.org_id = existing.org_id
);
