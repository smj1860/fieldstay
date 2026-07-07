-- Template header
CREATE TABLE IF NOT EXISTS maintenance_schedule_templates (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT,
  is_system   BOOLEAN     NOT NULL DEFAULT false, -- true = FieldStay seed template
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE maintenance_schedule_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mst_select" ON maintenance_schedule_templates FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids())
         OR is_system = true);

CREATE POLICY "mst_manage" ON maintenance_schedule_templates FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- Template line items
CREATE TABLE IF NOT EXISTS maintenance_schedule_template_items (
  id                    UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id           UUID              NOT NULL
    REFERENCES maintenance_schedule_templates(id) ON DELETE CASCADE,
  name                  TEXT              NOT NULL,
  description           TEXT,
  schedule_frequency    schedule_frequency NOT NULL,
  vendor_specialty_hint vendor_specialty  DEFAULT NULL,
  estimated_cost        NUMERIC(10,2),
  is_optional_flag      TEXT              DEFAULT NULL,
  -- Use this to mark items that only apply to certain property types:
  -- 'pool', 'hot_tub', 'fireplace', 'chimney', 'generator', 'septic', 'well'
  sort_order            INTEGER           NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ       NOT NULL DEFAULT now()
);

ALTER TABLE maintenance_schedule_template_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "msti_select" ON maintenance_schedule_template_items FOR SELECT
  USING (
    template_id IN (
      SELECT id FROM maintenance_schedule_templates
      WHERE org_id IN (SELECT get_user_org_ids()) OR is_system = true
    )
  );

CREATE POLICY "msti_manage" ON maintenance_schedule_template_items FOR ALL
  USING (
    template_id IN (
      SELECT id FROM maintenance_schedule_templates
      WHERE is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
        AND is_system = false
    )
  )
  WITH CHECK (
    template_id IN (
      SELECT id FROM maintenance_schedule_templates
      WHERE is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
        AND is_system = false
    )
  );

-- Insert system template
INSERT INTO maintenance_schedule_templates (id, org_id, name, description, is_system)
VALUES (
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '00000000-0000-0000-0000-000000000000',
  'FieldStay STR Standard',
  'Comprehensive 36-item maintenance schedule for short-term rental properties. Covers HVAC, safety, plumbing, exterior, pest control, appliances, and seasonal tasks. Remove optional items that do not apply to your property.',
  true
)
ON CONFLICT (id) DO NOTHING;

-- Insert all 36 items
INSERT INTO maintenance_schedule_template_items
  (template_id, name, schedule_frequency, vendor_specialty_hint, is_optional_flag, sort_order)
VALUES
-- HVAC & Air Quality
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'HVAC filter replacement',              'quarterly',   'hvac',          null,        1),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Duct cleaning inspection',             'annual',      'hvac',          null,        2),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Ceiling fan blade cleaning',           'quarterly',   null,            null,        3),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Portable AC unit service',             'annual',      'hvac',          null,        4),
-- Safety & Code Compliance
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Smoke detector test and battery check','monthly',     null,            null,        5),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Carbon monoxide detector test',        'monthly',     null,            null,        6),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Fire extinguisher inspection',         'annual',      null,            null,        7),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Emergency exit and egress inspection', 'monthly',     null,            null,        8),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Dryer vent cleaning',                  'annual',      null,            null,        9),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Electrical panel inspection',          'annual',      'electrical',    null,        10),
-- Plumbing & Water
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Water heater inspection and sediment flush', 'annual','plumbing',     null,        11),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Water heater anode rod check',         'annual',      'plumbing',      null,        12),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Caulking inspection — tubs and showers','quarterly',  null,            null,        13),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Grout inspection and sealing',         'annual',      null,            null,        14),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Sump pump test',                       'semi_annual', 'plumbing',      null,        15),
-- Exterior & Structure
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Gutter cleaning and flush',            'semi_annual', null,            null,        16),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Roof inspection',                      'annual',      'roofing',       null,        17),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Exterior pressure wash',               'annual',      null,            null,        18),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Deck and patio inspection and sealing','annual',      null,            null,        19),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Exterior caulking and weatherstripping','annual',     null,            null,        20),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Garage door lubrication and safety test','semi_annual',null,           null,        21),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Chimney sweep and inspection',         'annual',      null,            'chimney',   22),
-- Pest & Landscape
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Pest control treatment',               'quarterly',   'pest_control',  null,        23),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Termite inspection',                   'annual',      'pest_control',  null,        24),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Landscape and lawn maintenance review','annual',      'landscaping',   null,        25),
-- Interior Appliances & Systems
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Refrigerator coil cleaning',           'annual',      null,            null,        26),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Dishwasher cleaning and drain check',  'monthly',     null,            null,        27),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Oven and range deep clean',            'quarterly',   null,            null,        28),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Garbage disposal cleaning',            'monthly',     null,            null,        29),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Washer drum cleaning',                 'monthly',     null,            null,        30),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Range hood filter cleaning',           'quarterly',   null,            null,        31),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Mattress rotation',                    'semi_annual', null,            null,        32),
-- Seasonal
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Winterize outdoor faucets and hose bibs','annual',   'plumbing',      null,        33),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'AC and cooling system startup check',  'annual',      'hvac',          null,        34),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Pool and hot tub opening service',     'annual',      'pool',          'pool',      35),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Pool and hot tub winterization',       'annual',      'pool',          'pool',      36)
ON CONFLICT DO NOTHING;
