-- Guidebook v2: property hero photo + offer redemption logging

ALTER TABLE guidebook_property_configs
  ADD COLUMN IF NOT EXISTS hero_photo_storage_path TEXT;

COMMENT ON COLUMN guidebook_property_configs.hero_photo_storage_path IS
  'Optional storage path in the guidebook-property-photos bucket. Null renders the gradient fallback.';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'guidebook-property-photos',
  'guidebook-property-photos',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS guidebook_offer_redemptions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sponsor_id  UUID        NOT NULL REFERENCES guidebook_sponsors(id) ON DELETE CASCADE,
  booking_id  UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guidebook_redemptions_sponsor_opened
  ON guidebook_offer_redemptions (sponsor_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_guidebook_redemptions_org_opened
  ON guidebook_offer_redemptions (org_id, opened_at);

ALTER TABLE guidebook_offer_redemptions ENABLE ROW LEVEL SECURITY;

-- Org members read their own redemption analytics. Inserts are service-role
-- only (guest surface has no auth) — intentionally no INSERT/UPDATE/DELETE
-- policies for authenticated users. Role array matches the rest of the
-- guidebook_* policies (20260627043346_guidebook_foundation.sql) — 'owner'
-- always passes is_org_member() regardless of the array contents.
CREATE POLICY "guidebook_offer_redemptions_select"
  ON guidebook_offer_redemptions FOR SELECT
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
