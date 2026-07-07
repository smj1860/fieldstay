CREATE TABLE property_owners (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name                text NOT NULL,
  email               text,
  phone               text,
  revenue_share_pct   numeric(5,2),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_property_owners_property_id ON property_owners(property_id);
CREATE INDEX idx_property_owners_org_id ON property_owners(org_id);

CREATE TABLE owner_portal_tokens (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_owner_id uuid NOT NULL REFERENCES property_owners(id) ON DELETE CASCADE,
  token             uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  expires_at        timestamptz,
  last_accessed_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_owner_portal_tokens_token ON owner_portal_tokens(token);

CREATE TABLE ical_feeds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              text NOT NULL,
  url               text NOT NULL,
  source            ical_source DEFAULT 'other',
  last_synced_at    timestamptz,
  last_sync_status  sync_status DEFAULT 'pending',
  last_sync_error   text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ical_feeds_property_id ON ical_feeds(property_id);
CREATE INDEX idx_ical_feeds_org_id ON ical_feeds(org_id);
CREATE TRIGGER ical_feeds_updated_at BEFORE UPDATE ON ical_feeds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ical_feed_id    uuid REFERENCES ical_feeds(id) ON DELETE SET NULL,
  ical_uid        text,
  guest_name      text,
  guest_email     text,
  checkin_date    date NOT NULL,
  checkout_date   date NOT NULL,
  checkin_time    time,
  checkout_time   time,
  source          booking_source DEFAULT 'other',
  status          booking_status NOT NULL DEFAULT 'confirmed',
  notes           text,
  raw_ical_data   jsonb,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(ical_feed_id, ical_uid)
);
CREATE INDEX idx_bookings_property_id ON bookings(property_id);
CREATE INDEX idx_bookings_org_id ON bookings(org_id);
CREATE INDEX idx_bookings_checkin ON bookings(checkin_date);
CREATE INDEX idx_bookings_checkout ON bookings(checkout_date);
CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
