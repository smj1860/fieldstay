-- ─────────────────────────────────────────────────────────────
-- TABLE: guidebook_configurations (one row per org, auto-created)
-- Tracks whether the guidebook is currently active for an org.
-- Row is upserted by Inngest when the sponsor wall threshold is reached.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guidebook_configurations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  is_active  BOOLEAN     NOT NULL DEFAULT false,
  grace_period_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id)
);

ALTER TABLE guidebook_configurations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gc_org_members_select" ON guidebook_configurations;
DROP POLICY IF EXISTS "gc_org_members_update" ON guidebook_configurations;

CREATE POLICY "gc_org_members_select" ON guidebook_configurations
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "gc_org_members_update" ON guidebook_configurations
  FOR UPDATE USING (org_id IN (SELECT get_user_org_ids()));

-- ─────────────────────────────────────────────────────────────
-- TABLE: guidebook_sponsors (up to 6 slots per org)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guidebook_sponsors (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slot_number            INTEGER      NOT NULL CHECK (slot_number BETWEEN 1 AND 6),
  business_name          TEXT         NOT NULL,
  business_description   TEXT,
  business_phone         TEXT,
  business_website       TEXT,
  custom_offer_text      TEXT,
  featured_item          TEXT,
  address                TEXT,
  lat                    NUMERIC(10,7),
  lng                    NUMERIC(10,7),
  slot_type              TEXT         NOT NULL CHECK (
                           slot_type IN (
                             'morning_brew',
                             'dinner_pints',
                             'rainy_day',
                             'outdoor_adventure',
                             'general',
                             'other'
                           )
                         ),
  slot_context           TEXT,        -- write-in when slot_type = 'other'
  media_kit_token        UUID         NOT NULL DEFAULT gen_random_uuid(),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  checkout_session_id    TEXT,
  status                 TEXT         NOT NULL DEFAULT 'pending' CHECK (
                           status IN ('pending', 'active', 'payment_failed', 'cancelled')
                         ),
  activated_at           TIMESTAMPTZ,
  deactivated_at         TIMESTAMPTZ,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, slot_number)
);

ALTER TABLE guidebook_sponsors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gs_org_members_select" ON guidebook_sponsors;
DROP POLICY IF EXISTS "gs_org_members_insert" ON guidebook_sponsors;
DROP POLICY IF EXISTS "gs_org_members_update" ON guidebook_sponsors;
DROP POLICY IF EXISTS "gs_org_members_delete" ON guidebook_sponsors;

CREATE POLICY "gs_org_members_select" ON guidebook_sponsors
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "gs_org_members_insert" ON guidebook_sponsors
  FOR INSERT WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY "gs_org_members_update" ON guidebook_sponsors
  FOR UPDATE USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY "gs_org_members_delete" ON guidebook_sponsors
  FOR DELETE USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ─────────────────────────────────────────────────────────────
-- TABLE: guidebook_property_configs (per-property guest content)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guidebook_property_configs (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id            UUID         NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  slug                   TEXT         NOT NULL UNIQUE,
  check_in_instructions  TEXT,
  check_out_instructions TEXT,
  wifi_network           TEXT,
  wifi_password          TEXT,        -- intentionally plaintext: guest-visible by design
  house_rules            TEXT,
  is_published           BOOLEAN      NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, property_id)
);

ALTER TABLE guidebook_property_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gpc_org_members_select" ON guidebook_property_configs;
DROP POLICY IF EXISTS "gpc_org_members_manage" ON guidebook_property_configs;

CREATE POLICY "gpc_org_members_select" ON guidebook_property_configs
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "gpc_org_members_manage" ON guidebook_property_configs
  FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ─────────────────────────────────────────────────────────────
-- COLUMN: bookings.guidebook_token (per-booking guest URLs)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guidebook_token UUID DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS bookings_guidebook_token_idx
  ON bookings(guidebook_token);

-- ─────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS guidebook_sponsors_org_id_idx
  ON guidebook_sponsors(org_id);

CREATE INDEX IF NOT EXISTS guidebook_sponsors_status_idx
  ON guidebook_sponsors(status);

CREATE INDEX IF NOT EXISTS guidebook_sponsors_media_kit_token_idx
  ON guidebook_sponsors(media_kit_token);

CREATE INDEX IF NOT EXISTS guidebook_configurations_org_id_idx
  ON guidebook_configurations(org_id);

CREATE INDEX IF NOT EXISTS guidebook_configurations_grace_period_idx
  ON guidebook_configurations(grace_period_ends_at)
  WHERE grace_period_ends_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS guidebook_property_configs_slug_idx
  ON guidebook_property_configs(slug);

CREATE INDEX IF NOT EXISTS guidebook_property_configs_property_id_idx
  ON guidebook_property_configs(property_id);
