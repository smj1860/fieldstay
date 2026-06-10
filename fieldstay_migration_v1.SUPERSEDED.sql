-- ============================================================
-- ⚠️  SUPERSEDED — DO NOT RUN
-- ============================================================
-- This file represents the schema as of the initial v1.0 design.
-- The live Supabase project (vpmznjktllhmmbfnxuvk) has since
-- advanced through 64 tracked migrations and no longer matches
-- this file's contents (table set, columns, RLS policies, enums,
-- functions, triggers, etc. have all changed substantially).
--
-- For the current live schema, see:
--   supabase/schema_reference.sql
--
-- Do not apply this file to any database. It is kept for
-- historical reference only.
-- ============================================================

-- ============================================================
-- FieldStay — Supabase Database Migration v1.0
-- Multi-tenant STR operations platform
-- ============================================================
-- Table order respects foreign key dependencies.
-- Run this once against a fresh Supabase project.
-- ============================================================

-- ============================================================
-- EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE org_plan            AS ENUM ('starter', 'growth', 'pro', 'enterprise');
CREATE TYPE org_plan_status     AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'paused');
CREATE TYPE member_role         AS ENUM ('admin', 'manager', 'crew', 'viewer');
CREATE TYPE property_type       AS ENUM ('house', 'condo', 'cabin', 'cottage', 'townhouse', 'other');
CREATE TYPE ical_source         AS ENUM ('airbnb', 'vrbo', 'booking_com', 'direct', 'other');
CREATE TYPE sync_status         AS ENUM ('pending', 'success', 'error');
CREATE TYPE booking_status      AS ENUM ('confirmed', 'cancelled', 'blocked', 'tentative');
CREATE TYPE booking_source      AS ENUM ('airbnb', 'vrbo', 'booking_com', 'direct', 'manual', 'other');
CREATE TYPE turnover_status     AS ENUM ('pending_assignment', 'assigned', 'in_progress', 'completed', 'flagged', 'cancelled');
CREATE TYPE priority_level      AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE contact_pref        AS ENUM ('email', 'sms', 'both');
CREATE TYPE checklist_status    AS ENUM ('not_started', 'in_progress', 'completed');
CREATE TYPE inventory_category  AS ENUM ('paper_goods', 'cleaning', 'kitchen', 'bath', 'laundry', 'bedroom', 'outdoor', 'other');
CREATE TYPE po_status           AS ENUM ('draft', 'sent', 'acknowledged', 'ordered', 'received', 'cancelled');
CREATE TYPE vendor_specialty    AS ENUM ('plumbing', 'electrical', 'hvac', 'landscaping', 'cleaning', 'pest_control', 'pool', 'roofing', 'general', 'other');
CREATE TYPE wo_status           AS ENUM ('pending', 'assigned', 'in_progress', 'completed', 'cancelled');
CREATE TYPE wo_source           AS ENUM ('manual', 'maintenance_schedule', 'crew_flag', 'guest_report');
CREATE TYPE schedule_type       AS ENUM ('routine', 'seasonal');
CREATE TYPE schedule_frequency  AS ENUM ('weekly', 'biweekly', 'monthly', 'quarterly', 'semi_annual', 'annual');
CREATE TYPE message_trigger     AS ENUM ('booking_confirmed', 'pre_checkout');
CREATE TYPE message_status      AS ENUM ('sent', 'failed', 'bounced');
CREATE TYPE txn_type            AS ENUM ('revenue', 'expense');
CREATE TYPE txn_category        AS ENUM (
  'booking_revenue', 'cleaning_fee', 'maintenance',
  'restock', 'utility', 'insurance', 'supplies', 'other'
);


-- ============================================================
-- UTILITY: updated_at trigger function
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- PROFILES (extends auth.users)
-- ============================================================

CREATE TABLE profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   text,
  phone       text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auto-create profile on Supabase Auth signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ============================================================
-- ORGANIZATIONS (tenant root)
-- ============================================================

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

CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ORGANIZATION MEMBERS
-- ============================================================

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

CREATE INDEX idx_org_members_org_id      ON organization_members(org_id);
CREATE INDEX idx_org_members_user_id     ON organization_members(user_id);
CREATE INDEX idx_org_members_invite_token ON organization_members(invite_token);


-- ============================================================
-- RLS HELPER FUNCTIONS
-- (defined after organization_members; used in all policies)
-- ============================================================

-- Returns all org IDs the current user belongs to
CREATE OR REPLACE FUNCTION get_user_org_ids()
RETURNS SETOF uuid AS $$
  SELECT org_id FROM organization_members
  WHERE user_id = auth.uid()
  AND invite_accepted_at IS NOT NULL
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Returns true if current user is an org member with one of the given roles
CREATE OR REPLACE FUNCTION is_org_member(p_org_id uuid, p_roles member_role[] DEFAULT NULL)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE org_id = p_org_id
    AND user_id = auth.uid()
    AND invite_accepted_at IS NOT NULL
    AND (p_roles IS NULL OR role = ANY(p_roles))
  )
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ============================================================
-- PROPERTIES
-- ============================================================

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

CREATE TRIGGER properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- PROPERTY OWNERS (owner portal access)
-- ============================================================

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
CREATE INDEX idx_property_owners_org_id      ON property_owners(org_id);

CREATE TABLE owner_portal_tokens (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_owner_id uuid NOT NULL REFERENCES property_owners(id) ON DELETE CASCADE,
  token             uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  expires_at        timestamptz,
  last_accessed_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_owner_portal_tokens_token ON owner_portal_tokens(token);


-- ============================================================
-- ICAL FEEDS
-- ============================================================

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
CREATE INDEX idx_ical_feeds_org_id      ON ical_feeds(org_id);

CREATE TRIGGER ical_feeds_updated_at
  BEFORE UPDATE ON ical_feeds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- BOOKINGS (synced from iCal or entered manually)
-- ============================================================

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

CREATE INDEX idx_bookings_property_id  ON bookings(property_id);
CREATE INDEX idx_bookings_org_id       ON bookings(org_id);
CREATE INDEX idx_bookings_checkin      ON bookings(checkin_date);
CREATE INDEX idx_bookings_checkout     ON bookings(checkout_date);

CREATE TRIGGER bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- CREW MEMBERS
-- ============================================================

CREATE TABLE crew_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name                text NOT NULL,
  email               text,
  phone               text,
  preferred_contact   contact_pref DEFAULT 'email',
  sms_carrier         text,
  specialty           text DEFAULT 'cleaning',
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_crew_members_org_id  ON crew_members(org_id);
CREATE INDEX idx_crew_members_user_id ON crew_members(user_id);

CREATE TRIGGER crew_members_updated_at
  BEFORE UPDATE ON crew_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION get_crew_member_id()
RETURNS uuid AS $$
  SELECT id FROM crew_members WHERE user_id = auth.uid() LIMIT 1
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ============================================================
-- VENDORS
-- ============================================================

CREATE TABLE vendors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  contact_name    text,
  email           text,
  phone           text,
  specialty       vendor_specialty DEFAULT 'general',
  portal_enabled  boolean NOT NULL DEFAULT false,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vendors_org_id ON vendors(org_id);

CREATE TRIGGER vendors_updated_at
  BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- CHECKLIST TEMPLATES
-- ============================================================

CREATE TABLE checklist_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id   uuid REFERENCES properties(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checklist_templates_org_id      ON checklist_templates(org_id);
CREATE INDEX idx_checklist_templates_property_id ON checklist_templates(property_id);

CREATE TRIGGER checklist_templates_updated_at
  BEFORE UPDATE ON checklist_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE checklist_template_sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checklist_sections_template_id ON checklist_template_sections(template_id);

CREATE TABLE checklist_template_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id      uuid NOT NULL REFERENCES checklist_template_sections(id) ON DELETE CASCADE,
  template_id     uuid NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  task            text NOT NULL,
  requires_photo  boolean NOT NULL DEFAULT false,
  notes           text,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checklist_items_section_id  ON checklist_template_items(section_id);
CREATE INDEX idx_checklist_items_template_id ON checklist_template_items(template_id);


-- ============================================================
-- TURNOVERS
-- ============================================================

CREATE TABLE turnovers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  booking_id            uuid REFERENCES bookings(id) ON DELETE SET NULL,
  prev_booking_id       uuid REFERENCES bookings(id) ON DELETE SET NULL,
  checkout_datetime     timestamptz NOT NULL,
  checkin_datetime      timestamptz NOT NULL,
  window_minutes        integer,
  status                turnover_status NOT NULL DEFAULT 'pending_assignment',
  priority              priority_level NOT NULL DEFAULT 'medium',
  checklist_template_id uuid REFERENCES checklist_templates(id) ON DELETE SET NULL,
  notes                 text,
  completion_notes      text,
  completed_at          timestamptz,
  auto_generated        boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_turnovers_property_id    ON turnovers(property_id);
CREATE INDEX idx_turnovers_org_id         ON turnovers(org_id);
CREATE INDEX idx_turnovers_status         ON turnovers(status);
CREATE INDEX idx_turnovers_checkout       ON turnovers(checkout_datetime);

CREATE TRIGGER turnovers_updated_at
  BEFORE UPDATE ON turnovers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TURNOVER ASSIGNMENTS
-- ============================================================

CREATE TABLE turnover_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turnover_id       uuid NOT NULL REFERENCES turnovers(id) ON DELETE CASCADE,
  crew_member_id    uuid NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
  assigned_at       timestamptz NOT NULL DEFAULT NOW(),
  notified_at       timestamptz,
  notification_type contact_pref,
  created_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_turnover_assignments_turnover_id  ON turnover_assignments(turnover_id);
CREATE INDEX idx_turnover_assignments_crew_id      ON turnover_assignments(crew_member_id);


-- ============================================================
-- CHECKLIST INSTANCES (snapshot per turnover)
-- ============================================================

CREATE TABLE checklist_instances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turnover_id       uuid NOT NULL REFERENCES turnovers(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id       uuid REFERENCES checklist_templates(id) ON DELETE SET NULL,
  template_snapshot jsonb NOT NULL,
  status            checklist_status NOT NULL DEFAULT 'not_started',
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checklist_instances_turnover_id ON checklist_instances(turnover_id);
CREATE INDEX idx_checklist_instances_org_id      ON checklist_instances(org_id);

CREATE TRIGGER checklist_instances_updated_at
  BEFORE UPDATE ON checklist_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE checklist_instance_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id           uuid NOT NULL REFERENCES checklist_instances(id) ON DELETE CASCADE,
  section_name          text NOT NULL,
  task                  text NOT NULL,
  requires_photo        boolean NOT NULL DEFAULT false,
  notes                 text,
  sort_order            integer NOT NULL DEFAULT 0,
  is_completed          boolean NOT NULL DEFAULT false,
  completed_at          timestamptz,
  completed_by_crew_id  uuid REFERENCES crew_members(id) ON DELETE SET NULL,
  photo_storage_path    text,
  crew_notes            text,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checklist_instance_items_instance_id ON checklist_instance_items(instance_id);

CREATE TRIGGER checklist_instance_items_updated_at
  BEFORE UPDATE ON checklist_instance_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- INVENTORY CATALOG (FieldStay seeded master list)
-- ============================================================

CREATE TABLE inventory_catalog (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  category      inventory_category NOT NULL DEFAULT 'other',
  default_unit  text NOT NULL DEFAULT 'units',
  description   text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);


-- ============================================================
-- INVENTORY ITEMS (per property, PM configured)
-- ============================================================

CREATE TABLE inventory_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id             uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  catalog_item_id         uuid REFERENCES inventory_catalog(id) ON DELETE SET NULL,
  name                    text NOT NULL,
  category                inventory_category NOT NULL DEFAULT 'other',
  unit                    text NOT NULL DEFAULT 'units',
  par_level               integer NOT NULL DEFAULT 0,
  current_quantity        integer NOT NULL DEFAULT 0,
  low_stock_threshold_pct integer NOT NULL DEFAULT 30,
  is_active               boolean NOT NULL DEFAULT true,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT NOW(),
  updated_at              timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_items_property_id ON inventory_items(property_id);
CREATE INDEX idx_inventory_items_org_id      ON inventory_items(org_id);

CREATE TRIGGER inventory_items_updated_at
  BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- INVENTORY COUNTS (crew submissions, PowerSync write-back)
-- ============================================================

CREATE TABLE inventory_counts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  submitted_by_crew_id  uuid REFERENCES crew_members(id) ON DELETE SET NULL,
  submitted_at          timestamptz NOT NULL DEFAULT NOW(),
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_counts_property_id ON inventory_counts(property_id);

CREATE TABLE inventory_count_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id          uuid NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity_counted  integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_count_items_count_id ON inventory_count_items(count_id);


-- ============================================================
-- PURCHASE ORDERS
-- ============================================================

CREATE TABLE purchase_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status                po_status NOT NULL DEFAULT 'draft',
  generated_at          timestamptz NOT NULL DEFAULT NOW(),
  sent_at               timestamptz,
  acknowledged_at       timestamptz,
  notes                 text,
  total_estimated_cost  numeric(10,2),
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_purchase_orders_property_id ON purchase_orders(property_id);
CREATE INDEX idx_purchase_orders_org_id      ON purchase_orders(org_id);
CREATE INDEX idx_purchase_orders_status      ON purchase_orders(status);

CREATE TRIGGER purchase_orders_updated_at
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_order_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id   uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  inventory_item_id   uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  item_name           text NOT NULL,
  current_quantity    integer NOT NULL,
  par_level           integer NOT NULL,
  quantity_to_buy     integer NOT NULL,
  estimated_unit_cost numeric(8,2),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_po_items_purchase_order_id ON purchase_order_items(purchase_order_id);


-- ============================================================
-- WORK ORDERS
-- ============================================================

CREATE TABLE work_orders (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                 uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id                      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id                   uuid REFERENCES vendors(id) ON DELETE SET NULL,
  assigned_crew_id            uuid REFERENCES crew_members(id) ON DELETE SET NULL,
  title                       text NOT NULL,
  description                 text,
  priority                    priority_level NOT NULL DEFAULT 'medium',
  status                      wo_status NOT NULL DEFAULT 'pending',
  source                      wo_source NOT NULL DEFAULT 'manual',
  source_schedule_id          uuid,
  scheduled_date              date,
  completed_date              date,
  estimated_cost              numeric(10,2),
  actual_cost                 numeric(10,2),
  portal_enabled              boolean NOT NULL DEFAULT false,
  completion_token            uuid UNIQUE DEFAULT gen_random_uuid(),
  completion_token_expires_at timestamptz,
  completion_notes            text,
  invoice_reference           text,
  created_at                  timestamptz NOT NULL DEFAULT NOW(),
  updated_at                  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_work_orders_property_id       ON work_orders(property_id);
CREATE INDEX idx_work_orders_org_id            ON work_orders(org_id);
CREATE INDEX idx_work_orders_status            ON work_orders(status);
CREATE INDEX idx_work_orders_completion_token  ON work_orders(completion_token);
CREATE INDEX idx_work_orders_scheduled_date    ON work_orders(scheduled_date);

CREATE TRIGGER work_orders_updated_at
  BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE work_order_updates (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id             uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  org_id                    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  updated_by_user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_via_vendor_portal boolean NOT NULL DEFAULT false,
  status_from               wo_status,
  status_to                 wo_status,
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wo_updates_work_order_id ON work_order_updates(work_order_id);

CREATE TABLE work_order_photos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id   uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  storage_path    text NOT NULL,
  uploaded_by     text,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wo_photos_work_order_id ON work_order_photos(work_order_id);


-- ============================================================
-- MAINTENANCE SCHEDULES
-- ============================================================

CREATE TABLE maintenance_schedules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assigned_vendor_id  uuid REFERENCES vendors(id) ON DELETE SET NULL,
  name                text NOT NULL,
  description         text,
  schedule_type       schedule_type NOT NULL DEFAULT 'routine',
  frequency           schedule_frequency,
  month_due           integer CHECK (month_due BETWEEN 1 AND 12),
  day_of_month_due    integer CHECK (day_of_month_due BETWEEN 1 AND 31),
  estimated_cost      numeric(10,2),
  instructions        text,
  auto_create_wo      boolean NOT NULL DEFAULT false,
  last_completed_date date,
  next_due_date       date,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_maintenance_schedules_property_id ON maintenance_schedules(property_id);
CREATE INDEX idx_maintenance_schedules_next_due    ON maintenance_schedules(next_due_date);
CREATE INDEX idx_maintenance_schedules_org_id      ON maintenance_schedules(org_id);

CREATE TRIGGER maintenance_schedules_updated_at
  BEFORE UPDATE ON maintenance_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- GUEST MESSAGE TEMPLATES
-- ============================================================

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


-- ============================================================
-- OWNER TRANSACTIONS (P&L)
-- ============================================================

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


-- ============================================================
-- ENABLE ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE profiles                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations               ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_owners             ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_portal_tokens         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ical_feeds                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE crew_members                ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_templates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_template_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_template_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE turnovers                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE turnover_assignments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_instances         ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_instance_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_catalog           ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items             ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_counts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_updates          ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_photos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_schedules       ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_message_templates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_messages_sent         ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_transactions          ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- RLS POLICIES
-- ============================================================

-- PROFILES
CREATE POLICY "Users manage own profile"
  ON profiles FOR ALL
  USING (id = auth.uid());

-- ORGANIZATIONS
CREATE POLICY "Members can view their org"
  ON organizations FOR SELECT
  USING (id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins can update their org"
  ON organizations FOR UPDATE
  USING (is_org_member(id, ARRAY['admin']::member_role[]));

-- ORGANIZATION MEMBERS
CREATE POLICY "Members can view org roster"
  ON organization_members FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins manage org members"
  ON organization_members FOR ALL
  USING (is_org_member(org_id, ARRAY['admin']::member_role[]));

-- PROPERTIES
CREATE POLICY "Org members can view properties"
  ON properties FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage properties"
  ON properties FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- PROPERTY OWNERS
CREATE POLICY "Admins and managers manage property owners"
  ON property_owners FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- OWNER PORTAL TOKENS
CREATE POLICY "Admins and managers manage portal tokens"
  ON owner_portal_tokens FOR ALL
  USING (
    property_owner_id IN (
      SELECT id FROM property_owners
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

-- ICAL FEEDS
CREATE POLICY "Admins and managers manage ical feeds"
  ON ical_feeds FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- BOOKINGS
CREATE POLICY "Org members can view bookings"
  ON bookings FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage bookings"
  ON bookings FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- CREW MEMBERS
CREATE POLICY "Org members can view crew"
  ON crew_members FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage crew"
  ON crew_members FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

CREATE POLICY "Crew can view own record"
  ON crew_members FOR SELECT
  USING (user_id = auth.uid());

-- VENDORS
CREATE POLICY "Org members can view vendors"
  ON vendors FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage vendors"
  ON vendors FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- CHECKLIST TEMPLATES
CREATE POLICY "Org members can view checklist templates"
  ON checklist_templates FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage checklist templates"
  ON checklist_templates FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- CHECKLIST TEMPLATE SECTIONS
CREATE POLICY "Org members can view template sections"
  ON checklist_template_sections FOR SELECT
  USING (
    template_id IN (
      SELECT id FROM checklist_templates
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins and managers manage template sections"
  ON checklist_template_sections FOR ALL
  USING (
    template_id IN (
      SELECT id FROM checklist_templates
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

-- CHECKLIST TEMPLATE ITEMS
CREATE POLICY "Org members can view template items"
  ON checklist_template_items FOR SELECT
  USING (
    template_id IN (
      SELECT id FROM checklist_templates
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins and managers manage template items"
  ON checklist_template_items FOR ALL
  USING (
    template_id IN (
      SELECT id FROM checklist_templates
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

-- TURNOVERS
CREATE POLICY "Org members can view turnovers"
  ON turnovers FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage turnovers"
  ON turnovers FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

CREATE POLICY "Crew can view their assigned turnovers"
  ON turnovers FOR SELECT
  USING (
    id IN (
      SELECT ta.turnover_id
      FROM turnover_assignments ta
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

CREATE POLICY "Crew can update their assigned turnover status"
  ON turnovers FOR UPDATE
  USING (
    id IN (
      SELECT ta.turnover_id
      FROM turnover_assignments ta
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

-- TURNOVER ASSIGNMENTS
CREATE POLICY "Org members can view assignments"
  ON turnover_assignments FOR SELECT
  USING (
    turnover_id IN (
      SELECT id FROM turnovers
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins and managers manage assignments"
  ON turnover_assignments FOR ALL
  USING (
    turnover_id IN (
      SELECT id FROM turnovers
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

CREATE POLICY "Crew can view own assignments"
  ON turnover_assignments FOR SELECT
  USING (
    crew_member_id IN (
      SELECT id FROM crew_members WHERE user_id = auth.uid()
    )
  );

-- CHECKLIST INSTANCES
CREATE POLICY "Org members can view checklist instances"
  ON checklist_instances FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage checklist instances"
  ON checklist_instances FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

CREATE POLICY "Crew can view instances for their turnovers"
  ON checklist_instances FOR SELECT
  USING (
    turnover_id IN (
      SELECT ta.turnover_id
      FROM turnover_assignments ta
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

-- CHECKLIST INSTANCE ITEMS
CREATE POLICY "Org members can view instance items"
  ON checklist_instance_items FOR SELECT
  USING (
    instance_id IN (
      SELECT id FROM checklist_instances
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins and managers manage instance items"
  ON checklist_instance_items FOR ALL
  USING (
    instance_id IN (
      SELECT id FROM checklist_instances
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

CREATE POLICY "Crew can update items for their turnovers"
  ON checklist_instance_items FOR UPDATE
  USING (
    instance_id IN (
      SELECT ci.id FROM checklist_instances ci
      JOIN turnover_assignments ta ON ci.turnover_id = ta.turnover_id
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

-- INVENTORY CATALOG (public read)
CREATE POLICY "Anyone can read inventory catalog"
  ON inventory_catalog FOR SELECT
  USING (true);

-- INVENTORY ITEMS
CREATE POLICY "Org members can view inventory items"
  ON inventory_items FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage inventory items"
  ON inventory_items FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

CREATE POLICY "Crew can view inventory for assigned properties"
  ON inventory_items FOR SELECT
  USING (
    property_id IN (
      SELECT DISTINCT t.property_id
      FROM turnovers t
      JOIN turnover_assignments ta ON ta.turnover_id = t.id
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

-- INVENTORY COUNTS
CREATE POLICY "Admins and managers can view all counts"
  ON inventory_counts FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Crew can submit inventory counts"
  ON inventory_counts FOR INSERT
  WITH CHECK (
    submitted_by_crew_id IN (
      SELECT id FROM crew_members WHERE user_id = auth.uid()
    )
  );

-- INVENTORY COUNT ITEMS
CREATE POLICY "Org members can view count items"
  ON inventory_count_items FOR SELECT
  USING (
    count_id IN (
      SELECT id FROM inventory_counts
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Crew can insert count items"
  ON inventory_count_items FOR INSERT
  WITH CHECK (
    count_id IN (
      SELECT ic.id FROM inventory_counts ic
      JOIN crew_members cm ON ic.submitted_by_crew_id = cm.id
      WHERE cm.user_id = auth.uid()
    )
  );

-- PURCHASE ORDERS
CREATE POLICY "Admins and managers manage purchase orders"
  ON purchase_orders FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

CREATE POLICY "Admins and managers manage PO items"
  ON purchase_order_items FOR ALL
  USING (
    purchase_order_id IN (
      SELECT id FROM purchase_orders
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

-- WORK ORDERS
CREATE POLICY "Org members can view work orders"
  ON work_orders FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage work orders"
  ON work_orders FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- WORK ORDER UPDATES
CREATE POLICY "Org members can view work order updates"
  ON work_order_updates FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers insert work order updates"
  ON work_order_updates FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- WORK ORDER PHOTOS
CREATE POLICY "Org members can view work order photos"
  ON work_order_photos FOR SELECT
  USING (
    work_order_id IN (
      SELECT id FROM work_orders
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins and managers manage work order photos"
  ON work_order_photos FOR ALL
  USING (
    work_order_id IN (
      SELECT id FROM work_orders
      WHERE is_org_member(org_id, ARRAY['admin','manager']::member_role[])
    )
  );

-- MAINTENANCE SCHEDULES
CREATE POLICY "Org members can view maintenance schedules"
  ON maintenance_schedules FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers manage maintenance schedules"
  ON maintenance_schedules FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- GUEST MESSAGE TEMPLATES
CREATE POLICY "Admins and managers manage message templates"
  ON guest_message_templates FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- GUEST MESSAGES SENT
CREATE POLICY "Admins and managers can view sent messages"
  ON guest_messages_sent FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- OWNER TRANSACTIONS
CREATE POLICY "Admins and managers manage transactions"
  ON owner_transactions FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));


-- ============================================================
-- INVENTORY CATALOG SEED DATA
-- ============================================================

INSERT INTO inventory_catalog (name, category, default_unit, description) VALUES
  -- Paper Goods
  ('Toilet Paper',          'paper_goods', 'rolls',   'Standard toilet paper rolls'),
  ('Paper Towels',          'paper_goods', 'rolls',   'Paper towel rolls'),
  ('Facial Tissues',        'paper_goods', 'boxes',   'Tissue boxes'),
  ('Napkins',               'paper_goods', 'packs',   'Paper napkins'),
  -- Cleaning
  ('Dish Soap',             'cleaning',    'bottles', 'Dish washing liquid'),
  ('Dishwasher Pods',       'cleaning',    'count',   'Dishwasher detergent pods'),
  ('Laundry Detergent',     'cleaning',    'bottles', 'Laundry detergent'),
  ('All-Purpose Cleaner',   'cleaning',    'bottles', 'All-purpose spray cleaner'),
  ('Bathroom Cleaner',      'cleaning',    'bottles', 'Toilet and bathroom cleaner'),
  ('Glass Cleaner',         'cleaning',    'bottles', 'Window and glass cleaner'),
  ('Trash Bags - Kitchen',  'cleaning',    'count',   'Standard kitchen trash bags'),
  ('Trash Bags - Large',    'cleaning',    'count',   'Large outdoor/bin trash bags'),
  ('Sponges',               'cleaning',    'count',   'Kitchen sponges'),
  ('Scrub Brushes',         'cleaning',    'count',   'Scrub brushes'),
  ('Mop Heads',             'cleaning',    'count',   'Replacement mop heads'),
  -- Kitchen
  ('Coffee',                'kitchen',     'bags',    'Ground or whole bean coffee'),
  ('Coffee Filters',        'kitchen',     'count',   'Paper coffee filters'),
  ('Sugar',                 'kitchen',     'bags',    'Granulated sugar or packets'),
  ('Salt',                  'kitchen',     'count',   'Salt shakers or packets'),
  ('Pepper',                'kitchen',     'count',   'Pepper shakers or packets'),
  ('Cooking Oil',           'kitchen',     'bottles', 'Cooking/vegetable oil'),
  ('Aluminum Foil',         'kitchen',     'rolls',   'Aluminum foil rolls'),
  ('Plastic Wrap',          'kitchen',     'rolls',   'Plastic cling wrap'),
  ('Zip Lock Bags',         'kitchen',     'boxes',   'Resealable storage bags'),
  -- Bath
  ('Hand Soap',             'bath',        'bottles', 'Bar or liquid hand soap'),
  ('Shampoo',               'bath',        'bottles', 'Shampoo bottles'),
  ('Conditioner',           'bath',        'bottles', 'Hair conditioner'),
  ('Body Wash',             'bath',        'bottles', 'Body wash or shower gel'),
  ('Lotion',                'bath',        'bottles', 'Body lotion'),
  ('Shower Caps',           'bath',        'count',   'Disposable shower caps'),
  ('Cotton Balls / Swabs',  'bath',        'bags',    'Cotton balls or Q-tips'),
  -- Laundry
  ('Dryer Sheets',          'laundry',     'boxes',   'Dryer sheets'),
  ('Fabric Softener',       'laundry',     'bottles', 'Liquid fabric softener'),
  ('Stain Remover',         'laundry',     'bottles', 'Spray stain remover'),
  -- Outdoor
  ('Bug Spray',             'outdoor',     'bottles', 'Insect repellent'),
  ('Sunscreen',             'outdoor',     'bottles', 'Sunscreen SPF 30+'),
  ('Charcoal',              'outdoor',     'bags',    'Grill charcoal'),
  ('Lighter Fluid',         'outdoor',     'bottles', 'Grill lighter fluid'),
  ('Propane Tank',          'outdoor',     'count',   'Propane tank for gas grill');
