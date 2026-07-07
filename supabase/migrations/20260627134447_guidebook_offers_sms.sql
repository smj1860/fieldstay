-- offer fields on guidebook_sponsors
ALTER TABLE guidebook_sponsors
  ADD COLUMN IF NOT EXISTS offer_type TEXT NOT NULL DEFAULT 'none' CHECK (
    offer_type IN ('percentage', 'fixed_amount', 'item', 'custom', 'none')
  );

ALTER TABLE guidebook_sponsors
  ADD COLUMN IF NOT EXISTS offer_value NUMERIC(10,2);

ALTER TABLE guidebook_sponsors
  ADD COLUMN IF NOT EXISTS offer_item TEXT;

CREATE TABLE IF NOT EXISTS guidebook_guest_sms_optins (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id            UUID         NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  booking_id             UUID         NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  phone_e164             TEXT         NOT NULL,
  is_active              BOOLEAN      NOT NULL DEFAULT true,
  door_code_sent_at      TIMESTAMPTZ,
  last_morning_sms_date  DATE,
  last_evening_sms_date  DATE,
  opted_in_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  opted_out_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(booking_id)
);

ALTER TABLE guidebook_guest_sms_optins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gso_org_members_select" ON guidebook_guest_sms_optins;
DROP POLICY IF EXISTS "gso_org_members_manage" ON guidebook_guest_sms_optins;

CREATE POLICY "gso_org_members_select" ON guidebook_guest_sms_optins
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "gso_org_members_manage" ON guidebook_guest_sms_optins
  FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE INDEX IF NOT EXISTS guidebook_guest_sms_optins_org_id_idx
  ON guidebook_guest_sms_optins(org_id);

CREATE INDEX IF NOT EXISTS guidebook_guest_sms_optins_booking_id_idx
  ON guidebook_guest_sms_optins(booking_id);

CREATE INDEX IF NOT EXISTS guidebook_guest_sms_optins_phone_idx
  ON guidebook_guest_sms_optins(phone_e164)
  WHERE is_active = true;
