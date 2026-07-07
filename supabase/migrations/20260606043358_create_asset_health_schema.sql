
-- ================================================================
-- ASSET HEALTH MODULE — Full Schema
-- Pillar 1: Asset Ledger (Physical Health)
-- Pillar 2: Vendor Compliance Vault (Risk Management)
-- Pillar 3: CapEx & Depreciation Hub (Financial Reporting)
-- ================================================================

-- ── ENUMS ────────────────────────────────────────────────────────

CREATE TYPE asset_type AS ENUM (
  'hvac',
  'water_heater',
  'roof',
  'refrigerator',
  'washer',
  'dryer',
  'dishwasher',
  'microwave',
  'oven_range',
  'pool_pump',
  'hot_tub',
  'garage_door',
  'smart_lock',
  'deck_structure',
  'electrical_panel',
  'plumbing_system',
  'septic_system',
  'well_pump',
  'generator',
  'solar_system',
  'other'
);

CREATE TYPE macrs_class AS ENUM (
  '5_year',     -- appliances, carpets, certain personal property
  '15_year',    -- land improvements: fences, landscaping, parking
  '27_5_year',  -- residential rental property (the building)
  '39_year',    -- nonresidential real property
  'section_179' -- immediate full expensing election
);

CREATE TYPE compliance_doc_type AS ENUM (
  'coi',                  -- certificate of insurance (general liability)
  'workers_comp',         -- workers compensation insurance
  'business_license',     -- state/local business license
  'contractor_license',   -- trade-specific license (electrical, plumbing, HVAC)
  'bonding',              -- surety bond
  'other'
);

-- ── PILLAR 1: Asset Ledger ────────────────────────────────────────

-- Industry standard lifespans + replacement costs (seed data table)
CREATE TABLE IF NOT EXISTS asset_type_standards (
  asset_type                  asset_type  PRIMARY KEY,
  display_name                TEXT        NOT NULL,
  lifespan_min_years          SMALLINT    NOT NULL,
  lifespan_max_years          SMALLINT    NOT NULL,
  avg_replacement_cost_low    INTEGER,    -- in USD
  avg_replacement_cost_high   INTEGER,    -- in USD
  macrs_class_default         macrs_class NOT NULL DEFAULT '5_year',
  vendor_specialty_default    vendor_specialty,
  notes                       TEXT
);

-- Seed industry standard lifespans
INSERT INTO asset_type_standards VALUES
  ('hvac',            'HVAC System',              15, 20, 3500,  8000,  '5_year',      'hvac',         'Central AC + furnace combined system'),
  ('water_heater',    'Water Heater (Tank)',        8, 12, 600,   1500,  '5_year',      'plumbing',     'Traditional tank-style. Tankless = 20yr'),
  ('roof',            'Roof',                      20, 25, 8000,  20000, '27_5_year',   'roofing',      'Asphalt shingle. Metal = 40-70yr'),
  ('refrigerator',    'Refrigerator',              10, 15, 800,   2500,  '5_year',      'general',      NULL),
  ('washer',          'Washer',                    10, 13, 600,   1400,  '5_year',      'general',      NULL),
  ('dryer',           'Dryer',                     10, 13, 500,   1200,  '5_year',      'general',      NULL),
  ('dishwasher',      'Dishwasher',                 9, 12, 500,   1500,  '5_year',      'general',      NULL),
  ('microwave',       'Microwave',                  7,  9, 150,    500,  '5_year',      'general',      'Built-in OTR units last longer than countertop'),
  ('oven_range',      'Oven / Range',              13, 15, 700,   3000,  '5_year',      'general',      NULL),
  ('pool_pump',       'Pool Pump',                  8, 12, 600,   1800,  '5_year',      'pool',         NULL),
  ('hot_tub',         'Hot Tub',                    5, 20, 3000, 15000,  '5_year',      'pool',         'Wide range based on brand and maintenance quality'),
  ('garage_door',     'Garage Door Opener',        10, 15, 300,    700,  '5_year',      'general',      NULL),
  ('smart_lock',      'Smart Lock',                 5, 10, 150,    500,  '5_year',      'general',      NULL),
  ('deck_structure',  'Deck / Structure',          15, 25, 5000, 20000,  '15_year',     'general',      'Treated wood. Composite = 25-30yr'),
  ('electrical_panel','Electrical Panel',          25, 40, 1500,  4000,  '27_5_year',   'electrical',   'Older panels (Federal Pacific, Zinsco) should be replaced'),
  ('plumbing_system', 'Plumbing System',           40, 70, 2000, 15000,  '27_5_year',   'plumbing',     'Copper/PVC. Galvanized = 20-50yr'),
  ('septic_system',   'Septic System',             20, 40, 3000, 10000,  '15_year',     'plumbing',     'Tank only. Drain field varies widely'),
  ('well_pump',       'Well Pump',                  8, 15, 800,   2500,  '5_year',      'plumbing',     'Submersible pump'),
  ('generator',       'Generator',                 15, 20, 2000, 10000,  '5_year',      'electrical',   'Standby generator'),
  ('solar_system',    'Solar System',              25, 30, 15000,35000,  '5_year',      'electrical',   'Panels. Inverter may need replacement at 10-15yr'),
  ('other',           'Other Asset',               10, 20, NULL,  NULL,  '5_year',      NULL,           NULL)
ON CONFLICT (asset_type) DO NOTHING;

-- The main asset record
CREATE TABLE IF NOT EXISTS property_assets (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID          NOT NULL,
  property_id               UUID          NOT NULL REFERENCES properties(id)   ON DELETE CASCADE,
  name                      TEXT          NOT NULL,         -- "Main HVAC Unit", "Master Bath Water Heater"
  asset_type                asset_type    NOT NULL,
  make                      TEXT,
  model                     TEXT,
  serial_number             TEXT,
  installation_date         DATE,                           -- when it was installed at property
  manufacture_date          DATE,                           -- from nameplate (may differ)
  purchase_price            NUMERIC(12,2),                  -- what PM paid for it
  estimated_replacement_cost NUMERIC(12,2),                 -- current replacement estimate
  expected_lifespan_years   SMALLINT,                       -- overrides asset_type_standards if set
  warranty_expiry_date      DATE,
  warranty_provider         TEXT,
  warranty_notes            TEXT,
  -- CapEx / Tax fields
  placed_in_service_date    DATE,                           -- tax: may differ from installation_date
  macrs_class               macrs_class   DEFAULT '5_year',
  depreciation_method       TEXT          DEFAULT 'macrs'
    CHECK (depreciation_method IN ('macrs', 'section_179', 'straight_line')),
  salvage_value             NUMERIC(12,2) DEFAULT 0,
  -- Health score cache (recomputed by Inngest, not stored permanently)
  health_score              SMALLINT      CHECK (health_score BETWEEN 0 AND 100),
  health_score_updated_at   TIMESTAMPTZ,
  -- Status
  is_active                 BOOLEAN       NOT NULL DEFAULT true,
  replaced_by_asset_id      UUID          REFERENCES property_assets(id),
  notes                     TEXT,
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_property_assets_property    ON property_assets(property_id, asset_type);
CREATE INDEX idx_property_assets_org         ON property_assets(org_id, health_score);
CREATE INDEX idx_property_assets_warranty    ON property_assets(warranty_expiry_date)
  WHERE warranty_expiry_date IS NOT NULL AND is_active = true;

ALTER TABLE property_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "assets_select"
  ON property_assets FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "assets_manage"
  ON property_assets FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- Link work orders to assets (many WOs can relate to one asset over its life)
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS asset_id UUID REFERENCES property_assets(id) ON DELETE SET NULL;

COMMENT ON COLUMN work_orders.asset_id IS
  'Links this WO to a tracked capital asset. Used for repair frequency
   and total repair cost calculations in the Asset Health Score.';

-- ── PILLAR 2: Vendor Compliance Vault ────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_compliance_documents (
  id                UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID              NOT NULL,
  vendor_id         UUID              NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  document_type     compliance_doc_type NOT NULL,
  document_name     TEXT              NOT NULL,
  policy_number     TEXT,
  issuer_name       TEXT,
  effective_date    DATE,
  expiry_date       DATE,
  coverage_amount   NUMERIC(12,2),    -- for COI: general liability limit in USD
  document_url      TEXT,             -- Supabase Storage path
  is_verified       BOOLEAN           NOT NULL DEFAULT false,
  verification_notes TEXT,
  is_active         BOOLEAN           NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ       NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ       NOT NULL DEFAULT now()
);

CREATE INDEX idx_vendor_compliance_vendor
  ON vendor_compliance_documents(vendor_id, document_type, expiry_date);

CREATE INDEX idx_vendor_compliance_expiring
  ON vendor_compliance_documents(expiry_date, org_id)
  WHERE is_active = true AND expiry_date IS NOT NULL;

ALTER TABLE vendor_compliance_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "compliance_docs_select"
  ON vendor_compliance_documents FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "compliance_docs_manage"
  ON vendor_compliance_documents FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- Computed view: current compliance status per vendor
-- Used by the WO assignment compliance gate
CREATE OR REPLACE VIEW vendor_compliance_status AS
SELECT
  v.id                                              AS vendor_id,
  v.org_id,
  v.name                                            AS vendor_name,
  COUNT(d.id) FILTER (
    WHERE d.expiry_date >= CURRENT_DATE
      AND d.is_active = true
  )                                                 AS active_doc_count,
  COUNT(d.id) FILTER (
    WHERE d.expiry_date < CURRENT_DATE
      AND d.is_active = true
  )                                                 AS expired_doc_count,
  COUNT(d.id) FILTER (
    WHERE d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
      AND d.is_active = true
  )                                                 AS expiring_soon_count,
  MIN(d.expiry_date) FILTER (
    WHERE d.expiry_date < CURRENT_DATE
      AND d.is_active = true
  )                                                 AS earliest_expired_date,
  CASE
    WHEN COUNT(d.id) = 0                            THEN 'no_documents'
    WHEN COUNT(d.id) FILTER (
      WHERE d.expiry_date < CURRENT_DATE
        AND d.is_active = true
    ) > 0                                           THEN 'expired'
    WHEN COUNT(d.id) FILTER (
      WHERE d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
        AND d.is_active = true
    ) > 0                                           THEN 'expiring_soon'
    ELSE                                                 'compliant'
  END                                               AS compliance_status
FROM vendors v
LEFT JOIN vendor_compliance_documents d ON d.vendor_id = v.id
GROUP BY v.id, v.org_id, v.name;

-- ── PILLAR 3: CapEx & Depreciation Hub ───────────────────────────

-- Annual depreciation entries (one row per asset per tax year)
CREATE TABLE IF NOT EXISTS asset_depreciation_entries (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID        NOT NULL,
  asset_id                    UUID        NOT NULL REFERENCES property_assets(id) ON DELETE CASCADE,
  tax_year                    SMALLINT    NOT NULL,
  macrs_class                 macrs_class NOT NULL,
  cost_basis                  NUMERIC(12,2) NOT NULL,
  prior_cumulative_depreciation NUMERIC(12,2) NOT NULL DEFAULT 0,
  current_year_depreciation   NUMERIC(12,2) NOT NULL,
  ending_adjusted_basis       NUMERIC(12,2) NOT NULL,
  depreciation_rate           NUMERIC(6,4), -- the MACRS percentage applied this year
  notes                       TEXT,
  generated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (asset_id, tax_year)  -- one entry per asset per year
);

CREATE INDEX idx_depreciation_org_year
  ON asset_depreciation_entries(org_id, tax_year);

ALTER TABLE asset_depreciation_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "depreciation_select"
  ON asset_depreciation_entries FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "depreciation_manage"
  ON asset_depreciation_entries FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
