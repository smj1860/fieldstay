CREATE TABLE profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   text,
  phone       text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, full_name) VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

CREATE TABLE organizations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  slug                    text UNIQUE NOT NULL,
  billing_email           text,
  stripe_customer_id      text UNIQUE,
  stripe_subscription_id  text UNIQUE,
  plan                    org_plan NOT NULL DEFAULT 'starter',
  plan_status             org_plan_status NOT NULL DEFAULT 'trialing',
  trial_ends_at           timestamptz,
  max_properties          integer NOT NULL DEFAULT 5,
  created_at              timestamptz NOT NULL DEFAULT NOW(),
  updated_at              timestamptz NOT NULL DEFAULT NOW()
);
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE organization_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role                member_role NOT NULL DEFAULT 'viewer',
  invited_email       text,
  invite_token        uuid UNIQUE DEFAULT gen_random_uuid(),
  invite_accepted_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);
CREATE INDEX idx_org_members_org_id       ON organization_members(org_id);
CREATE INDEX idx_org_members_user_id      ON organization_members(user_id);
CREATE INDEX idx_org_members_invite_token ON organization_members(invite_token);

CREATE OR REPLACE FUNCTION get_user_org_ids()
RETURNS SETOF uuid AS $$
  SELECT org_id FROM organization_members
  WHERE user_id = auth.uid() AND invite_accepted_at IS NOT NULL
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_org_member(p_org_id uuid, p_roles member_role[] DEFAULT NULL)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE org_id = p_org_id AND user_id = auth.uid()
      AND invite_accepted_at IS NOT NULL
      AND (p_roles IS NULL OR role = ANY(p_roles))
  )
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE TABLE properties (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                      text NOT NULL,
  address                   text,
  city                      text,
  state                     text,
  zip                       text,
  property_type             property_type DEFAULT 'house',
  bedrooms                  integer DEFAULT 1,
  bathrooms                 numeric(3,1) DEFAULT 1.0,
  max_guests                integer DEFAULT 2,
  avg_stay_length           numeric(4,1) DEFAULT 3.0,
  avg_turnovers_per_month   numeric(4,1) DEFAULT 4.0,
  wifi_name                 text,
  wifi_password             text,
  door_code                 text,
  checkout_time             time DEFAULT '11:00',
  checkin_time              time DEFAULT '15:00',
  internal_notes            text,
  setup_steps_completed     jsonb NOT NULL DEFAULT '{}',
  is_active                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT NOW(),
  updated_at                timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_properties_org_id ON properties(org_id);
CREATE TRIGGER properties_updated_at BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION set_updated_at();
