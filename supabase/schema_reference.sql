-- =============================================================================
-- FieldStay — Live Schema Reference Snapshot
-- =============================================================================
-- Generated: 2026-06-10
-- Source:    Supabase project vpmznjktllhmmbfnxuvk (live production database)
-- Method:    Read-only introspection via pg_catalog / information_schema
--            (Supabase MCP execute_sql, SELECT-only queries)
--
-- ⚠️  THIS IS NOT A MIGRATION. DO NOT RUN IT. DO NOT PLACE IT IN
--     supabase/migrations/.
--
-- Purpose:
--   The live database has 64 applied migrations (see
--   `supabase db migrations list` / mcp list_migrations), but
--   supabase/migrations/ in this repo only contains 4 files. This file is a
--   point-in-time DUMP of the resulting live schema — every table, enum,
--   constraint, index, function, trigger, view, and RLS policy that
--   currently exists in `public` — so the codebase has a single document to
--   diff against when reasoning about schema drift.
--
--   The live database already has this exact schema. Re-running any part of
--   this file against the live project would fail on "already exists"
--   errors (or, for the RLS/policy statements, create duplicate policies).
--
--   See the "Database Migrations & Schema Drift" section of CLAUDE.md for
--   the recommended workflow going forward.
-- =============================================================================


-- =============================================================================
-- 1. EXTENSIONS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "supabase_vault";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- =============================================================================
-- 2. ENUM TYPES (33)
-- =============================================================================

CREATE TYPE public.asset_type AS ENUM ('hvac', 'water_heater', 'roof', 'refrigerator', 'washer', 'dryer', 'dishwasher', 'microwave', 'oven_range', 'pool_pump', 'hot_tub', 'garage_door', 'smart_lock', 'deck_structure', 'electrical_panel', 'plumbing_system', 'septic_system', 'well_pump', 'generator', 'solar_system', 'other');
CREATE TYPE public.booking_source AS ENUM ('airbnb', 'vrbo', 'booking_com', 'direct', 'manual', 'other');
CREATE TYPE public.booking_status AS ENUM ('confirmed', 'cancelled', 'blocked', 'tentative');
CREATE TYPE public.checklist_status AS ENUM ('not_started', 'in_progress', 'completed');
CREATE TYPE public.comm_channel AS ENUM ('email', 'sms', 'phone', 'in_person', 'note');
CREATE TYPE public.comm_recipient_type AS ENUM ('vendor', 'crew');
CREATE TYPE public.comm_source AS ENUM ('manual', 'system');
CREATE TYPE public.compliance_doc_type AS ENUM ('coi', 'workers_comp', 'business_license', 'contractor_license', 'bonding', 'other');
CREATE TYPE public.contact_pref AS ENUM ('email', 'sms', 'both');
CREATE TYPE public.crew_role AS ENUM ('cleaning', 'landscaping', 'maintenance', 'general');
CREATE TYPE public.ical_source AS ENUM ('airbnb', 'vrbo', 'booking_com', 'direct', 'other');
CREATE TYPE public.inventory_category AS ENUM ('paper_goods', 'cleaning', 'kitchen', 'bath', 'laundry', 'bedroom', 'outdoor', 'other', 'bedroom_linens', 'maintenance_safety', 'guest_experience', 'technology');
CREATE TYPE public.line_item_type AS ENUM ('labor', 'material', 'equipment', 'subcontractor', 'other');
CREATE TYPE public.macrs_class AS ENUM ('5_year', '15_year', '27_5_year', '39_year', 'section_179');
CREATE TYPE public.member_role AS ENUM ('admin', 'manager', 'crew', 'viewer', 'owner');
CREATE TYPE public.message_status AS ENUM ('sent', 'failed', 'bounced');
CREATE TYPE public.message_trigger AS ENUM ('booking_confirmed', 'pre_checkout');
CREATE TYPE public.org_plan AS ENUM ('starter', 'growth', 'pro', 'enterprise');
CREATE TYPE public.org_plan_status AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'paused');
CREATE TYPE public.po_status AS ENUM ('draft', 'sent', 'acknowledged', 'ordered', 'received', 'cancelled');
CREATE TYPE public.priority_level AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE public.property_type AS ENUM ('house', 'condo', 'cabin', 'cottage', 'townhouse', 'other');
CREATE TYPE public.quote_request_status AS ENUM ('pending', 'submitted', 'approved', 'declined', 'expired');
CREATE TYPE public.schedule_frequency AS ENUM ('weekly', 'biweekly', 'monthly', 'quarterly', 'semi_annual', 'annual');
CREATE TYPE public.schedule_type AS ENUM ('routine', 'seasonal');
CREATE TYPE public.sync_status AS ENUM ('pending', 'success', 'error');
CREATE TYPE public.turnover_status AS ENUM ('pending_assignment', 'assigned', 'in_progress', 'completed', 'flagged', 'cancelled');
CREATE TYPE public.txn_category AS ENUM ('booking_revenue', 'cleaning_fee', 'maintenance', 'restock', 'utility', 'insurance', 'supplies', 'other');
CREATE TYPE public.txn_type AS ENUM ('revenue', 'expense');
CREATE TYPE public.vendor_specialty AS ENUM ('plumbing', 'electrical', 'hvac', 'landscaping', 'cleaning', 'pest_control', 'pool', 'roofing', 'general', 'other');
CREATE TYPE public.wo_category AS ENUM ('hvac', 'plumbing', 'electrical', 'appliance', 'cleaning', 'landscaping', 'roofing', 'flooring', 'windows_doors', 'pest_control', 'pool', 'structural', 'general', 'other');
CREATE TYPE public.wo_source AS ENUM ('manual', 'maintenance_schedule', 'crew_flag', 'guest_report');
CREATE TYPE public.wo_status AS ENUM ('pending', 'quote_requested', 'assigned', 'in_progress', 'completed', 'cancelled');


-- =============================================================================
-- 3. TABLES (62)
-- =============================================================================

CREATE TABLE public.asset_depreciation_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  tax_year smallint NOT NULL,
  macrs_class macrs_class NOT NULL,
  cost_basis numeric(12,2) NOT NULL,
  prior_cumulative_depreciation numeric(12,2) NOT NULL DEFAULT 0,
  current_year_depreciation numeric(12,2) NOT NULL,
  ending_adjusted_basis numeric(12,2) NOT NULL,
  depreciation_rate numeric(6,4),
  notes text,
  generated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.asset_type_standards (
  asset_type asset_type NOT NULL,
  display_name text NOT NULL,
  lifespan_min_years smallint NOT NULL,
  lifespan_max_years smallint NOT NULL,
  avg_replacement_cost_low integer,
  avg_replacement_cost_high integer,
  macrs_class_default macrs_class NOT NULL DEFAULT '5_year'::macrs_class,
  vendor_specialty_default vendor_specialty,
  notes text
);

CREATE TABLE public.assignment_outcomes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  turnover_id uuid NOT NULL,
  crew_member_id uuid NOT NULL,
  property_id uuid,
  suggested_score smallint,
  score_breakdown jsonb,
  was_suggestion boolean NOT NULL DEFAULT false,
  was_accepted boolean,
  override_reason text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  duration_minutes integer DEFAULT
CASE
    WHEN ((started_at IS NOT NULL) AND (completed_at IS NOT NULL) AND ((EXTRACT(epoch FROM (completed_at - started_at)) / (60)::numeric) <= (480)::numeric)) THEN (EXTRACT(epoch FROM (completed_at - started_at)) / (60)::numeric)
    ELSE NULL::numeric
END,
  pm_rating smallint,
  property_bedrooms smallint,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.audit_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid,
  actor_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb,
  ip_address text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.bookings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  ical_feed_id uuid,
  ical_uid text,
  guest_name text,
  guest_email text,
  checkin_date date NOT NULL,
  checkout_date date NOT NULL,
  checkin_time time without time zone,
  checkout_time time without time zone,
  source booking_source DEFAULT 'other'::booking_source,
  status booking_status NOT NULL DEFAULT 'confirmed'::booking_status,
  notes text,
  raw_ical_data jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  external_id text,
  external_source text
);

CREATE TABLE public.checklist_instance_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL,
  section_name text NOT NULL,
  task text NOT NULL,
  requires_photo boolean NOT NULL DEFAULT false,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  is_completed boolean NOT NULL DEFAULT false,
  completed_at timestamp with time zone,
  completed_by_crew_id uuid,
  photo_storage_path text,
  crew_notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  is_section_final_item boolean NOT NULL DEFAULT false
);

CREATE TABLE public.checklist_instances (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  turnover_id uuid NOT NULL,
  org_id uuid NOT NULL,
  template_id uuid,
  template_snapshot jsonb NOT NULL,
  status checklist_status NOT NULL DEFAULT 'not_started'::checklist_status,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.checklist_template_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL,
  template_id uuid NOT NULL,
  task text NOT NULL,
  requires_photo boolean NOT NULL DEFAULT false,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.checklist_template_sections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  requires_section_photo boolean NOT NULL DEFAULT false
);

CREATE TABLE public.checklist_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  property_id uuid,
  name text NOT NULL,
  description text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.communication_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  recipient_type comm_recipient_type NOT NULL,
  vendor_id uuid,
  crew_member_id uuid,
  channel comm_channel NOT NULL DEFAULT 'email'::comm_channel,
  subject text,
  body text,
  property_id uuid,
  work_order_id uuid,
  source comm_source NOT NULL DEFAULT 'manual'::comm_source,
  logged_by_user_id uuid,
  communicated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone
);

CREATE TABLE public.crew_availability (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  crew_member_id uuid NOT NULL,
  available_date date NOT NULL,
  is_available boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.crew_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid,
  name text NOT NULL,
  email text,
  phone text,
  preferred_contact contact_pref DEFAULT 'email'::contact_pref,
  sms_carrier text,
  specialty text DEFAULT 'cleaning'::text,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  invite_token uuid DEFAULT gen_random_uuid(),
  invite_sent_at timestamp with time zone,
  invite_accepted_at timestamp with time zone,
  role crew_role NOT NULL DEFAULT 'general'::crew_role,
  home_lat numeric(9,6),
  home_lng numeric(9,6),
  reliability_score numeric(4,3) NOT NULL DEFAULT 1.0,
  capacity_score numeric(4,3) NOT NULL DEFAULT 1.0
);

CREATE TABLE public.guest_message_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  trigger message_trigger NOT NULL,
  name text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  days_before integer DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.guest_messages_sent (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  booking_id uuid,
  template_id uuid,
  trigger message_trigger NOT NULL,
  recipient_name text,
  recipient_email text NOT NULL,
  subject text NOT NULL,
  body_rendered text NOT NULL,
  sent_at timestamp with time zone NOT NULL DEFAULT now(),
  resend_message_id text,
  status message_status NOT NULL DEFAULT 'sent'::message_status,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.ical_feeds (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  source ical_source DEFAULT 'other'::ical_source,
  last_synced_at timestamp with time zone,
  last_sync_status sync_status DEFAULT 'pending'::sync_status,
  last_sync_error text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.integration_connections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider_id text NOT NULL,
  external_user_id text,
  vault_secret_id uuid,
  scope text,
  status text NOT NULL DEFAULT 'active'::text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  connected_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.integration_providers (
  id text NOT NULL,
  display_name text NOT NULL,
  auth_type text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.inventory_catalog (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category inventory_category NOT NULL DEFAULT 'other'::inventory_category,
  default_unit text NOT NULL DEFAULT 'units'::text,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.inventory_count_draft_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL,
  item_id uuid NOT NULL,
  counted_qty integer NOT NULL DEFAULT 0,
  note text
);

CREATE TABLE public.inventory_count_drafts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  submitted_by uuid,
  status text NOT NULL DEFAULT 'draft'::text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.inventory_count_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  count_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity_counted integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.inventory_counts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  submitted_by_crew_id uuid,
  submitted_at timestamp with time zone NOT NULL DEFAULT now(),
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.inventory_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  catalog_item_id uuid,
  name text NOT NULL,
  category inventory_category NOT NULL DEFAULT 'other'::inventory_category,
  unit text NOT NULL DEFAULT 'units'::text,
  par_level integer NOT NULL DEFAULT 0,
  current_quantity integer NOT NULL DEFAULT 0,
  low_stock_threshold_pct integer NOT NULL DEFAULT 30,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  preferred_brand text
);

CREATE TABLE public.inventory_template_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  name text NOT NULL,
  category text,
  unit text,
  par_qty integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  par_level numeric NOT NULL DEFAULT 1,
  preferred_brand text
);

CREATE TABLE public.inventory_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.maintenance_schedule_template_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  schedule_frequency schedule_frequency NOT NULL,
  vendor_specialty_hint vendor_specialty,
  estimated_cost numeric(10,2),
  is_optional_flag text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.maintenance_schedule_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.maintenance_schedules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  assigned_vendor_id uuid,
  name text NOT NULL,
  description text,
  schedule_type schedule_type NOT NULL DEFAULT 'routine'::schedule_type,
  frequency schedule_frequency,
  month_due integer,
  day_of_month_due integer,
  estimated_cost numeric(10,2),
  instructions text,
  auto_create_wo boolean NOT NULL DEFAULT true,
  last_completed_date date,
  next_due_date date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  vendor_specialty_hint vendor_specialty
);

CREATE TABLE public.messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  content text NOT NULL,
  read_at timestamp with time zone,
  turnover_id uuid,
  work_order_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.oauth_states (
  state text NOT NULL,
  user_id uuid,
  provider_id text NOT NULL,
  return_to text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + '00:10:00'::interval)
);

CREATE TABLE public.org_invites (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  invited_by uuid NOT NULL,
  email text NOT NULL,
  role member_role NOT NULL DEFAULT 'admin'::member_role,
  token text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'::text),
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + '7 days'::interval),
  accepted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.org_master_checklist_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  section text NOT NULL,
  task text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'catalog'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.org_master_maintenance_schedules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  frequency text NOT NULL DEFAULT 'monthly'::text,
  month_day integer,
  week_day integer,
  estimated_cost numeric(10,2),
  specialty text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.org_milestones (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  milestone text NOT NULL,
  achieved_at timestamp with time zone NOT NULL DEFAULT now(),
  prompted_at timestamp with time zone,
  review_clicked boolean NOT NULL DEFAULT false,
  dismissed boolean NOT NULL DEFAULT false,
  value jsonb
);

CREATE TABLE public.organization_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid,
  role member_role NOT NULL DEFAULT 'viewer'::member_role,
  invited_email text,
  invite_token uuid DEFAULT gen_random_uuid(),
  invite_accepted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.organizations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  billing_email text,
  stripe_customer_id text,
  stripe_subscription_id text,
  plan org_plan NOT NULL DEFAULT 'starter'::org_plan,
  plan_status org_plan_status NOT NULL DEFAULT 'trialing'::org_plan_status,
  trial_ends_at timestamp with time zone,
  max_properties integer NOT NULL DEFAULT 5,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  repuguard_status text DEFAULT 'inactive'::text,
  repuguard_trial_start timestamp with time zone,
  repuguard_trial_end timestamp with time zone,
  repuguard_stripe_subscription_id text,
  repuguard_founding_member boolean NOT NULL DEFAULT false,
  onboarding_steps_completed jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_assign_mode text NOT NULL DEFAULT 'suggest'::text,
  auto_assign_enabled boolean NOT NULL DEFAULT true,
  preferred_retailer text DEFAULT 'walmart'::text,
  kroger_location_id text,
  kroger_location_name text,
  kroger_customer_token text,
  kroger_token_expires_at timestamp with time zone,
  kroger_refresh_token text,
  comms_log_retention_days smallint NOT NULL DEFAULT 365,
  slack_webhook_url text
);

CREATE TABLE public.owner_portal_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_owner_id uuid NOT NULL,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  expires_at timestamp with time zone,
  last_accessed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  revoked_at timestamp with time zone,
  property_ids uuid[],
  is_multi boolean NOT NULL DEFAULT false
);

CREATE TABLE public.owner_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  transaction_type txn_type NOT NULL,
  category txn_category NOT NULL DEFAULT 'other'::txn_category,
  amount numeric(10,2) NOT NULL,
  description text NOT NULL,
  transaction_date date NOT NULL,
  work_order_id uuid,
  purchase_order_id uuid,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  booking_id uuid,
  source text DEFAULT 'manual'::text,
  source_reference_id uuid,
  visible_to_owner boolean NOT NULL DEFAULT true
);

CREATE TABLE public.powersync_crew_instances (
  user_id uuid NOT NULL,
  instance_id uuid NOT NULL
);

CREATE TABLE public.powersync_crew_properties (
  user_id uuid NOT NULL,
  property_id uuid NOT NULL
);

CREATE TABLE public.powersync_crew_turnovers (
  user_id uuid NOT NULL,
  turnover_id uuid NOT NULL
);

CREATE TABLE public.profiles (
  id uuid NOT NULL,
  full_name text,
  phone text,
  avatar_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.properties (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  address text,
  city text,
  state text,
  zip text,
  property_type property_type DEFAULT 'house'::property_type,
  bedrooms integer DEFAULT 1,
  bathrooms numeric(3,1) DEFAULT 1.0,
  max_guests integer DEFAULT 2,
  avg_stay_length numeric(4,1) DEFAULT 3.0,
  avg_turnovers_per_month numeric(4,1) DEFAULT 4.0,
  wifi_name text,
  wifi_password text,
  door_code text,
  checkout_time time without time zone DEFAULT '11:00:00'::time without time zone,
  checkin_time time without time zone DEFAULT '15:00:00'::time without time zone,
  internal_notes text,
  setup_steps_completed jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  avg_nightly_rate numeric(10,2) DEFAULT NULL::numeric,
  external_id text,
  external_source text,
  access_instructions text,
  square_footage integer,
  cleaning_cost numeric(10,2),
  same_day_premium_pct numeric(5,2) DEFAULT 25.00,
  cleaning_cost_visible_to_owner boolean NOT NULL DEFAULT false,
  lat numeric(9,6),
  lng numeric(9,6)
);

CREATE TABLE public.property_assets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  property_id uuid NOT NULL,
  name text NOT NULL,
  asset_type asset_type NOT NULL,
  make text,
  model text,
  serial_number text,
  installation_date date,
  manufacture_date date,
  purchase_price numeric(12,2),
  estimated_replacement_cost numeric(12,2),
  expected_lifespan_years smallint,
  warranty_expiry_date date,
  warranty_provider text,
  warranty_notes text,
  placed_in_service_date date,
  macrs_class macrs_class DEFAULT '5_year'::macrs_class,
  depreciation_method text DEFAULT 'macrs'::text,
  salvage_value numeric(12,2) DEFAULT 0,
  health_score smallint,
  health_score_updated_at timestamp with time zone,
  is_active boolean NOT NULL DEFAULT true,
  replaced_by_asset_id uuid,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.property_owners (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  property_id uuid NOT NULL,
  name text NOT NULL,
  email text,
  phone text,
  revenue_share_pct numeric(5,2),
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.purchase_order_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL,
  inventory_item_id uuid,
  item_name text NOT NULL,
  current_quantity integer NOT NULL,
  par_level integer NOT NULL,
  quantity_to_buy integer NOT NULL,
  estimated_unit_cost numeric(8,2),
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.purchase_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  status po_status NOT NULL DEFAULT 'draft'::po_status,
  generated_at timestamp with time zone NOT NULL DEFAULT now(),
  sent_at timestamp with time zone,
  acknowledged_at timestamp with time zone,
  notes text,
  total_estimated_cost numeric(10,2),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.push_subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  crew_member_id uuid NOT NULL,
  org_id uuid NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.quote_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  org_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  status quote_request_status NOT NULL DEFAULT 'pending'::quote_request_status,
  quote_token text NOT NULL,
  quote_token_expires_at timestamp with time zone NOT NULL,
  quoted_amount numeric(10,2),
  quote_notes text,
  sent_at timestamp with time zone NOT NULL DEFAULT now(),
  submitted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.review_responses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generated_response text,
  edited_response text,
  word_count integer,
  tone_used text,
  flags text[] NOT NULL DEFAULT '{}'::text[],
  flag_reason text,
  generated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  property_id uuid,
  external_id text NOT NULL,
  external_source text NOT NULL DEFAULT 'ownerrez'::text,
  guest_name text,
  rating integer NOT NULL,
  review_text text NOT NULL,
  review_date timestamp with time zone,
  response_status text NOT NULL DEFAULT 'pending'::text,
  external_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.stripe_processed_events (
  stripe_event_id text NOT NULL,
  processed_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.turnover_assignments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  turnover_id uuid NOT NULL,
  crew_member_id uuid NOT NULL,
  assigned_at timestamp with time zone NOT NULL DEFAULT now(),
  notified_at timestamp with time zone,
  notification_type contact_pref,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.turnovers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  booking_id uuid,
  prev_booking_id uuid,
  checkout_datetime timestamp with time zone NOT NULL,
  checkin_datetime timestamp with time zone NOT NULL,
  window_minutes integer,
  status turnover_status NOT NULL DEFAULT 'pending_assignment'::turnover_status,
  priority priority_level NOT NULL DEFAULT 'medium'::priority_level,
  checklist_template_id uuid,
  notes text,
  completion_notes text,
  completed_at timestamp with time zone,
  auto_generated boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  started_at timestamp with time zone,
  suggested_crew_ids uuid[],
  suggestion_reasoning text,
  suggestion_status text,
  is_same_day_turnover boolean NOT NULL DEFAULT false
);

CREATE TABLE public.vendor_compliance_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  document_type compliance_doc_type NOT NULL,
  document_name text NOT NULL,
  policy_number text,
  issuer_name text,
  effective_date date,
  expiry_date date,
  coverage_amount numeric(12,2),
  document_url text,
  is_verified boolean NOT NULL DEFAULT false,
  verification_notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  first_warned_at timestamp with time zone,
  hard_blocked_at timestamp with time zone
);

CREATE TABLE public.vendors (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  contact_name text,
  email text,
  phone text,
  specialty vendor_specialty DEFAULT 'general'::vendor_specialty,
  portal_enabled boolean NOT NULL DEFAULT false,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  avg_rating numeric(3,2),
  rating_count integer NOT NULL DEFAULT 0,
  lat numeric(9,6),
  lng numeric(9,6),
  service_zip text,
  service_radius_miles smallint DEFAULT 25,
  address text,
  city text,
  state text
);

CREATE TABLE public.wo_number_counters (
  org_id uuid NOT NULL,
  last_number integer NOT NULL DEFAULT 0,
  current_year smallint NOT NULL DEFAULT (EXTRACT(year FROM now()))::smallint
);

CREATE TABLE public.work_order_line_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  org_id uuid NOT NULL,
  line_type line_item_type NOT NULL DEFAULT 'material'::line_item_type,
  description text NOT NULL,
  quantity numeric(8,2) NOT NULL DEFAULT 1,
  unit text,
  unit_cost numeric(10,2) NOT NULL,
  line_total numeric(10,2) DEFAULT (quantity * unit_cost),
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.work_order_photos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  storage_path text NOT NULL,
  uploaded_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.work_order_updates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  org_id uuid NOT NULL,
  updated_by_user_id uuid,
  updated_via_vendor_portal boolean NOT NULL DEFAULT false,
  status_from wo_status,
  status_to wo_status,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.work_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  vendor_id uuid,
  assigned_crew_id uuid,
  title text NOT NULL,
  description text,
  priority priority_level NOT NULL DEFAULT 'medium'::priority_level,
  status wo_status NOT NULL DEFAULT 'pending'::wo_status,
  source wo_source NOT NULL DEFAULT 'manual'::wo_source,
  source_schedule_id uuid,
  scheduled_date date,
  completed_date date,
  estimated_cost numeric(10,2),
  actual_cost numeric(10,2),
  portal_enabled boolean NOT NULL DEFAULT false,
  completion_token uuid DEFAULT gen_random_uuid(),
  completion_token_expires_at timestamp with time zone,
  completion_notes text,
  invoice_reference text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  wo_number text,
  category wo_category,
  nte_amount numeric(10,2),
  access_notes text,
  vendor_acknowledged_at timestamp with time zone,
  vendor_acknowledged_by uuid,
  completion_verified_at timestamp with time zone,
  completion_verified_by uuid,
  vendor_rating smallint,
  vendor_rating_notes text,
  assigned_crew_member_id uuid,
  asset_id uuid,
  source_turnover_id uuid
);
-- NOTE: work_orders has BOTH assigned_crew_id (deprecated, FK retained for
-- legacy data) AND assigned_crew_member_id (current). New code must use
-- assigned_crew_member_id only — see CLAUDE.md "Things That Will Break".


-- =============================================================================
-- 4. CONSTRAINTS — PRIMARY KEYS
-- =============================================================================

ALTER TABLE ONLY public.asset_depreciation_entries ADD CONSTRAINT asset_depreciation_entries_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.asset_type_standards ADD CONSTRAINT asset_type_standards_pkey PRIMARY KEY (asset_type);
ALTER TABLE ONLY public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.audit_events ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.checklist_instance_items ADD CONSTRAINT checklist_instance_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.checklist_instances ADD CONSTRAINT checklist_instances_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.checklist_template_items ADD CONSTRAINT checklist_template_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.checklist_template_sections ADD CONSTRAINT checklist_template_sections_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.checklist_templates ADD CONSTRAINT checklist_templates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.communication_logs ADD CONSTRAINT communication_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.crew_availability ADD CONSTRAINT crew_availability_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.crew_members ADD CONSTRAINT crew_members_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.guest_message_templates ADD CONSTRAINT guest_message_templates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.guest_messages_sent ADD CONSTRAINT guest_messages_sent_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ical_feeds ADD CONSTRAINT ical_feeds_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.integration_connections ADD CONSTRAINT integration_connections_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.integration_providers ADD CONSTRAINT integration_providers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.inventory_catalog ADD CONSTRAINT inventory_catalog_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.inventory_count_draft_items ADD CONSTRAINT inventory_count_draft_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.inventory_count_drafts ADD CONSTRAINT inventory_count_drafts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.inventory_count_items ADD CONSTRAINT inventory_count_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.inventory_counts ADD CONSTRAINT inventory_counts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.inventory_items ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.inventory_template_items ADD CONSTRAINT inventory_template_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.inventory_templates ADD CONSTRAINT inventory_templates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.maintenance_schedule_template_items ADD CONSTRAINT maintenance_schedule_template_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.maintenance_schedule_templates ADD CONSTRAINT maintenance_schedule_templates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.messages ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.oauth_states ADD CONSTRAINT oauth_states_pkey PRIMARY KEY (state);
ALTER TABLE ONLY public.org_invites ADD CONSTRAINT org_invites_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.org_master_checklist_items ADD CONSTRAINT org_master_checklist_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.org_master_maintenance_schedules ADD CONSTRAINT org_master_maintenance_schedules_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.org_milestones ADD CONSTRAINT org_milestones_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.organization_members ADD CONSTRAINT organization_members_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.organizations ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.owner_portal_tokens ADD CONSTRAINT owner_portal_tokens_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.owner_transactions ADD CONSTRAINT owner_transactions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.powersync_crew_instances ADD CONSTRAINT powersync_crew_instances_pkey PRIMARY KEY (user_id, instance_id);
ALTER TABLE ONLY public.powersync_crew_properties ADD CONSTRAINT powersync_crew_properties_pkey PRIMARY KEY (user_id, property_id);
ALTER TABLE ONLY public.powersync_crew_turnovers ADD CONSTRAINT powersync_crew_turnovers_pkey PRIMARY KEY (user_id, turnover_id);
ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.properties ADD CONSTRAINT properties_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.property_assets ADD CONSTRAINT property_assets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.property_owners ADD CONSTRAINT property_owners_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.purchase_order_items ADD CONSTRAINT purchase_order_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.purchase_orders ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.push_subscriptions ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.quote_requests ADD CONSTRAINT quote_requests_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.review_responses ADD CONSTRAINT review_responses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.reviews ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.stripe_processed_events ADD CONSTRAINT stripe_processed_events_pkey PRIMARY KEY (stripe_event_id);
ALTER TABLE ONLY public.turnover_assignments ADD CONSTRAINT turnover_assignments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.turnovers ADD CONSTRAINT turnovers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.vendor_compliance_documents ADD CONSTRAINT vendor_compliance_documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.vendors ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.wo_number_counters ADD CONSTRAINT wo_number_counters_pkey PRIMARY KEY (org_id);
ALTER TABLE ONLY public.work_order_line_items ADD CONSTRAINT work_order_line_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.work_order_photos ADD CONSTRAINT work_order_photos_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.work_order_updates ADD CONSTRAINT work_order_updates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_pkey PRIMARY KEY (id);


-- =============================================================================
-- 4b. CONSTRAINTS — UNIQUE
-- =============================================================================

ALTER TABLE ONLY public.asset_depreciation_entries ADD CONSTRAINT asset_depreciation_entries_asset_id_tax_year_key UNIQUE (asset_id, tax_year);
ALTER TABLE ONLY public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_turnover_id_crew_member_id_key UNIQUE (turnover_id, crew_member_id);
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_ical_feed_id_ical_uid_key UNIQUE (ical_feed_id, ical_uid);
ALTER TABLE ONLY public.crew_availability ADD CONSTRAINT crew_availability_crew_member_id_available_date_key UNIQUE (crew_member_id, available_date);
ALTER TABLE ONLY public.crew_members ADD CONSTRAINT crew_members_invite_token_key UNIQUE (invite_token);
ALTER TABLE ONLY public.integration_connections ADD CONSTRAINT integration_connections_user_id_provider_id_key UNIQUE (user_id, provider_id);
ALTER TABLE ONLY public.org_invites ADD CONSTRAINT org_invites_token_key UNIQUE (token);
ALTER TABLE ONLY public.org_milestones ADD CONSTRAINT org_milestones_org_id_milestone_key UNIQUE (org_id, milestone);
ALTER TABLE ONLY public.organization_members ADD CONSTRAINT organization_members_invite_token_key UNIQUE (invite_token);
ALTER TABLE ONLY public.organization_members ADD CONSTRAINT organization_members_org_id_user_id_key UNIQUE (org_id, user_id);
ALTER TABLE ONLY public.organizations ADD CONSTRAINT organizations_slug_key UNIQUE (slug);
ALTER TABLE ONLY public.organizations ADD CONSTRAINT organizations_stripe_customer_id_key UNIQUE (stripe_customer_id);
ALTER TABLE ONLY public.organizations ADD CONSTRAINT organizations_stripe_subscription_id_key UNIQUE (stripe_subscription_id);
ALTER TABLE ONLY public.owner_portal_tokens ADD CONSTRAINT owner_portal_tokens_owner_type_unique UNIQUE (property_owner_id, is_multi);
ALTER TABLE ONLY public.owner_portal_tokens ADD CONSTRAINT owner_portal_tokens_token_key UNIQUE (token);
ALTER TABLE ONLY public.owner_transactions ADD CONSTRAINT owner_transactions_source_ref_unique UNIQUE (source_reference_id, source);
ALTER TABLE ONLY public.owner_transactions ADD CONSTRAINT uq_owner_txn_source UNIQUE (source_reference_id, source);
ALTER TABLE ONLY public.push_subscriptions ADD CONSTRAINT push_subscriptions_crew_member_id_endpoint_key UNIQUE (crew_member_id, endpoint);
ALTER TABLE ONLY public.quote_requests ADD CONSTRAINT quote_requests_quote_token_key UNIQUE (quote_token);
ALTER TABLE ONLY public.reviews ADD CONSTRAINT reviews_external_id_external_source_key UNIQUE (external_id, external_source);
ALTER TABLE ONLY public.turnover_assignments ADD CONSTRAINT turnover_assignments_crew_unique UNIQUE (turnover_id, crew_member_id);
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_completion_token_key UNIQUE (completion_token);
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_wo_number_key UNIQUE (wo_number);
-- NOTE: owner_transactions has TWO duplicate UNIQUE(source_reference_id, source)
-- constraints (owner_transactions_source_ref_unique AND uq_owner_txn_source).
-- Functionally redundant but both exist live; not removed here (out of scope
-- for a read-only reference — would require a migration + DROP CONSTRAINT).


-- =============================================================================
-- 4c. CONSTRAINTS — FOREIGN KEYS
-- =============================================================================

ALTER TABLE ONLY public.asset_depreciation_entries ADD CONSTRAINT asset_depreciation_entries_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES property_assets(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_turnover_id_fkey FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.audit_events ADD CONSTRAINT audit_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.audit_events ADD CONSTRAINT audit_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_ical_feed_id_fkey FOREIGN KEY (ical_feed_id) REFERENCES ical_feeds(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.checklist_instance_items ADD CONSTRAINT checklist_instance_items_completed_by_crew_id_fkey FOREIGN KEY (completed_by_crew_id) REFERENCES crew_members(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.checklist_instance_items ADD CONSTRAINT checklist_instance_items_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES checklist_instances(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.checklist_instances ADD CONSTRAINT checklist_instances_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.checklist_instances ADD CONSTRAINT checklist_instances_template_id_fkey FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.checklist_instances ADD CONSTRAINT checklist_instances_turnover_id_fkey FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.checklist_template_items ADD CONSTRAINT checklist_template_items_section_id_fkey FOREIGN KEY (section_id) REFERENCES checklist_template_sections(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.checklist_template_items ADD CONSTRAINT checklist_template_items_template_id_fkey FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.checklist_template_sections ADD CONSTRAINT checklist_template_sections_template_id_fkey FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.checklist_templates ADD CONSTRAINT checklist_templates_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.checklist_templates ADD CONSTRAINT checklist_templates_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.communication_logs ADD CONSTRAINT communication_logs_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.communication_logs ADD CONSTRAINT communication_logs_logged_by_user_id_fkey FOREIGN KEY (logged_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.communication_logs ADD CONSTRAINT communication_logs_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.communication_logs ADD CONSTRAINT communication_logs_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.communication_logs ADD CONSTRAINT communication_logs_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.communication_logs ADD CONSTRAINT communication_logs_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.crew_availability ADD CONSTRAINT crew_availability_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.crew_members ADD CONSTRAINT crew_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.crew_members ADD CONSTRAINT crew_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.guest_message_templates ADD CONSTRAINT guest_message_templates_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.guest_message_templates ADD CONSTRAINT guest_message_templates_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.guest_messages_sent ADD CONSTRAINT guest_messages_sent_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.guest_messages_sent ADD CONSTRAINT guest_messages_sent_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.guest_messages_sent ADD CONSTRAINT guest_messages_sent_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.guest_messages_sent ADD CONSTRAINT guest_messages_sent_template_id_fkey FOREIGN KEY (template_id) REFERENCES guest_message_templates(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.ical_feeds ADD CONSTRAINT ical_feeds_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ical_feeds ADD CONSTRAINT ical_feeds_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.integration_connections ADD CONSTRAINT integration_connections_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES integration_providers(id);
ALTER TABLE ONLY public.integration_connections ADD CONSTRAINT integration_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.inventory_count_draft_items ADD CONSTRAINT inventory_count_draft_items_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES inventory_count_drafts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.inventory_count_draft_items ADD CONSTRAINT inventory_count_draft_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.inventory_count_drafts ADD CONSTRAINT inventory_count_drafts_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.inventory_count_items ADD CONSTRAINT inventory_count_items_count_id_fkey FOREIGN KEY (count_id) REFERENCES inventory_counts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.inventory_count_items ADD CONSTRAINT inventory_count_items_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.inventory_counts ADD CONSTRAINT inventory_counts_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.inventory_counts ADD CONSTRAINT inventory_counts_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.inventory_counts ADD CONSTRAINT inventory_counts_submitted_by_crew_id_fkey FOREIGN KEY (submitted_by_crew_id) REFERENCES crew_members(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.inventory_items ADD CONSTRAINT inventory_items_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES inventory_catalog(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.inventory_items ADD CONSTRAINT inventory_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.inventory_items ADD CONSTRAINT inventory_items_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.inventory_template_items ADD CONSTRAINT inventory_template_items_template_id_fkey FOREIGN KEY (template_id) REFERENCES inventory_templates(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.maintenance_schedule_template_items ADD CONSTRAINT maintenance_schedule_template_items_template_id_fkey FOREIGN KEY (template_id) REFERENCES maintenance_schedule_templates(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_assigned_vendor_id_fkey FOREIGN KEY (assigned_vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.messages ADD CONSTRAINT messages_turnover_id_fkey FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.messages ADD CONSTRAINT messages_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.oauth_states ADD CONSTRAINT oauth_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.org_invites ADD CONSTRAINT org_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.org_invites ADD CONSTRAINT org_invites_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.org_master_checklist_items ADD CONSTRAINT org_master_checklist_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.org_master_maintenance_schedules ADD CONSTRAINT org_master_maintenance_schedules_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.org_milestones ADD CONSTRAINT org_milestones_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.organization_members ADD CONSTRAINT organization_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.organization_members ADD CONSTRAINT organization_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.owner_portal_tokens ADD CONSTRAINT owner_portal_tokens_property_owner_id_fkey FOREIGN KEY (property_owner_id) REFERENCES property_owners(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.owner_transactions ADD CONSTRAINT owner_transactions_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.owner_transactions ADD CONSTRAINT owner_transactions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.owner_transactions ADD CONSTRAINT owner_transactions_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.owner_transactions ADD CONSTRAINT owner_transactions_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.owner_transactions ADD CONSTRAINT owner_transactions_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.properties ADD CONSTRAINT properties_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.property_assets ADD CONSTRAINT property_assets_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.property_assets ADD CONSTRAINT property_assets_replaced_by_asset_id_fkey FOREIGN KEY (replaced_by_asset_id) REFERENCES property_assets(id);
ALTER TABLE ONLY public.property_owners ADD CONSTRAINT property_owners_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.property_owners ADD CONSTRAINT property_owners_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.purchase_order_items ADD CONSTRAINT purchase_order_items_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.purchase_order_items ADD CONSTRAINT purchase_order_items_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.purchase_orders ADD CONSTRAINT purchase_orders_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.purchase_orders ADD CONSTRAINT purchase_orders_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.push_subscriptions ADD CONSTRAINT push_subscriptions_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.push_subscriptions ADD CONSTRAINT push_subscriptions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.quote_requests ADD CONSTRAINT quote_requests_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.quote_requests ADD CONSTRAINT quote_requests_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.quote_requests ADD CONSTRAINT quote_requests_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_responses ADD CONSTRAINT review_responses_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_responses ADD CONSTRAINT review_responses_review_id_fkey FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.reviews ADD CONSTRAINT reviews_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.reviews ADD CONSTRAINT reviews_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.turnover_assignments ADD CONSTRAINT turnover_assignments_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.turnover_assignments ADD CONSTRAINT turnover_assignments_turnover_id_fkey FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.turnovers ADD CONSTRAINT turnovers_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.turnovers ADD CONSTRAINT turnovers_checklist_template_id_fkey FOREIGN KEY (checklist_template_id) REFERENCES checklist_templates(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.turnovers ADD CONSTRAINT turnovers_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.turnovers ADD CONSTRAINT turnovers_prev_booking_id_fkey FOREIGN KEY (prev_booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.turnovers ADD CONSTRAINT turnovers_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vendor_compliance_documents ADD CONSTRAINT vendor_compliance_documents_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vendors ADD CONSTRAINT vendors_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.wo_number_counters ADD CONSTRAINT wo_number_counters_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.work_order_line_items ADD CONSTRAINT work_order_line_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.work_order_line_items ADD CONSTRAINT work_order_line_items_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.work_order_photos ADD CONSTRAINT work_order_photos_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.work_order_updates ADD CONSTRAINT work_order_updates_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.work_order_updates ADD CONSTRAINT work_order_updates_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.work_order_updates ADD CONSTRAINT work_order_updates_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES property_assets(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_assigned_crew_id_fkey FOREIGN KEY (assigned_crew_id) REFERENCES crew_members(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_assigned_crew_member_id_fkey FOREIGN KEY (assigned_crew_member_id) REFERENCES crew_members(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_completion_verified_by_fkey FOREIGN KEY (completion_verified_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_source_turnover_id_fkey FOREIGN KEY (source_turnover_id) REFERENCES turnovers(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_vendor_acknowledged_by_fkey FOREIGN KEY (vendor_acknowledged_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;


-- =============================================================================
-- 4d. CONSTRAINTS — CHECK
-- =============================================================================

ALTER TABLE ONLY public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_pm_rating_check CHECK (((pm_rating >= 1) AND (pm_rating <= 5)));
ALTER TABLE ONLY public.crew_members ADD CONSTRAINT crew_members_capacity_score_check CHECK (((capacity_score >= (0)::numeric) AND (capacity_score <= (1)::numeric)));
ALTER TABLE ONLY public.crew_members ADD CONSTRAINT crew_members_reliability_score_check CHECK (((reliability_score >= (0)::numeric) AND (reliability_score <= (1)::numeric)));
ALTER TABLE ONLY public.ical_feeds ADD CONSTRAINT ical_feeds_url_must_be_https CHECK ((url LIKE 'https://%'));
ALTER TABLE ONLY public.integration_connections ADD CONSTRAINT integration_connections_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'error'::text])));
ALTER TABLE ONLY public.integration_providers ADD CONSTRAINT integration_providers_auth_type_check CHECK ((auth_type = ANY (ARRAY['oauth2'::text, 'api_key'::text])));
ALTER TABLE ONLY public.inventory_count_drafts ADD CONSTRAINT inventory_count_drafts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE ONLY public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_day_of_month_due_check CHECK (((day_of_month_due >= 1) AND (day_of_month_due <= 31)));
ALTER TABLE ONLY public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_month_due_check CHECK (((month_due >= 1) AND (month_due <= 12)));
ALTER TABLE ONLY public.messages ADD CONSTRAINT messages_content_check CHECK ((char_length(content) > 0));
ALTER TABLE ONLY public.org_invites ADD CONSTRAINT org_invites_role_check CHECK ((role = 'admin'::member_role));
ALTER TABLE ONLY public.organizations ADD CONSTRAINT organizations_auto_assign_mode_check CHECK ((auto_assign_mode = ANY (ARRAY['suggest'::text, 'autopilot'::text, 'disabled'::text])));
ALTER TABLE ONLY public.organizations ADD CONSTRAINT organizations_preferred_retailer_check CHECK ((preferred_retailer = ANY (ARRAY['walmart'::text, 'kroger'::text, 'amazon_business'::text, 'none'::text])));
ALTER TABLE ONLY public.organizations ADD CONSTRAINT organizations_repuguard_status_check CHECK ((repuguard_status = ANY (ARRAY['inactive'::text, 'trial'::text, 'active'::text, 'cancelled'::text])));
ALTER TABLE ONLY public.owner_transactions ADD CONSTRAINT owner_transactions_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'wo_completion'::text, 'booking_revenue'::text, 'uplisting_booking'::text, 'inventory_purchase'::text, 'cleaning_fee'::text])));
ALTER TABLE ONLY public.property_assets ADD CONSTRAINT property_assets_depreciation_method_check CHECK ((depreciation_method = ANY (ARRAY['macrs'::text, 'section_179'::text, 'straight_line'::text])));
ALTER TABLE ONLY public.property_assets ADD CONSTRAINT property_assets_health_score_check CHECK (((health_score >= 0) AND (health_score <= 100)));
ALTER TABLE ONLY public.reviews ADD CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE ONLY public.reviews ADD CONSTRAINT reviews_response_status_check CHECK ((response_status = ANY (ARRAY['pending'::text, 'draft'::text, 'ready'::text, 'posted'::text])));
ALTER TABLE ONLY public.turnovers ADD CONSTRAINT turnovers_suggestion_status_check CHECK (((suggestion_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'overridden'::text, 'dismissed'::text])) OR (suggestion_status IS NULL)));
ALTER TABLE ONLY public.work_order_line_items ADD CONSTRAINT work_order_line_items_quantity_check CHECK ((quantity > (0)::numeric));
ALTER TABLE ONLY public.work_order_line_items ADD CONSTRAINT work_order_line_items_unit_cost_check CHECK ((unit_cost >= (0)::numeric));
ALTER TABLE ONLY public.work_orders ADD CONSTRAINT work_orders_vendor_rating_check CHECK (((vendor_rating >= 1) AND (vendor_rating <= 5)));

-- =====================================================================
-- 5. INDEXES (non-constraint-backing)
-- =====================================================================

CREATE INDEX idx_depreciation_org_year ON public.asset_depreciation_entries USING btree (org_id, tax_year);
CREATE INDEX idx_assignment_outcomes_crew ON public.assignment_outcomes USING btree (crew_member_id, completed_at DESC);
CREATE INDEX idx_assignment_outcomes_property_crew ON public.assignment_outcomes USING btree (property_id, crew_member_id) WHERE (duration_minutes IS NOT NULL);
CREATE INDEX idx_audit_events_action ON public.audit_events USING btree (action);
CREATE INDEX idx_audit_events_actor_id ON public.audit_events USING btree (actor_id);
CREATE INDEX idx_audit_events_created ON public.audit_events USING btree (created_at DESC);
CREATE INDEX idx_audit_events_org_id ON public.audit_events USING btree (org_id);
CREATE UNIQUE INDEX bookings_external_id_source_idx ON public.bookings USING btree (external_id, external_source) WHERE (external_id IS NOT NULL);
CREATE UNIQUE INDEX bookings_ical_uid_unique ON public.bookings USING btree (ical_feed_id, ical_uid) WHERE (ical_uid IS NOT NULL);
CREATE INDEX idx_bookings_checkin ON public.bookings USING btree (checkin_date);
CREATE INDEX idx_bookings_checkout ON public.bookings USING btree (checkout_date);
CREATE INDEX idx_bookings_org_id ON public.bookings USING btree (org_id);
CREATE INDEX idx_bookings_property_id ON public.bookings USING btree (property_id);
CREATE INDEX idx_checklist_instance_items_instance_id ON public.checklist_instance_items USING btree (instance_id);
CREATE INDEX idx_checklist_instances_org_id ON public.checklist_instances USING btree (org_id);
CREATE INDEX idx_checklist_instances_turnover_id ON public.checklist_instances USING btree (turnover_id);
CREATE INDEX idx_checklist_items_section_id ON public.checklist_template_items USING btree (section_id);
CREATE INDEX idx_checklist_items_template_id ON public.checklist_template_items USING btree (template_id);
CREATE INDEX idx_checklist_sections_template_id ON public.checklist_template_sections USING btree (template_id);
CREATE INDEX idx_checklist_templates_org_id ON public.checklist_templates USING btree (org_id);
CREATE INDEX idx_checklist_templates_property_id ON public.checklist_templates USING btree (property_id);
CREATE INDEX idx_comm_logs_communicated_at ON public.communication_logs USING btree (communicated_at DESC);
CREATE INDEX idx_comm_logs_crew_member_id ON public.communication_logs USING btree (crew_member_id) WHERE (crew_member_id IS NOT NULL);
CREATE INDEX idx_comm_logs_org_id ON public.communication_logs USING btree (org_id);
CREATE INDEX idx_comm_logs_property_id ON public.communication_logs USING btree (property_id) WHERE (property_id IS NOT NULL);
CREATE INDEX idx_comm_logs_vendor_id ON public.communication_logs USING btree (vendor_id) WHERE (vendor_id IS NOT NULL);
CREATE INDEX idx_comm_logs_work_order_id ON public.communication_logs USING btree (work_order_id) WHERE (work_order_id IS NOT NULL);
CREATE INDEX idx_comms_log_retention ON public.communication_logs USING btree (org_id, created_at) WHERE (deleted_at IS NULL);
CREATE INDEX idx_crew_availability_lookup ON public.crew_availability USING btree (crew_member_id, available_date);
CREATE INDEX idx_crew_members_invite_token ON public.crew_members USING btree (invite_token);
CREATE INDEX idx_crew_members_org_id ON public.crew_members USING btree (org_id);
CREATE INDEX idx_crew_members_user_id ON public.crew_members USING btree (user_id);
CREATE INDEX idx_guest_templates_org_id ON public.guest_message_templates USING btree (org_id);
CREATE INDEX idx_guest_templates_property_id ON public.guest_message_templates USING btree (property_id);
CREATE INDEX idx_guest_messages_sent_booking_id ON public.guest_messages_sent USING btree (booking_id);
CREATE INDEX idx_guest_messages_sent_property_id ON public.guest_messages_sent USING btree (property_id);
CREATE INDEX idx_ical_feeds_org_id ON public.ical_feeds USING btree (org_id);
CREATE INDEX idx_ical_feeds_property_id ON public.ical_feeds USING btree (property_id);
CREATE INDEX idx_inventory_count_items_count_id ON public.inventory_count_items USING btree (count_id);
CREATE INDEX idx_inventory_counts_property_id ON public.inventory_counts USING btree (property_id);
CREATE INDEX idx_inventory_items_brand ON public.inventory_items USING btree (org_id, preferred_brand) WHERE (preferred_brand IS NOT NULL);
CREATE INDEX idx_inventory_items_org_id ON public.inventory_items USING btree (org_id);
CREATE INDEX idx_inventory_items_property_id ON public.inventory_items USING btree (property_id);
CREATE UNIQUE INDEX inventory_templates_org_unique ON public.inventory_templates USING btree (org_id);
CREATE INDEX idx_maintenance_schedules_next_due ON public.maintenance_schedules USING btree (next_due_date);
CREATE INDEX idx_maintenance_schedules_org_id ON public.maintenance_schedules USING btree (org_id);
CREATE INDEX idx_maintenance_schedules_property_id ON public.maintenance_schedules USING btree (property_id);
CREATE INDEX idx_messages_conversation ON public.messages USING btree (org_id, sender_id, recipient_id, created_at DESC);
CREATE INDEX idx_messages_recipient_unread ON public.messages USING btree (recipient_id, read_at) WHERE (read_at IS NULL);
CREATE INDEX oauth_states_expires_at_idx ON public.oauth_states USING btree (expires_at);
CREATE INDEX idx_org_invites_email ON public.org_invites USING btree (email);
CREATE INDEX idx_org_invites_org_id ON public.org_invites USING btree (org_id);
CREATE INDEX idx_org_invites_token ON public.org_invites USING btree (token);
CREATE UNIQUE INDEX org_invites_active_email_unique ON public.org_invites USING btree (org_id, email) WHERE (accepted_at IS NULL);
CREATE INDEX idx_org_master_checklist_org_id ON public.org_master_checklist_items USING btree (org_id);
CREATE INDEX idx_org_master_maintenance_org_id ON public.org_master_maintenance_schedules USING btree (org_id);
CREATE INDEX idx_org_milestones_org_id ON public.org_milestones USING btree (org_id);
CREATE INDEX idx_org_members_invite_token ON public.organization_members USING btree (invite_token);
CREATE INDEX idx_org_members_org_id ON public.organization_members USING btree (org_id);
CREATE INDEX idx_org_members_user_id ON public.organization_members USING btree (user_id);
CREATE INDEX idx_owner_portal_revoked ON public.owner_portal_tokens USING btree (revoked_at) WHERE (revoked_at IS NOT NULL);
CREATE INDEX idx_owner_portal_tokens_revoked ON public.owner_portal_tokens USING btree (revoked_at) WHERE (revoked_at IS NULL);
CREATE INDEX idx_owner_portal_tokens_token ON public.owner_portal_tokens USING btree (token);
CREATE UNIQUE INDEX owner_portal_multi_unique ON public.owner_portal_tokens USING btree (property_owner_id) WHERE (is_multi = true);
CREATE UNIQUE INDEX owner_portal_single_unique ON public.owner_portal_tokens USING btree (property_owner_id) WHERE (is_multi IS NOT TRUE);
CREATE INDEX idx_owner_txn_booking_id ON public.owner_transactions USING btree (booking_id);
CREATE INDEX idx_owner_txn_date ON public.owner_transactions USING btree (transaction_date);
CREATE INDEX idx_owner_txn_org_id ON public.owner_transactions USING btree (org_id);
CREATE INDEX idx_owner_txn_property_id ON public.owner_transactions USING btree (property_id);
CREATE INDEX idx_properties_org_id ON public.properties USING btree (org_id);
CREATE UNIQUE INDEX properties_external_id_source_idx ON public.properties USING btree (external_id, external_source) WHERE (external_id IS NOT NULL);
CREATE INDEX idx_property_assets_org ON public.property_assets USING btree (org_id, health_score);
CREATE INDEX idx_property_assets_property ON public.property_assets USING btree (property_id, asset_type);
CREATE INDEX idx_property_assets_warranty ON public.property_assets USING btree (warranty_expiry_date) WHERE ((warranty_expiry_date IS NOT NULL) AND (is_active = true));
CREATE INDEX idx_property_owners_org_id ON public.property_owners USING btree (org_id);
CREATE INDEX idx_property_owners_property_id ON public.property_owners USING btree (property_id);
CREATE INDEX idx_po_items_purchase_order_id ON public.purchase_order_items USING btree (purchase_order_id);
CREATE INDEX idx_purchase_orders_org_id ON public.purchase_orders USING btree (org_id);
CREATE INDEX idx_purchase_orders_property_id ON public.purchase_orders USING btree (property_id);
CREATE INDEX idx_purchase_orders_status ON public.purchase_orders USING btree (status);
CREATE INDEX idx_push_subs_crew_member ON public.push_subscriptions USING btree (crew_member_id);
CREATE INDEX idx_quote_requests_org_id ON public.quote_requests USING btree (org_id);
CREATE INDEX idx_quote_requests_quote_token ON public.quote_requests USING btree (quote_token);
CREATE INDEX idx_quote_requests_token ON public.quote_requests USING btree (quote_token);
CREATE INDEX idx_quote_requests_vendor_id ON public.quote_requests USING btree (vendor_id);
CREATE INDEX idx_quote_requests_wo_status ON public.quote_requests USING btree (work_order_id, status);
CREATE INDEX idx_quote_requests_work_order_id ON public.quote_requests USING btree (work_order_id);
CREATE UNIQUE INDEX idx_review_responses_review_id ON public.review_responses USING btree (review_id);
CREATE INDEX idx_reviews_org_id ON public.reviews USING btree (org_id);
CREATE INDEX idx_reviews_property_id ON public.reviews USING btree (property_id);
CREATE INDEX idx_reviews_status ON public.reviews USING btree (response_status);
CREATE INDEX idx_turnover_assignments_crew_id ON public.turnover_assignments USING btree (crew_member_id);
CREATE INDEX idx_turnover_assignments_turnover_id ON public.turnover_assignments USING btree (turnover_id);
CREATE INDEX idx_turnovers_checkout ON public.turnovers USING btree (checkout_datetime);
CREATE INDEX idx_turnovers_org_id ON public.turnovers USING btree (org_id);
CREATE INDEX idx_turnovers_property_id ON public.turnovers USING btree (property_id);
CREATE INDEX idx_turnovers_status ON public.turnovers USING btree (status);
CREATE UNIQUE INDEX turnovers_booking_pair_unique ON public.turnovers USING btree (booking_id, prev_booking_id) WHERE ((booking_id IS NOT NULL) AND (prev_booking_id IS NOT NULL));
CREATE INDEX idx_vendor_compliance_expiring ON public.vendor_compliance_documents USING btree (expiry_date, org_id) WHERE ((is_active = true) AND (expiry_date IS NOT NULL));
CREATE INDEX idx_vendor_compliance_vendor ON public.vendor_compliance_documents USING btree (vendor_id, document_type, expiry_date);
CREATE INDEX idx_vendors_org_id ON public.vendors USING btree (org_id);
CREATE INDEX idx_wo_line_items_org_id ON public.work_order_line_items USING btree (org_id);
CREATE INDEX idx_wo_line_items_work_order_id ON public.work_order_line_items USING btree (work_order_id);
CREATE INDEX idx_wo_photos_work_order_id ON public.work_order_photos USING btree (work_order_id);
CREATE UNIQUE INDEX wo_photos_storage_path_unique ON public.work_order_photos USING btree (storage_path);
CREATE INDEX idx_wo_updates_work_order_id ON public.work_order_updates USING btree (work_order_id);
CREATE INDEX idx_work_orders_completion_token ON public.work_orders USING btree (completion_token);
CREATE INDEX idx_work_orders_org_id ON public.work_orders USING btree (org_id);
CREATE INDEX idx_work_orders_property_id ON public.work_orders USING btree (property_id);
CREATE INDEX idx_work_orders_scheduled_date ON public.work_orders USING btree (scheduled_date);
CREATE INDEX idx_work_orders_status ON public.work_orders USING btree (status);
CREATE UNIQUE INDEX wo_crew_flag_source_unique ON public.work_orders USING btree (source_turnover_id) WHERE ((source = 'crew_flag'::wo_source) AND (source_turnover_id IS NOT NULL));

-- =====================================================================
-- 6. FUNCTIONS
-- =====================================================================

CREATE OR REPLACE FUNCTION public.assign_wo_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.wo_number IS NULL THEN
    NEW.wo_number := next_wo_number(NEW.org_id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_oauth_states()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  DELETE FROM public.oauth_states WHERE expires_at < now();
$function$;

CREATE OR REPLACE FUNCTION public.get_asset_repair_summary()
 RETURNS TABLE(asset_id uuid, total_repairs bigint, total_repair_cost numeric, last_serviced_at date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    wo.asset_id,
    COUNT(*) AS total_repairs,
    COALESCE(SUM(wo.actual_cost), SUM(wo.estimated_cost), 0)::numeric AS total_repair_cost,
    MAX(wo.completed_date)::date AS last_serviced_at
  FROM work_orders wo
  WHERE wo.asset_id IS NOT NULL
    AND wo.status = 'completed'
  GROUP BY wo.asset_id
$function$;

CREATE OR REPLACE FUNCTION public.get_crew_member_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM crew_members WHERE user_id = auth.uid() LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.get_repeat_issues(since_date timestamp with time zone)
 RETURNS TABLE(org_id uuid, property_id uuid, category text, wo_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    wo.org_id,
    wo.property_id,
    wo.category,
    COUNT(*) AS wo_count
  FROM work_orders wo
  WHERE wo.status != 'cancelled'
    AND wo.created_at >= since_date
  GROUP BY wo.org_id, wo.property_id, wo.category
  HAVING COUNT(*) >= 3
$function$;

CREATE OR REPLACE FUNCTION public.get_user_org_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT org_id FROM organization_members
  WHERE user_id = auth.uid()
  AND invite_accepted_at IS NOT NULL
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, full_name)
    VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_org_member(p_org_id uuid, p_roles member_role[] DEFAULT NULL::member_role[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM organization_members
    WHERE org_id              = p_org_id
      AND user_id             = auth.uid()
      AND invite_accepted_at IS NOT NULL
      AND (
        p_roles IS NULL                    -- no role restriction: any member passes
        OR role = ANY(p_roles)             -- explicit role match
        OR role = 'owner'::member_role     -- org owner always has full access
      )
  )
$function$;

CREATE OR REPLACE FUNCTION public.next_wo_number(p_org_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_year   smallint := EXTRACT(YEAR FROM NOW())::smallint;
  v_number integer;
BEGIN
  INSERT INTO wo_number_counters (org_id, last_number, current_year)
  VALUES (p_org_id, 1, v_year)
  ON CONFLICT (org_id) DO UPDATE
    SET last_number  = CASE
                         WHEN wo_number_counters.current_year = v_year
                         THEN wo_number_counters.last_number + 1
                         ELSE 1
                       END,
        current_year = v_year
  RETURNING last_number INTO v_number;
  RETURN 'WO-' || v_year || '-' || LPAD(v_number::text, 4, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.read_integration_token(p_user_id uuid, p_provider_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_token text;
BEGIN
  SELECT ds.decrypted_secret
    INTO v_token
  FROM public.integration_connections c
  JOIN vault.decrypted_secrets ds ON ds.id = c.vault_secret_id
  WHERE c.user_id     = p_user_id
    AND c.provider_id = p_provider_id
    AND c.status      = 'active';

  IF v_token IS NOT NULL THEN
    UPDATE public.integration_connections
    SET last_used_at = now()
    WHERE user_id     = p_user_id
      AND provider_id = p_provider_id;
  END IF;

  RETURN v_token;
END;
$function$;

CREATE OR REPLACE FUNCTION public.replace_master_checklist_items(p_org_id uuid, p_items jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.org_master_checklist_items
  WHERE org_id = p_org_id;

  IF jsonb_array_length(p_items) = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.org_master_checklist_items (org_id, section, task, sort_order, source)
  SELECT
    p_org_id,
    (item ->> 'section'),
    (item ->> 'task'),
    (item ->> 'sort_order')::int,
    (item ->> 'source')
  FROM jsonb_array_elements(p_items) AS item;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_integration_token(p_user_id uuid, p_provider_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_secret_id uuid;
BEGIN
  SELECT vault_secret_id
    INTO v_secret_id
  FROM public.integration_connections
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  UPDATE public.integration_connections
  SET status          = 'revoked',
      vault_secret_id = NULL,
      updated_at      = now()
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  IF v_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_comm_log_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- communication_logs has no updated_at; this is a no-op placeholder
  -- included for schema consistency
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.store_integration_token(p_user_id uuid, p_provider_id text, p_access_token text, p_external_user_id text, p_scope text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_secret_id          uuid;
  v_existing_secret_id uuid;
  v_connection_exists  boolean := false;
BEGIN
  SELECT vault_secret_id, true
    INTO v_existing_secret_id, v_connection_exists
  FROM public.integration_connections
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  IF v_connection_exists THEN
    IF v_existing_secret_id IS NOT NULL THEN
      -- Update existing Vault secret in place
      PERFORM vault.update_secret(v_existing_secret_id, p_access_token);
      v_secret_id := v_existing_secret_id;
    ELSE
      -- Previously revoked — secret was destroyed. Create a fresh one.
      v_secret_id := vault.create_secret(
        p_access_token,
        p_provider_id || '_token_' || p_user_id::text,
        'OAuth access token for ' || p_provider_id
      );
    END IF;

    UPDATE public.integration_connections
    SET vault_secret_id  = v_secret_id,
        external_user_id = p_external_user_id,
        scope            = p_scope,
        metadata         = p_metadata,
        status           = 'active',
        updated_at       = now()
    WHERE user_id     = p_user_id
      AND provider_id = p_provider_id;

  ELSE
    -- Brand new connection
    v_secret_id := vault.create_secret(
      p_access_token,
      p_provider_id || '_token_' || p_user_id::text,
      'OAuth access token for ' || p_provider_id
    );

    INSERT INTO public.integration_connections
      (user_id, provider_id, external_user_id, vault_secret_id, scope, metadata)
    VALUES
      (p_user_id, p_provider_id, p_external_user_id, v_secret_id, p_scope, p_metadata);
  END IF;

  RETURN v_secret_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_powersync_crew_on_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id    UUID;
  v_property_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT user_id INTO v_user_id
    FROM crew_members WHERE id = NEW.crew_member_id;

    SELECT property_id INTO v_property_id
    FROM turnovers WHERE id = NEW.turnover_id;

    IF v_user_id IS NOT NULL THEN
      INSERT INTO powersync_crew_turnovers (user_id, turnover_id)
      VALUES (v_user_id, NEW.turnover_id)
      ON CONFLICT DO NOTHING;

      IF v_property_id IS NOT NULL THEN
        INSERT INTO powersync_crew_properties (user_id, property_id)
        VALUES (v_user_id, v_property_id)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    SELECT user_id INTO v_user_id
    FROM crew_members WHERE id = OLD.crew_member_id;

    SELECT property_id INTO v_property_id
    FROM turnovers WHERE id = OLD.turnover_id;

    IF v_user_id IS NOT NULL THEN
      DELETE FROM powersync_crew_turnovers
      WHERE user_id = v_user_id AND turnover_id = OLD.turnover_id;

      -- Only remove property if crew member has no other turnovers there
      IF v_property_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM turnover_assignments ta
        JOIN turnovers t ON t.id = ta.turnover_id
        JOIN crew_members cm ON cm.id = ta.crew_member_id
        WHERE cm.user_id = v_user_id
          AND t.property_id = v_property_id
          AND ta.turnover_id != OLD.turnover_id
      ) THEN
        DELETE FROM powersync_crew_properties
        WHERE user_id = v_user_id AND property_id = v_property_id;
      END IF;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_powersync_crew_on_instance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO powersync_crew_instances (user_id, instance_id)
    SELECT cm.user_id, NEW.id
    FROM turnover_assignments ta
    JOIN crew_members cm ON cm.id = ta.crew_member_id
    WHERE ta.turnover_id = NEW.turnover_id
    ON CONFLICT DO NOTHING;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM powersync_crew_instances WHERE instance_id = OLD.id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_wo_actual_cost()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wo_id      uuid;
  v_item_count integer;
  v_total      numeric(10,2);
BEGIN
  v_wo_id := COALESCE(NEW.work_order_id, OLD.work_order_id);
  SELECT COUNT(*), COALESCE(SUM(line_total), 0)
  INTO v_item_count, v_total
  FROM work_order_line_items
  WHERE work_order_id = v_wo_id;
  IF v_item_count > 0 THEN
    UPDATE work_orders SET actual_cost = v_total WHERE id = v_wo_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- =====================================================================
-- 7. TRIGGERS
-- =====================================================================

CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER checklist_instance_items_updated_at BEFORE UPDATE ON public.checklist_instance_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER checklist_instances_updated_at BEFORE UPDATE ON public.checklist_instances FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sync_crew_instance AFTER INSERT OR DELETE ON public.checklist_instances FOR EACH ROW EXECUTE FUNCTION sync_powersync_crew_on_instance();
CREATE TRIGGER checklist_templates_updated_at BEFORE UPDATE ON public.checklist_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crew_members_updated_at BEFORE UPDATE ON public.crew_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER guest_message_templates_updated_at BEFORE UPDATE ON public.guest_message_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ical_feeds_updated_at BEFORE UPDATE ON public.ical_feeds FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER inventory_items_updated_at BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER maintenance_schedules_updated_at BEFORE UPDATE ON public.maintenance_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER org_master_checklist_items_updated_at BEFORE UPDATE ON public.org_master_checklist_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER org_master_maintenance_updated_at BEFORE UPDATE ON public.org_master_maintenance_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER owner_transactions_updated_at BEFORE UPDATE ON public.owner_transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER properties_updated_at BEFORE UPDATE ON public.properties FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER purchase_orders_updated_at BEFORE UPDATE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sync_crew_assignment AFTER INSERT OR DELETE ON public.turnover_assignments FOR EACH ROW EXECUTE FUNCTION sync_powersync_crew_on_assignment();
CREATE TRIGGER turnovers_updated_at BEFORE UPDATE ON public.turnovers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER vendors_updated_at BEFORE UPDATE ON public.vendors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sync_wo_cost_on_line_items AFTER INSERT OR DELETE OR UPDATE ON public.work_order_line_items FOR EACH ROW EXECUTE FUNCTION sync_wo_actual_cost();
CREATE TRIGGER work_orders_assign_number BEFORE INSERT ON public.work_orders FOR EACH ROW EXECUTE FUNCTION assign_wo_number();
CREATE TRIGGER work_orders_updated_at BEFORE UPDATE ON public.work_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 8. VIEWS
-- =====================================================================

CREATE OR REPLACE VIEW public.vendor_compliance_status AS
 SELECT v.id AS vendor_id,
    v.org_id,
    v.name AS vendor_name,
    v.lat,
    v.lng,
    v.service_zip,
    v.service_radius_miles,
    count(d.id) FILTER (WHERE ((d.expiry_date >= CURRENT_DATE) AND (d.is_active = true))) AS active_doc_count,
    count(d.id) FILTER (WHERE ((d.expiry_date < CURRENT_DATE) AND (d.is_active = true))) AS expired_doc_count,
    count(d.id) FILTER (WHERE (((d.expiry_date >= CURRENT_DATE) AND (d.expiry_date <= (CURRENT_DATE + 30))) AND (d.is_active = true))) AS expiring_soon_count,
    min(d.expiry_date) FILTER (WHERE ((d.expiry_date < CURRENT_DATE) AND (d.is_active = true))) AS earliest_expired_date,
        CASE
            WHEN (min(d.expiry_date) FILTER (WHERE ((d.expiry_date < CURRENT_DATE) AND (d.is_active = true))) IS NOT NULL) THEN (CURRENT_DATE - min(d.expiry_date) FILTER (WHERE ((d.expiry_date < CURRENT_DATE) AND (d.is_active = true))))
            ELSE NULL::integer
        END AS days_past_expiry,
        CASE
            WHEN (count(d.id) = 0) THEN 'no_documents'::text
            WHEN (count(d.id) FILTER (WHERE ((d.expiry_date < (CURRENT_DATE - 30)) AND (d.is_active = true))) > 0) THEN 'hard_blocked'::text
            WHEN (count(d.id) FILTER (WHERE ((d.expiry_date < CURRENT_DATE) AND (d.is_active = true))) > 0) THEN 'grace_period'::text
            WHEN (count(d.id) FILTER (WHERE (((d.expiry_date >= CURRENT_DATE) AND (d.expiry_date <= (CURRENT_DATE + 30))) AND (d.is_active = true))) > 0) THEN 'expiring_soon'::text
            ELSE 'compliant'::text
        END AS compliance_status
   FROM (vendors v
     LEFT JOIN vendor_compliance_documents d ON ((d.vendor_id = v.id)))
  GROUP BY v.id, v.org_id, v.name, v.lat, v.lng, v.service_zip, v.service_radius_miles;

-- =====================================================================
-- 9. ROW LEVEL SECURITY — ENABLE (all 62 tables)
-- =====================================================================

ALTER TABLE public.asset_depreciation_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_type_standards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignment_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_instance_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_template_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crew_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crew_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_messages_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ical_feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_count_draft_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_count_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_count_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_schedule_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_schedule_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_master_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_master_maintenance_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_portal_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.powersync_crew_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.powersync_crew_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.powersync_crew_turnovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_processed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turnover_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turnovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_compliance_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wo_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_order_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_order_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_order_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_orders ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- 10. ROW LEVEL SECURITY — POLICIES (~85)
-- =====================================================================

CREATE POLICY depreciation_manage ON public.asset_depreciation_entries FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY depreciation_select ON public.asset_depreciation_entries FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY asset_type_standards_no_delete ON public.asset_type_standards FOR DELETE TO public
  USING (false);

CREATE POLICY asset_type_standards_no_insert ON public.asset_type_standards FOR INSERT TO public
  WITH CHECK (false);

CREATE POLICY asset_type_standards_no_update ON public.asset_type_standards FOR UPDATE TO public
  USING (false);

CREATE POLICY asset_type_standards_select ON public.asset_type_standards FOR SELECT TO public
  USING ((auth.role() = 'authenticated'::text));

CREATE POLICY assignment_outcomes_manage ON public.assignment_outcomes FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY assignment_outcomes_select ON public.assignment_outcomes FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY audit_events_select ON public.audit_events FOR SELECT TO public
  USING (((org_id IS NOT NULL) AND is_org_member(org_id, ARRAY['owner'::member_role])));

CREATE POLICY bookings_manage ON public.bookings FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY bookings_select ON public.bookings FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY instance_items_crew_update ON public.checklist_instance_items FOR UPDATE TO public
  USING ((instance_id IN ( SELECT ci.id
   FROM ((checklist_instances ci
     JOIN turnover_assignments ta ON ((ci.turnover_id = ta.turnover_id)))
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = auth.uid()))));

CREATE POLICY instance_items_manage ON public.checklist_instance_items FOR ALL TO public
  USING ((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));

CREATE POLICY instance_items_select ON public.checklist_instance_items FOR SELECT TO public
  USING ((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE (checklist_instances.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))));

CREATE POLICY checklist_instances_crew_select ON public.checklist_instances FOR SELECT TO public
  USING ((turnover_id IN ( SELECT ta.turnover_id
   FROM (turnover_assignments ta
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = auth.uid()))));

CREATE POLICY checklist_instances_manage ON public.checklist_instances FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY checklist_instances_select ON public.checklist_instances FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY template_items_manage ON public.checklist_template_items FOR ALL TO public
  USING ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));

CREATE POLICY template_items_select ON public.checklist_template_items FOR SELECT TO public
  USING ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE (checklist_templates.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))));

CREATE POLICY template_sections_manage ON public.checklist_template_sections FOR ALL TO public
  USING ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));

CREATE POLICY template_sections_select ON public.checklist_template_sections FOR SELECT TO public
  USING ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE (checklist_templates.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))));

CREATE POLICY checklist_templates_manage ON public.checklist_templates FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY checklist_templates_select ON public.checklist_templates FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY comm_logs_manage ON public.communication_logs FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY comm_logs_select ON public.communication_logs FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY crew_availability_manage ON public.crew_availability FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY crew_availability_select ON public.crew_availability FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY crew_availability_self_manage ON public.crew_availability FOR ALL TO public
  USING ((crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))))
  WITH CHECK ((crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))));

CREATE POLICY crew_manage ON public.crew_members FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY crew_select ON public.crew_members FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY crew_view_own ON public.crew_members FOR SELECT TO public
  USING ((user_id = auth.uid()));

CREATE POLICY message_templates_manage ON public.guest_message_templates FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY messages_sent_select ON public.guest_messages_sent FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY ical_feeds_manage ON public.ical_feeds FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY users_view_own_connections ON public.integration_connections FOR SELECT TO public
  USING ((auth.uid() = user_id));

CREATE POLICY "Anyone can read active providers" ON public.integration_providers FOR SELECT TO public
  USING ((is_active = true));

CREATE POLICY inventory_catalog_read ON public.inventory_catalog FOR SELECT TO public
  USING (true);

CREATE POLICY draft_items_insert ON public.inventory_count_draft_items FOR INSERT TO public
  WITH CHECK ((draft_id IN ( SELECT inventory_count_drafts.id
   FROM inventory_count_drafts
  WHERE (inventory_count_drafts.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))));

CREATE POLICY draft_items_select ON public.inventory_count_draft_items FOR SELECT TO public
  USING ((draft_id IN ( SELECT inventory_count_drafts.id
   FROM inventory_count_drafts
  WHERE (inventory_count_drafts.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))));

CREATE POLICY icdi_manage ON public.inventory_count_draft_items FOR ALL TO public
  USING ((draft_id IN ( SELECT d.id
   FROM inventory_count_drafts d
  WHERE is_org_member(d.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
  WITH CHECK ((draft_id IN ( SELECT d.id
   FROM inventory_count_drafts d
  WHERE is_org_member(d.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));

CREATE POLICY icdi_select ON public.inventory_count_draft_items FOR SELECT TO public
  USING ((draft_id IN ( SELECT inventory_count_drafts.id
   FROM inventory_count_drafts
  WHERE (inventory_count_drafts.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))));

CREATE POLICY drafts_insert ON public.inventory_count_drafts FOR INSERT TO public
  WITH CHECK ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY drafts_manage ON public.inventory_count_drafts FOR UPDATE TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY drafts_select ON public.inventory_count_drafts FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY icd_manage ON public.inventory_count_drafts FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY icd_select ON public.inventory_count_drafts FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY count_items_crew_insert ON public.inventory_count_items FOR INSERT TO public
  WITH CHECK ((count_id IN ( SELECT ic.id
   FROM (inventory_counts ic
     JOIN crew_members cm ON ((ic.submitted_by_crew_id = cm.id)))
  WHERE (cm.user_id = auth.uid()))));

CREATE POLICY count_items_select ON public.inventory_count_items FOR SELECT TO public
  USING ((count_id IN ( SELECT inventory_counts.id
   FROM inventory_counts
  WHERE (inventory_counts.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))));

CREATE POLICY inventory_counts_crew_insert ON public.inventory_counts FOR INSERT TO public
  WITH CHECK ((submitted_by_crew_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))));

CREATE POLICY inventory_counts_select ON public.inventory_counts FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY inventory_items_crew_select ON public.inventory_items FOR SELECT TO public
  USING ((property_id IN ( SELECT DISTINCT t.property_id
   FROM ((turnovers t
     JOIN turnover_assignments ta ON ((ta.turnover_id = t.id)))
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = auth.uid()))));

CREATE POLICY inventory_items_manage ON public.inventory_items FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY inventory_items_select ON public.inventory_items FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY "org members can insert inventory items" ON public.inventory_items FOR INSERT TO public
  WITH CHECK ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY "org members can manage inventory template items" ON public.inventory_template_items FOR ALL TO public
  USING ((template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE (inventory_templates.org_id IN ( SELECT organization_members.org_id
           FROM organization_members
          WHERE (organization_members.user_id = auth.uid()))))));

CREATE POLICY "org members can manage inventory templates" ON public.inventory_templates FOR ALL TO public
  USING ((org_id IN ( SELECT organization_members.org_id
   FROM organization_members
  WHERE (organization_members.user_id = auth.uid()))));

CREATE POLICY msti_manage ON public.maintenance_schedule_template_items FOR ALL TO public
  USING ((template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false)))))
  WITH CHECK ((template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false)))));

CREATE POLICY msti_select ON public.maintenance_schedule_template_items FOR SELECT TO public
  USING ((template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE ((maintenance_schedule_templates.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (maintenance_schedule_templates.is_system = true)))));

CREATE POLICY mst_manage ON public.maintenance_schedule_templates FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY mst_select ON public.maintenance_schedule_templates FOR SELECT TO public
  USING (((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (is_system = true)));

CREATE POLICY maintenance_manage ON public.maintenance_schedules FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY maintenance_select ON public.maintenance_schedules FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY messages_insert ON public.messages FOR INSERT TO public
  WITH CHECK (((sender_id = auth.uid()) AND ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (org_id IN ( SELECT crew_members.org_id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))))));

CREATE POLICY messages_mark_read ON public.messages FOR UPDATE TO public
  USING ((recipient_id = auth.uid()))
  WITH CHECK ((recipient_id = auth.uid()));

CREATE POLICY messages_select ON public.messages FOR SELECT TO public
  USING (((sender_id = auth.uid()) OR (recipient_id = auth.uid())));

CREATE POLICY "Owners can manage org invites" ON public.org_invites FOR ALL TO public
  USING ((org_id IN ( SELECT organization_members.org_id
   FROM organization_members
  WHERE ((organization_members.user_id = auth.uid()) AND (organization_members.role = 'owner'::member_role)))));

CREATE POLICY "Admins and managers manage master checklist" ON public.org_master_checklist_items FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

CREATE POLICY "Admins managers owners manage master maintenance" ON public.org_master_maintenance_schedules FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

CREATE POLICY org_milestones_manage ON public.org_milestones FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

CREATE POLICY org_milestones_select ON public.org_milestones FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY org_members_admin_delete ON public.organization_members FOR DELETE TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role]));

CREATE POLICY org_members_admin_manage ON public.organization_members FOR UPDATE TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role]));

CREATE POLICY org_members_insert_self ON public.organization_members FOR INSERT TO public
  WITH CHECK ((user_id = auth.uid()));

CREATE POLICY org_members_select ON public.organization_members FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY orgs_insert ON public.organizations FOR INSERT TO public
  WITH CHECK ((auth.uid() IS NOT NULL));

CREATE POLICY orgs_select ON public.organizations FOR SELECT TO public
  USING ((id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY orgs_update ON public.organizations FOR UPDATE TO public
  USING (is_org_member(id, ARRAY['admin'::member_role]));

CREATE POLICY portal_tokens_manage ON public.owner_portal_tokens FOR ALL TO public
  USING ((property_owner_id IN ( SELECT property_owners.id
   FROM property_owners
  WHERE is_org_member(property_owners.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));

CREATE POLICY owner_transactions_manage ON public.owner_transactions FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY crew_select_own_instances ON public.powersync_crew_instances FOR SELECT TO public
  USING ((auth.uid() = user_id));

CREATE POLICY crew_select_own_properties ON public.powersync_crew_properties FOR SELECT TO public
  USING ((auth.uid() = user_id));

CREATE POLICY crew_select_own_turnovers ON public.powersync_crew_turnovers FOR SELECT TO public
  USING ((auth.uid() = user_id));

CREATE POLICY profiles_own ON public.profiles FOR ALL TO public
  USING ((id = auth.uid()));

CREATE POLICY properties_manage ON public.properties FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY properties_select ON public.properties FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY assets_manage ON public.property_assets FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY assets_select ON public.property_assets FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY "Admins managers owners manage property owners" ON public.property_owners FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

CREATE POLICY "org members can insert property owners" ON public.property_owners FOR INSERT TO public
  WITH CHECK ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY property_owners_manage ON public.property_owners FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY po_items_manage ON public.purchase_order_items FOR ALL TO public
  USING ((purchase_order_id IN ( SELECT purchase_orders.id
   FROM purchase_orders
  WHERE is_org_member(purchase_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));

CREATE POLICY purchase_orders_manage ON public.purchase_orders FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY "Crew members manage own push subscriptions" ON public.push_subscriptions FOR ALL TO public
  USING ((crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))));

CREATE POLICY "Admins and managers can manage quote requests" ON public.quote_requests FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY "Org members can view quote requests" ON public.quote_requests FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY quote_requests_insert ON public.quote_requests FOR INSERT TO public
  WITH CHECK ((org_id IN ( SELECT organization_members.org_id
   FROM organization_members
  WHERE (organization_members.user_id = auth.uid()))));

CREATE POLICY quote_requests_select ON public.quote_requests FOR SELECT TO public
  USING ((org_id IN ( SELECT organization_members.org_id
   FROM organization_members
  WHERE (organization_members.user_id = auth.uid()))));

CREATE POLICY quote_requests_update ON public.quote_requests FOR UPDATE TO public
  USING ((org_id IN ( SELECT organization_members.org_id
   FROM organization_members
  WHERE (organization_members.user_id = auth.uid()))));

CREATE POLICY review_responses_service_write ON public.review_responses FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]));

CREATE POLICY "Org members can read their reviews" ON public.reviews FOR SELECT TO public
  USING ((org_id IN ( SELECT organization_members.org_id
   FROM organization_members
  WHERE (organization_members.user_id = auth.uid()))));

CREATE POLICY reviews_service_write ON public.reviews FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]));

CREATE POLICY assignments_crew_select ON public.turnover_assignments FOR SELECT TO public
  USING ((crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))));

CREATE POLICY assignments_manage ON public.turnover_assignments FOR ALL TO public
  USING ((turnover_id IN ( SELECT turnovers.id
   FROM turnovers
  WHERE is_org_member(turnovers.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));

CREATE POLICY assignments_select ON public.turnover_assignments FOR SELECT TO public
  USING ((turnover_id IN ( SELECT turnovers.id
   FROM turnovers
  WHERE (turnovers.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))));

CREATE POLICY turnovers_crew_select ON public.turnovers FOR SELECT TO public
  USING ((id IN ( SELECT ta.turnover_id
   FROM (turnover_assignments ta
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = auth.uid()))));

CREATE POLICY turnovers_crew_update ON public.turnovers FOR UPDATE TO public
  USING ((id IN ( SELECT ta.turnover_id
   FROM (turnover_assignments ta
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = auth.uid()))));

CREATE POLICY turnovers_manage ON public.turnovers FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY turnovers_select ON public.turnovers FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY compliance_docs_manage ON public.vendor_compliance_documents FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY compliance_docs_select ON public.vendor_compliance_documents FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY vendors_manage ON public.vendors FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY vendors_select ON public.vendors FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY "Managers and above delete line items" ON public.work_order_line_items FOR DELETE TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY "Managers and above insert line items" ON public.work_order_line_items FOR INSERT TO public
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY "Members view org line items" ON public.work_order_line_items FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY wo_photos_manage ON public.work_order_photos FOR ALL TO public
  USING ((work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE is_org_member(work_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));

CREATE POLICY wo_photos_select ON public.work_order_photos FOR SELECT TO public
  USING ((work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE (work_orders.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))));

CREATE POLICY wo_updates_insert ON public.work_order_updates FOR INSERT TO public
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY wo_updates_select ON public.work_order_updates FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

CREATE POLICY work_orders_manage ON public.work_orders FOR ALL TO public
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY work_orders_select ON public.work_orders FOR SELECT TO public
  USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));

-- =====================================================================
-- END OF SCHEMA REFERENCE
-- =====================================================================
