
-- GUEST MESSAGE TEMPLATES
CREATE TABLE guest_message_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  trigger       message_trigger NOT NULL,
  name          text NOT NULL,
  subject       text NOT NULL,
  body          text NOT NULL,
  days_before   integer DEFAULT 1,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_guest_templates_property_id ON guest_message_templates(property_id);
CREATE INDEX idx_guest_templates_org_id      ON guest_message_templates(org_id);

CREATE TRIGGER guest_message_templates_updated_at
  BEFORE UPDATE ON guest_message_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE guest_messages_sent (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  booking_id        uuid REFERENCES bookings(id) ON DELETE SET NULL,
  template_id       uuid REFERENCES guest_message_templates(id) ON DELETE SET NULL,
  trigger           message_trigger NOT NULL,
  recipient_name    text,
  recipient_email   text NOT NULL,
  subject           text NOT NULL,
  body_rendered     text NOT NULL,
  sent_at           timestamptz NOT NULL DEFAULT NOW(),
  resend_message_id text,
  status            message_status NOT NULL DEFAULT 'sent',
  created_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_guest_messages_sent_property_id ON guest_messages_sent(property_id);
CREATE INDEX idx_guest_messages_sent_booking_id  ON guest_messages_sent(booking_id);

-- OWNER TRANSACTIONS
CREATE TABLE owner_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_type  txn_type NOT NULL,
  category          txn_category NOT NULL DEFAULT 'other',
  amount            numeric(10,2) NOT NULL,
  description       text NOT NULL,
  transaction_date  date NOT NULL,
  work_order_id     uuid REFERENCES work_orders(id) ON DELETE SET NULL,
  purchase_order_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_owner_txn_property_id ON owner_transactions(property_id);
CREATE INDEX idx_owner_txn_org_id      ON owner_transactions(org_id);
CREATE INDEX idx_owner_txn_date        ON owner_transactions(transaction_date);

CREATE TRIGGER owner_transactions_updated_at
  BEFORE UPDATE ON owner_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
