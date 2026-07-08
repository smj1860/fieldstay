-- ─────────────────────────────────────────────────────────────────────────────
-- Baseline schema snapshot — Doc 1 / Item 1 (Post-Audit Verification Pass)
--
-- The live project (vpmznjktllhmmbfnxuvk) has 64+ tracked migrations applied
-- directly, but supabase/migrations/ only carried a handful of files before
-- this one — see "Database Migrations & Schema Drift" in CLAUDE.md. This
-- migration closes that gap for the 50 tables that had no corresponding
-- CREATE TABLE migration anywhere in this directory, by capturing their
-- live structure (columns, RLS enablement, constraints, indexes, policies,
-- and authenticated/anon grants) as of 2026-06-18.
--
-- Generated via Supabase MCP introspection against pg_attribute, pg_attrdef,
-- pg_constraint, pg_indexes, pg_policies, and information_schema.role_table_grants
-- — not hand-transcribed — to avoid copy errors across ~50 tables. Two columns
-- required special handling: work_order_line_items.line_total and
-- assignment_outcomes.duration_minutes are GENERATED ALWAYS ... STORED columns,
-- not plain DEFAULTs; both are rendered with the correct generation syntax below.
--
-- Every statement is idempotent (IF NOT EXISTS / guarded DO blocks / native
-- no-op semantics for ENABLE ROW LEVEL SECURITY and GRANT), so this migration
-- is a no-op against the live project (everything already exists there) and
-- a full bootstrap against a fresh empty project. Verified via a zero-cost
-- BEGIN; ... ROLLBACK; dry run against the live project rather than literally
-- standing up a separate fresh Supabase project, due to cost/credential
-- constraints in this session — disclosed here for transparency.
--
-- Tables intentionally excluded (already covered by an existing CREATE TABLE
-- migration elsewhere in this directory): repuguard/team-access tables from
-- 20260601000000_repuguard.sql and 20260602000000_team_access.sql.
--
-- NOT RECORDED IN LIVE MIGRATION HISTORY: verified via Supabase MCP
-- list_migrations on 2026-07-08 that this file's version is absent from
-- supabase_migrations.schema_migrations, consistent with every other table/
-- column/index/function/policy checked from this file existing live already
-- (as this migration's own idempotent design anticipates) — not a pending
-- change, just never recorded under this version.
-- ─────────────────────────────────────────────────────────────────────────────

-- ───────────────────────── Pass 1: CREATE TABLE ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid NOT NULL,
  full_name text,
  phone text,
  avatar_url text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  billing_email text,
  stripe_customer_id text,
  stripe_subscription_id text,
  plan org_plan DEFAULT 'starter'::org_plan NOT NULL,
  plan_status org_plan_status DEFAULT 'trialing'::org_plan_status NOT NULL,
  trial_ends_at timestamp with time zone,
  max_properties integer DEFAULT 5 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  repuguard_status text DEFAULT 'inactive'::text,
  repuguard_trial_start timestamp with time zone,
  repuguard_trial_end timestamp with time zone,
  repuguard_stripe_subscription_id text,
  repuguard_founding_member boolean DEFAULT false NOT NULL,
  onboarding_steps_completed jsonb DEFAULT '{}'::jsonb NOT NULL,
  auto_assign_mode text DEFAULT 'suggest'::text NOT NULL,
  auto_assign_enabled boolean DEFAULT true NOT NULL,
  preferred_retailer text DEFAULT 'walmart'::text,
  kroger_location_id text,
  kroger_location_name text,
  kroger_customer_token text,
  kroger_token_expires_at timestamp with time zone,
  kroger_refresh_token text,
  comms_log_retention_days smallint DEFAULT 365 NOT NULL,
  slack_webhook_url text
);

CREATE TABLE IF NOT EXISTS public.organization_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid,
  role member_role DEFAULT 'viewer'::member_role NOT NULL,
  invited_email text,
  invite_token uuid DEFAULT gen_random_uuid(),
  invite_accepted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.properties (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
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
  setup_steps_completed jsonb DEFAULT '{}'::jsonb NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  avg_nightly_rate numeric(10,2) DEFAULT NULL::numeric,
  external_id text,
  external_source text,
  access_instructions text,
  square_footage integer,
  cleaning_cost numeric(10,2),
  same_day_premium_pct numeric(5,2) DEFAULT 25.00,
  cleaning_cost_visible_to_owner boolean DEFAULT false NOT NULL,
  lat numeric(9,6),
  lng numeric(9,6)
);

CREATE TABLE IF NOT EXISTS public.property_owners (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  property_id uuid NOT NULL,
  name text NOT NULL,
  email text,
  phone text,
  revenue_share_pct numeric(5,2),
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.owner_portal_tokens (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  property_owner_id uuid NOT NULL,
  token uuid DEFAULT gen_random_uuid() NOT NULL,
  expires_at timestamp with time zone,
  last_accessed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  revoked_at timestamp with time zone,
  property_ids uuid[],
  is_multi boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ical_feeds (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  source ical_source DEFAULT 'other'::ical_source,
  last_synced_at timestamp with time zone,
  last_sync_status sync_status DEFAULT 'pending'::sync_status,
  last_sync_error text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.bookings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
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
  status booking_status DEFAULT 'confirmed'::booking_status NOT NULL,
  notes text,
  raw_ical_data jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  external_id text,
  external_source text
);

CREATE TABLE IF NOT EXISTS public.crew_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid,
  name text NOT NULL,
  email text,
  phone text,
  preferred_contact contact_pref DEFAULT 'email'::contact_pref,
  sms_carrier text,
  specialty text DEFAULT 'cleaning'::text,
  is_active boolean DEFAULT true NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  invite_token uuid DEFAULT gen_random_uuid(),
  invite_sent_at timestamp with time zone,
  invite_accepted_at timestamp with time zone,
  role crew_role DEFAULT 'general'::crew_role NOT NULL,
  home_lat numeric(9,6),
  home_lng numeric(9,6),
  reliability_score numeric(4,3) DEFAULT 1.0 NOT NULL,
  capacity_score numeric(4,3) DEFAULT 1.0 NOT NULL,
  home_zip text
);

CREATE TABLE IF NOT EXISTS public.vendors (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL,
  contact_name text,
  email text,
  phone text,
  specialty vendor_specialty DEFAULT 'general'::vendor_specialty,
  portal_enabled boolean DEFAULT false NOT NULL,
  notes text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  avg_rating numeric(3,2),
  rating_count integer DEFAULT 0 NOT NULL,
  lat numeric(9,6),
  lng numeric(9,6),
  service_zip text,
  service_radius_miles smallint DEFAULT 25,
  address text,
  city text,
  state text
);

CREATE TABLE IF NOT EXISTS public.checklist_templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  property_id uuid,
  name text NOT NULL,
  description text,
  is_default boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.checklist_template_sections (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  template_id uuid NOT NULL,
  name text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  requires_section_photo boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS public.checklist_template_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  section_id uuid NOT NULL,
  template_id uuid NOT NULL,
  task text NOT NULL,
  requires_photo boolean DEFAULT false NOT NULL,
  notes text,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.turnovers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  booking_id uuid,
  prev_booking_id uuid,
  checkout_datetime timestamp with time zone NOT NULL,
  checkin_datetime timestamp with time zone NOT NULL,
  window_minutes integer,
  status turnover_status DEFAULT 'pending_assignment'::turnover_status NOT NULL,
  priority priority_level DEFAULT 'medium'::priority_level NOT NULL,
  checklist_template_id uuid,
  notes text,
  completion_notes text,
  completed_at timestamp with time zone,
  auto_generated boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  started_at timestamp with time zone,
  suggested_crew_ids uuid[],
  suggestion_reasoning text,
  suggestion_status text,
  is_same_day_turnover boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS public.turnover_assignments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  turnover_id uuid NOT NULL,
  crew_member_id uuid NOT NULL,
  assigned_at timestamp with time zone DEFAULT now() NOT NULL,
  notified_at timestamp with time zone,
  notification_type contact_pref,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  user_id uuid,
  property_id uuid,
  org_id uuid
);

CREATE TABLE IF NOT EXISTS public.checklist_instances (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  turnover_id uuid NOT NULL,
  org_id uuid NOT NULL,
  template_id uuid,
  template_snapshot jsonb NOT NULL,
  status checklist_status DEFAULT 'not_started'::checklist_status NOT NULL,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  section_photo_path text
);

CREATE TABLE IF NOT EXISTS public.checklist_instance_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  instance_id uuid NOT NULL,
  section_name text NOT NULL,
  task text NOT NULL,
  requires_photo boolean DEFAULT false NOT NULL,
  notes text,
  sort_order integer DEFAULT 0 NOT NULL,
  is_completed boolean DEFAULT false NOT NULL,
  completed_at timestamp with time zone,
  completed_by_crew_id uuid,
  photo_storage_path text,
  crew_notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  is_section_final_item boolean DEFAULT false NOT NULL,
  turnover_id uuid
);

CREATE TABLE IF NOT EXISTS public.inventory_catalog (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  category inventory_category DEFAULT 'other'::inventory_category NOT NULL,
  default_unit text DEFAULT 'units'::text NOT NULL,
  description text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  catalog_item_id uuid,
  name text NOT NULL,
  category inventory_category DEFAULT 'other'::inventory_category NOT NULL,
  unit text DEFAULT 'units'::text NOT NULL,
  par_level integer DEFAULT 0 NOT NULL,
  current_quantity integer DEFAULT 0 NOT NULL,
  low_stock_threshold_pct integer DEFAULT 30 NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  preferred_brand text
);

CREATE TABLE IF NOT EXISTS public.inventory_counts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  submitted_by_crew_id uuid,
  submitted_at timestamp with time zone DEFAULT now() NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_count_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  count_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity_counted integer NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  status po_status DEFAULT 'draft'::po_status NOT NULL,
  generated_at timestamp with time zone DEFAULT now() NOT NULL,
  sent_at timestamp with time zone,
  acknowledged_at timestamp with time zone,
  notes text,
  total_estimated_cost numeric(10,2),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.purchase_order_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  purchase_order_id uuid NOT NULL,
  inventory_item_id uuid,
  item_name text NOT NULL,
  current_quantity integer NOT NULL,
  par_level integer NOT NULL,
  quantity_to_buy integer NOT NULL,
  estimated_unit_cost numeric(8,2),
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.work_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  vendor_id uuid,
  assigned_crew_id uuid,
  title text NOT NULL,
  description text,
  priority priority_level DEFAULT 'medium'::priority_level NOT NULL,
  status wo_status DEFAULT 'pending'::wo_status NOT NULL,
  source wo_source DEFAULT 'manual'::wo_source NOT NULL,
  source_schedule_id uuid,
  scheduled_date date,
  completed_date date,
  estimated_cost numeric(10,2),
  actual_cost numeric(10,2),
  portal_enabled boolean DEFAULT false NOT NULL,
  completion_token uuid,
  completion_token_expires_at timestamp with time zone,
  completion_notes text,
  invoice_reference text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
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
  source_turnover_id uuid,
  public_token text,
  public_token_expires_at timestamp with time zone,
  public_viewed_at timestamp with time zone,
  public_signed_off_at timestamp with time zone,
  sign_off_notes text,
  vendor_dispatch_email text,
  lockbox_code text,
  parking_notes text
);

CREATE TABLE IF NOT EXISTS public.work_order_updates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  work_order_id uuid NOT NULL,
  org_id uuid NOT NULL,
  updated_by_user_id uuid,
  updated_via_vendor_portal boolean DEFAULT false NOT NULL,
  status_from wo_status,
  status_to wo_status,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.work_order_photos (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  work_order_id uuid NOT NULL,
  storage_path text NOT NULL,
  uploaded_by text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.maintenance_schedules (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  assigned_vendor_id uuid,
  name text NOT NULL,
  description text,
  schedule_type schedule_type DEFAULT 'routine'::schedule_type NOT NULL,
  frequency schedule_frequency,
  month_due integer,
  day_of_month_due integer,
  estimated_cost numeric(10,2),
  instructions text,
  auto_create_wo boolean DEFAULT true NOT NULL,
  last_completed_date date,
  next_due_date date,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  vendor_specialty_hint vendor_specialty,
  active_from_month integer,
  active_to_month integer,
  asset_category text,
  is_from_standard_template boolean DEFAULT false NOT NULL,
  source_template_item_id uuid,
  source_catalog_item_id uuid
);

CREATE TABLE IF NOT EXISTS public.owner_transactions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  transaction_type txn_type NOT NULL,
  category txn_category DEFAULT 'other'::txn_category NOT NULL,
  amount numeric(10,2) NOT NULL,
  description text NOT NULL,
  transaction_date date NOT NULL,
  work_order_id uuid,
  purchase_order_id uuid,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  booking_id uuid,
  source text DEFAULT 'manual'::text,
  source_reference_id uuid,
  visible_to_owner boolean DEFAULT true NOT NULL
);

CREATE TABLE IF NOT EXISTS public.org_milestones (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  milestone text NOT NULL,
  achieved_at timestamp with time zone DEFAULT now() NOT NULL,
  prompted_at timestamp with time zone,
  review_clicked boolean DEFAULT false NOT NULL,
  dismissed boolean DEFAULT false NOT NULL,
  value jsonb
);

CREATE TABLE IF NOT EXISTS public.communication_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  recipient_type comm_recipient_type NOT NULL,
  vendor_id uuid,
  crew_member_id uuid,
  channel comm_channel DEFAULT 'email'::comm_channel NOT NULL,
  subject text,
  body text,
  property_id uuid,
  work_order_id uuid,
  source comm_source DEFAULT 'manual'::comm_source NOT NULL,
  logged_by_user_id uuid,
  communicated_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  crew_member_id uuid NOT NULL,
  org_id uuid NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.quote_requests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  work_order_id uuid NOT NULL,
  org_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  status quote_request_status DEFAULT 'pending'::quote_request_status NOT NULL,
  quote_token text NOT NULL,
  quote_token_expires_at timestamp with time zone NOT NULL,
  quoted_amount numeric(10,2),
  quote_notes text,
  sent_at timestamp with time zone DEFAULT now() NOT NULL,
  submitted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.integration_providers (
  id text NOT NULL,
  display_name text NOT NULL,
  auth_type text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.integration_connections (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  provider_id text NOT NULL,
  external_user_id text,
  vault_secret_id uuid,
  scope text,
  status text DEFAULT 'active'::text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  connected_at timestamp with time zone DEFAULT now() NOT NULL,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  refresh_token_vault_secret_id uuid,
  expires_at timestamp with time zone,
  org_id uuid
);

CREATE TABLE IF NOT EXISTS public.oauth_states (
  state text NOT NULL,
  user_id uuid,
  provider_id text NOT NULL,
  return_to text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone DEFAULT (now() + '00:10:00'::interval) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.wo_number_counters (
  org_id uuid NOT NULL,
  last_number integer DEFAULT 0 NOT NULL,
  current_year smallint DEFAULT (EXTRACT(year FROM now()))::smallint NOT NULL
);

CREATE TABLE IF NOT EXISTS public.work_order_line_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  work_order_id uuid NOT NULL,
  org_id uuid NOT NULL,
  line_type line_item_type DEFAULT 'material'::line_item_type NOT NULL,
  description text NOT NULL,
  quantity numeric(8,2) DEFAULT 1 NOT NULL,
  unit text,
  unit_cost numeric(10,2) NOT NULL,
  line_total numeric(10,2) GENERATED ALWAYS AS ((quantity * unit_cost)) STORED,
  sort_order smallint DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_template_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  template_id uuid NOT NULL,
  name text NOT NULL,
  category text,
  unit text,
  par_qty integer DEFAULT 0 NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  par_level numeric DEFAULT 1 NOT NULL,
  preferred_brand text,
  notes text,
  catalog_item_id uuid
);

CREATE TABLE IF NOT EXISTS public.org_master_checklist_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  section text NOT NULL,
  task text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  source text DEFAULT 'catalog'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.org_master_maintenance_schedules (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  frequency text DEFAULT 'monthly'::text NOT NULL,
  month_day integer,
  week_day integer,
  estimated_cost numeric(10,2),
  specialty text,
  notes text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.crew_availability (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  crew_member_id uuid NOT NULL,
  available_date date NOT NULL,
  is_available boolean DEFAULT true NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.assignment_outcomes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  turnover_id uuid NOT NULL,
  crew_member_id uuid NOT NULL,
  property_id uuid,
  suggested_score smallint,
  score_breakdown jsonb,
  was_suggestion boolean DEFAULT false NOT NULL,
  was_accepted boolean,
  override_reason text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  duration_minutes integer GENERATED ALWAYS AS (
CASE
    WHEN ((started_at IS NOT NULL) AND (completed_at IS NOT NULL) AND ((EXTRACT(epoch FROM (completed_at - started_at)) / (60)::numeric) <= (480)::numeric)) THEN (EXTRACT(epoch FROM (completed_at - started_at)) / (60)::numeric)
    ELSE NULL::numeric
END) STORED,
  pm_rating smallint,
  property_bedrooms smallint,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.asset_type_standards (
  asset_type asset_type NOT NULL,
  display_name text NOT NULL,
  lifespan_min_years smallint NOT NULL,
  lifespan_max_years smallint NOT NULL,
  avg_replacement_cost_low integer,
  avg_replacement_cost_high integer,
  macrs_class_default macrs_class DEFAULT '5_year'::macrs_class NOT NULL,
  vendor_specialty_default vendor_specialty,
  notes text
);

CREATE TABLE IF NOT EXISTS public.property_assets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
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
  is_active boolean DEFAULT true NOT NULL,
  replaced_by_asset_id uuid,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.vendor_compliance_documents (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
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
  is_verified boolean DEFAULT false NOT NULL,
  verification_notes text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  first_warned_at timestamp with time zone,
  hard_blocked_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.asset_depreciation_entries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  tax_year smallint NOT NULL,
  macrs_class macrs_class NOT NULL,
  cost_basis numeric(12,2) NOT NULL,
  prior_cumulative_depreciation numeric(12,2) DEFAULT 0 NOT NULL,
  current_year_depreciation numeric(12,2) NOT NULL,
  ending_adjusted_basis numeric(12,2) NOT NULL,
  depreciation_rate numeric(6,4),
  notes text,
  generated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.maintenance_schedule_templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  is_system boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.maintenance_schedule_template_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  template_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  schedule_frequency schedule_frequency NOT NULL,
  vendor_specialty_hint vendor_specialty,
  estimated_cost numeric(10,2),
  is_optional_flag text,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  asset_category text,
  active_from_month integer,
  active_to_month integer
);

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  content text NOT NULL,
  read_at timestamp with time zone,
  turnover_id uuid,
  work_order_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- ─────────────────── Pass 2: ENABLE ROW LEVEL SECURITY ───────────────────────

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_portal_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ical_feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crew_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_template_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turnovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turnover_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_instance_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_count_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_order_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_order_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wo_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_order_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_master_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_master_maintenance_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crew_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignment_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_type_standards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_compliance_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_depreciation_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_schedule_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_schedule_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- ───────────────────── Pass 3: ADD CONSTRAINT (guarded) ──────────────────────

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_pkey' AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_id_fkey' AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_pkey' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_slug_key' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_slug_key UNIQUE (slug);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_stripe_customer_id_key' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_stripe_customer_id_key UNIQUE (stripe_customer_id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_stripe_subscription_id_key' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_stripe_subscription_id_key UNIQUE (stripe_subscription_id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_auto_assign_mode_check' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_auto_assign_mode_check CHECK ((auto_assign_mode = ANY (ARRAY['suggest'::text, 'autopilot'::text, 'disabled'::text])));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_preferred_retailer_check' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_preferred_retailer_check CHECK ((preferred_retailer = ANY (ARRAY['walmart'::text, 'kroger'::text, 'amazon_business'::text, 'none'::text])));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_repuguard_status_check' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_repuguard_status_check CHECK ((repuguard_status = ANY (ARRAY['inactive'::text, 'trial'::text, 'active'::text, 'cancelled'::text])));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_pkey' AND conrelid = 'public.organization_members'::regclass
  ) THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_invite_token_key' AND conrelid = 'public.organization_members'::regclass
  ) THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_invite_token_key UNIQUE (invite_token);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_org_id_user_id_key' AND conrelid = 'public.organization_members'::regclass
  ) THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_org_id_user_id_key UNIQUE (org_id, user_id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_org_id_fkey' AND conrelid = 'public.organization_members'::regclass
  ) THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_user_id_fkey' AND conrelid = 'public.organization_members'::regclass
  ) THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'properties_pkey' AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties ADD CONSTRAINT properties_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_properties_external_id_source' AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties ADD CONSTRAINT uq_properties_external_id_source UNIQUE (external_id, external_source);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'properties_org_id_fkey' AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties ADD CONSTRAINT properties_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_owners_pkey' AND conrelid = 'public.property_owners'::regclass
  ) THEN
    ALTER TABLE public.property_owners ADD CONSTRAINT property_owners_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_owners_org_id_fkey' AND conrelid = 'public.property_owners'::regclass
  ) THEN
    ALTER TABLE public.property_owners ADD CONSTRAINT property_owners_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_owners_property_id_fkey' AND conrelid = 'public.property_owners'::regclass
  ) THEN
    ALTER TABLE public.property_owners ADD CONSTRAINT property_owners_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_portal_tokens_pkey' AND conrelid = 'public.owner_portal_tokens'::regclass
  ) THEN
    ALTER TABLE public.owner_portal_tokens ADD CONSTRAINT owner_portal_tokens_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_portal_tokens_owner_type_unique' AND conrelid = 'public.owner_portal_tokens'::regclass
  ) THEN
    ALTER TABLE public.owner_portal_tokens ADD CONSTRAINT owner_portal_tokens_owner_type_unique UNIQUE (property_owner_id, is_multi);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_portal_tokens_token_key' AND conrelid = 'public.owner_portal_tokens'::regclass
  ) THEN
    ALTER TABLE public.owner_portal_tokens ADD CONSTRAINT owner_portal_tokens_token_key UNIQUE (token);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_portal_tokens_property_owner_id_fkey' AND conrelid = 'public.owner_portal_tokens'::regclass
  ) THEN
    ALTER TABLE public.owner_portal_tokens ADD CONSTRAINT owner_portal_tokens_property_owner_id_fkey FOREIGN KEY (property_owner_id) REFERENCES property_owners(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ical_feeds_pkey' AND conrelid = 'public.ical_feeds'::regclass
  ) THEN
    ALTER TABLE public.ical_feeds ADD CONSTRAINT ical_feeds_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ical_feeds_org_id_fkey' AND conrelid = 'public.ical_feeds'::regclass
  ) THEN
    ALTER TABLE public.ical_feeds ADD CONSTRAINT ical_feeds_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ical_feeds_property_id_fkey' AND conrelid = 'public.ical_feeds'::regclass
  ) THEN
    ALTER TABLE public.ical_feeds ADD CONSTRAINT ical_feeds_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ical_feeds_url_must_be_https' AND conrelid = 'public.ical_feeds'::regclass
  ) THEN
    ALTER TABLE public.ical_feeds ADD CONSTRAINT ical_feeds_url_must_be_https CHECK ((url ~~ 'https://%'::text));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_pkey' AND conrelid = 'public.bookings'::regclass
  ) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_ical_feed_id_ical_uid_key' AND conrelid = 'public.bookings'::regclass
  ) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_ical_feed_id_ical_uid_key UNIQUE (ical_feed_id, ical_uid);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_ical_feed_id_fkey' AND conrelid = 'public.bookings'::regclass
  ) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_ical_feed_id_fkey FOREIGN KEY (ical_feed_id) REFERENCES ical_feeds(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_org_id_fkey' AND conrelid = 'public.bookings'::regclass
  ) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_property_id_fkey' AND conrelid = 'public.bookings'::regclass
  ) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crew_members_pkey' AND conrelid = 'public.crew_members'::regclass
  ) THEN
    ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crew_members_invite_token_key' AND conrelid = 'public.crew_members'::regclass
  ) THEN
    ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_invite_token_key UNIQUE (invite_token);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crew_members_org_id_fkey' AND conrelid = 'public.crew_members'::regclass
  ) THEN
    ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crew_members_user_id_fkey' AND conrelid = 'public.crew_members'::regclass
  ) THEN
    ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crew_members_capacity_score_check' AND conrelid = 'public.crew_members'::regclass
  ) THEN
    ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_capacity_score_check CHECK (((capacity_score >= (0)::numeric) AND (capacity_score <= (1)::numeric)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crew_members_reliability_score_check' AND conrelid = 'public.crew_members'::regclass
  ) THEN
    ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_reliability_score_check CHECK (((reliability_score >= (0)::numeric) AND (reliability_score <= (1)::numeric)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendors_pkey' AND conrelid = 'public.vendors'::regclass
  ) THEN
    ALTER TABLE public.vendors ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendors_org_id_fkey' AND conrelid = 'public.vendors'::regclass
  ) THEN
    ALTER TABLE public.vendors ADD CONSTRAINT vendors_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_templates_pkey' AND conrelid = 'public.checklist_templates'::regclass
  ) THEN
    ALTER TABLE public.checklist_templates ADD CONSTRAINT checklist_templates_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_templates_org_id_fkey' AND conrelid = 'public.checklist_templates'::regclass
  ) THEN
    ALTER TABLE public.checklist_templates ADD CONSTRAINT checklist_templates_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_templates_property_id_fkey' AND conrelid = 'public.checklist_templates'::regclass
  ) THEN
    ALTER TABLE public.checklist_templates ADD CONSTRAINT checklist_templates_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_template_sections_pkey' AND conrelid = 'public.checklist_template_sections'::regclass
  ) THEN
    ALTER TABLE public.checklist_template_sections ADD CONSTRAINT checklist_template_sections_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_template_sections_template_id_fkey' AND conrelid = 'public.checklist_template_sections'::regclass
  ) THEN
    ALTER TABLE public.checklist_template_sections ADD CONSTRAINT checklist_template_sections_template_id_fkey FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_template_items_pkey' AND conrelid = 'public.checklist_template_items'::regclass
  ) THEN
    ALTER TABLE public.checklist_template_items ADD CONSTRAINT checklist_template_items_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_template_items_section_id_fkey' AND conrelid = 'public.checklist_template_items'::regclass
  ) THEN
    ALTER TABLE public.checklist_template_items ADD CONSTRAINT checklist_template_items_section_id_fkey FOREIGN KEY (section_id) REFERENCES checklist_template_sections(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_template_items_template_id_fkey' AND conrelid = 'public.checklist_template_items'::regclass
  ) THEN
    ALTER TABLE public.checklist_template_items ADD CONSTRAINT checklist_template_items_template_id_fkey FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnovers_pkey' AND conrelid = 'public.turnovers'::regclass
  ) THEN
    ALTER TABLE public.turnovers ADD CONSTRAINT turnovers_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnovers_booking_id_fkey' AND conrelid = 'public.turnovers'::regclass
  ) THEN
    ALTER TABLE public.turnovers ADD CONSTRAINT turnovers_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnovers_checklist_template_id_fkey' AND conrelid = 'public.turnovers'::regclass
  ) THEN
    ALTER TABLE public.turnovers ADD CONSTRAINT turnovers_checklist_template_id_fkey FOREIGN KEY (checklist_template_id) REFERENCES checklist_templates(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnovers_org_id_fkey' AND conrelid = 'public.turnovers'::regclass
  ) THEN
    ALTER TABLE public.turnovers ADD CONSTRAINT turnovers_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnovers_prev_booking_id_fkey' AND conrelid = 'public.turnovers'::regclass
  ) THEN
    ALTER TABLE public.turnovers ADD CONSTRAINT turnovers_prev_booking_id_fkey FOREIGN KEY (prev_booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnovers_property_id_fkey' AND conrelid = 'public.turnovers'::regclass
  ) THEN
    ALTER TABLE public.turnovers ADD CONSTRAINT turnovers_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnovers_suggestion_status_check' AND conrelid = 'public.turnovers'::regclass
  ) THEN
    ALTER TABLE public.turnovers ADD CONSTRAINT turnovers_suggestion_status_check CHECK (((suggestion_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'overridden'::text, 'dismissed'::text])) OR (suggestion_status IS NULL)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnover_assignments_pkey' AND conrelid = 'public.turnover_assignments'::regclass
  ) THEN
    ALTER TABLE public.turnover_assignments ADD CONSTRAINT turnover_assignments_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnover_assignments_crew_unique' AND conrelid = 'public.turnover_assignments'::regclass
  ) THEN
    ALTER TABLE public.turnover_assignments ADD CONSTRAINT turnover_assignments_crew_unique UNIQUE (turnover_id, crew_member_id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnover_assignments_crew_member_id_fkey' AND conrelid = 'public.turnover_assignments'::regclass
  ) THEN
    ALTER TABLE public.turnover_assignments ADD CONSTRAINT turnover_assignments_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnover_assignments_org_id_fkey' AND conrelid = 'public.turnover_assignments'::regclass
  ) THEN
    ALTER TABLE public.turnover_assignments ADD CONSTRAINT turnover_assignments_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnover_assignments_property_id_fkey' AND conrelid = 'public.turnover_assignments'::regclass
  ) THEN
    ALTER TABLE public.turnover_assignments ADD CONSTRAINT turnover_assignments_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnover_assignments_turnover_id_fkey' AND conrelid = 'public.turnover_assignments'::regclass
  ) THEN
    ALTER TABLE public.turnover_assignments ADD CONSTRAINT turnover_assignments_turnover_id_fkey FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnover_assignments_user_id_fkey' AND conrelid = 'public.turnover_assignments'::regclass
  ) THEN
    ALTER TABLE public.turnover_assignments ADD CONSTRAINT turnover_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_instances_pkey' AND conrelid = 'public.checklist_instances'::regclass
  ) THEN
    ALTER TABLE public.checklist_instances ADD CONSTRAINT checklist_instances_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_instances_org_id_fkey' AND conrelid = 'public.checklist_instances'::regclass
  ) THEN
    ALTER TABLE public.checklist_instances ADD CONSTRAINT checklist_instances_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_instances_template_id_fkey' AND conrelid = 'public.checklist_instances'::regclass
  ) THEN
    ALTER TABLE public.checklist_instances ADD CONSTRAINT checklist_instances_template_id_fkey FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_instances_turnover_id_fkey' AND conrelid = 'public.checklist_instances'::regclass
  ) THEN
    ALTER TABLE public.checklist_instances ADD CONSTRAINT checklist_instances_turnover_id_fkey FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_instance_items_pkey' AND conrelid = 'public.checklist_instance_items'::regclass
  ) THEN
    ALTER TABLE public.checklist_instance_items ADD CONSTRAINT checklist_instance_items_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_instance_items_completed_by_crew_id_fkey' AND conrelid = 'public.checklist_instance_items'::regclass
  ) THEN
    ALTER TABLE public.checklist_instance_items ADD CONSTRAINT checklist_instance_items_completed_by_crew_id_fkey FOREIGN KEY (completed_by_crew_id) REFERENCES crew_members(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_instance_items_instance_id_fkey' AND conrelid = 'public.checklist_instance_items'::regclass
  ) THEN
    ALTER TABLE public.checklist_instance_items ADD CONSTRAINT checklist_instance_items_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES checklist_instances(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checklist_instance_items_turnover_id_fkey' AND conrelid = 'public.checklist_instance_items'::regclass
  ) THEN
    ALTER TABLE public.checklist_instance_items ADD CONSTRAINT checklist_instance_items_turnover_id_fkey FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_catalog_pkey' AND conrelid = 'public.inventory_catalog'::regclass
  ) THEN
    ALTER TABLE public.inventory_catalog ADD CONSTRAINT inventory_catalog_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_pkey' AND conrelid = 'public.inventory_items'::regclass
  ) THEN
    ALTER TABLE public.inventory_items ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_catalog_item_id_fkey' AND conrelid = 'public.inventory_items'::regclass
  ) THEN
    ALTER TABLE public.inventory_items ADD CONSTRAINT inventory_items_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES inventory_catalog(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_org_id_fkey' AND conrelid = 'public.inventory_items'::regclass
  ) THEN
    ALTER TABLE public.inventory_items ADD CONSTRAINT inventory_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_property_id_fkey' AND conrelid = 'public.inventory_items'::regclass
  ) THEN
    ALTER TABLE public.inventory_items ADD CONSTRAINT inventory_items_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_counts_pkey' AND conrelid = 'public.inventory_counts'::regclass
  ) THEN
    ALTER TABLE public.inventory_counts ADD CONSTRAINT inventory_counts_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_counts_org_id_fkey' AND conrelid = 'public.inventory_counts'::regclass
  ) THEN
    ALTER TABLE public.inventory_counts ADD CONSTRAINT inventory_counts_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_counts_property_id_fkey' AND conrelid = 'public.inventory_counts'::regclass
  ) THEN
    ALTER TABLE public.inventory_counts ADD CONSTRAINT inventory_counts_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_counts_submitted_by_crew_id_fkey' AND conrelid = 'public.inventory_counts'::regclass
  ) THEN
    ALTER TABLE public.inventory_counts ADD CONSTRAINT inventory_counts_submitted_by_crew_id_fkey FOREIGN KEY (submitted_by_crew_id) REFERENCES crew_members(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_count_items_pkey' AND conrelid = 'public.inventory_count_items'::regclass
  ) THEN
    ALTER TABLE public.inventory_count_items ADD CONSTRAINT inventory_count_items_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_count_items_count_id_fkey' AND conrelid = 'public.inventory_count_items'::regclass
  ) THEN
    ALTER TABLE public.inventory_count_items ADD CONSTRAINT inventory_count_items_count_id_fkey FOREIGN KEY (count_id) REFERENCES inventory_counts(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_count_items_inventory_item_id_fkey' AND conrelid = 'public.inventory_count_items'::regclass
  ) THEN
    ALTER TABLE public.inventory_count_items ADD CONSTRAINT inventory_count_items_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_pkey' AND conrelid = 'public.purchase_orders'::regclass
  ) THEN
    ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_org_id_fkey' AND conrelid = 'public.purchase_orders'::regclass
  ) THEN
    ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_property_id_fkey' AND conrelid = 'public.purchase_orders'::regclass
  ) THEN
    ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_order_items_pkey' AND conrelid = 'public.purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.purchase_order_items ADD CONSTRAINT purchase_order_items_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_order_items_inventory_item_id_fkey' AND conrelid = 'public.purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.purchase_order_items ADD CONSTRAINT purchase_order_items_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_order_items_purchase_order_id_fkey' AND conrelid = 'public.purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.purchase_order_items ADD CONSTRAINT purchase_order_items_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_pkey' AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_asset_id_fkey' AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES property_assets(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_assigned_crew_id_fkey' AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_assigned_crew_id_fkey FOREIGN KEY (assigned_crew_id) REFERENCES crew_members(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_assigned_crew_member_id_fkey' AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_assigned_crew_member_id_fkey FOREIGN KEY (assigned_crew_member_id) REFERENCES crew_members(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_completion_verified_by_fkey' AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_completion_verified_by_fkey FOREIGN KEY (completion_verified_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_org_id_fkey' AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_property_id_fkey' AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_source_turnover_id_fkey' AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_source_turnover_id_fkey FOREIGN KEY (source_turnover_id) REFERENCES turnovers(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_vendor_acknowledged_by_fkey' AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_vendor_acknowledged_by_fkey FOREIGN KEY (vendor_acknowledged_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_vendor_id_fkey' AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_vendor_rating_check' AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_vendor_rating_check CHECK (((vendor_rating >= 1) AND (vendor_rating <= 5)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_order_updates_pkey' AND conrelid = 'public.work_order_updates'::regclass
  ) THEN
    ALTER TABLE public.work_order_updates ADD CONSTRAINT work_order_updates_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_order_updates_org_id_fkey' AND conrelid = 'public.work_order_updates'::regclass
  ) THEN
    ALTER TABLE public.work_order_updates ADD CONSTRAINT work_order_updates_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_order_updates_updated_by_user_id_fkey' AND conrelid = 'public.work_order_updates'::regclass
  ) THEN
    ALTER TABLE public.work_order_updates ADD CONSTRAINT work_order_updates_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_order_updates_work_order_id_fkey' AND conrelid = 'public.work_order_updates'::regclass
  ) THEN
    ALTER TABLE public.work_order_updates ADD CONSTRAINT work_order_updates_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_order_photos_pkey' AND conrelid = 'public.work_order_photos'::regclass
  ) THEN
    ALTER TABLE public.work_order_photos ADD CONSTRAINT work_order_photos_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_order_photos_work_order_id_fkey' AND conrelid = 'public.work_order_photos'::regclass
  ) THEN
    ALTER TABLE public.work_order_photos ADD CONSTRAINT work_order_photos_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedules_pkey' AND conrelid = 'public.maintenance_schedules'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedules_assigned_vendor_id_fkey' AND conrelid = 'public.maintenance_schedules'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_assigned_vendor_id_fkey FOREIGN KEY (assigned_vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedules_org_id_fkey' AND conrelid = 'public.maintenance_schedules'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedules_property_id_fkey' AND conrelid = 'public.maintenance_schedules'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedules_source_template_item_id_fkey' AND conrelid = 'public.maintenance_schedules'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_source_template_item_id_fkey FOREIGN KEY (source_template_item_id) REFERENCES maintenance_schedule_template_items(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedules_active_from_month_check' AND conrelid = 'public.maintenance_schedules'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_active_from_month_check CHECK (((active_from_month >= 1) AND (active_from_month <= 12)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedules_active_to_month_check' AND conrelid = 'public.maintenance_schedules'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_active_to_month_check CHECK (((active_to_month >= 1) AND (active_to_month <= 12)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedules_day_of_month_due_check' AND conrelid = 'public.maintenance_schedules'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_day_of_month_due_check CHECK (((day_of_month_due >= 1) AND (day_of_month_due <= 31)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedules_month_due_check' AND conrelid = 'public.maintenance_schedules'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedules ADD CONSTRAINT maintenance_schedules_month_due_check CHECK (((month_due >= 1) AND (month_due <= 12)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_transactions_pkey' AND conrelid = 'public.owner_transactions'::regclass
  ) THEN
    ALTER TABLE public.owner_transactions ADD CONSTRAINT owner_transactions_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_transactions_source_ref_unique' AND conrelid = 'public.owner_transactions'::regclass
  ) THEN
    ALTER TABLE public.owner_transactions ADD CONSTRAINT owner_transactions_source_ref_unique UNIQUE (source_reference_id, source);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_owner_txn_source' AND conrelid = 'public.owner_transactions'::regclass
  ) THEN
    ALTER TABLE public.owner_transactions ADD CONSTRAINT uq_owner_txn_source UNIQUE (source_reference_id, source);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_transactions_booking_id_fkey' AND conrelid = 'public.owner_transactions'::regclass
  ) THEN
    ALTER TABLE public.owner_transactions ADD CONSTRAINT owner_transactions_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_transactions_org_id_fkey' AND conrelid = 'public.owner_transactions'::regclass
  ) THEN
    ALTER TABLE public.owner_transactions ADD CONSTRAINT owner_transactions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_transactions_property_id_fkey' AND conrelid = 'public.owner_transactions'::regclass
  ) THEN
    ALTER TABLE public.owner_transactions ADD CONSTRAINT owner_transactions_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_transactions_purchase_order_id_fkey' AND conrelid = 'public.owner_transactions'::regclass
  ) THEN
    ALTER TABLE public.owner_transactions ADD CONSTRAINT owner_transactions_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_transactions_work_order_id_fkey' AND conrelid = 'public.owner_transactions'::regclass
  ) THEN
    ALTER TABLE public.owner_transactions ADD CONSTRAINT owner_transactions_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_transactions_source_check' AND conrelid = 'public.owner_transactions'::regclass
  ) THEN
    ALTER TABLE public.owner_transactions ADD CONSTRAINT owner_transactions_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'wo_completion'::text, 'booking_revenue'::text, 'uplisting_booking'::text, 'inventory_purchase'::text, 'cleaning_fee'::text, 'booking_cancellation'::text])));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_milestones_pkey' AND conrelid = 'public.org_milestones'::regclass
  ) THEN
    ALTER TABLE public.org_milestones ADD CONSTRAINT org_milestones_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_milestones_org_id_milestone_key' AND conrelid = 'public.org_milestones'::regclass
  ) THEN
    ALTER TABLE public.org_milestones ADD CONSTRAINT org_milestones_org_id_milestone_key UNIQUE (org_id, milestone);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_milestones_org_id_fkey' AND conrelid = 'public.org_milestones'::regclass
  ) THEN
    ALTER TABLE public.org_milestones ADD CONSTRAINT org_milestones_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'communication_logs_pkey' AND conrelid = 'public.communication_logs'::regclass
  ) THEN
    ALTER TABLE public.communication_logs ADD CONSTRAINT communication_logs_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'communication_logs_crew_member_id_fkey' AND conrelid = 'public.communication_logs'::regclass
  ) THEN
    ALTER TABLE public.communication_logs ADD CONSTRAINT communication_logs_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'communication_logs_logged_by_user_id_fkey' AND conrelid = 'public.communication_logs'::regclass
  ) THEN
    ALTER TABLE public.communication_logs ADD CONSTRAINT communication_logs_logged_by_user_id_fkey FOREIGN KEY (logged_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'communication_logs_org_id_fkey' AND conrelid = 'public.communication_logs'::regclass
  ) THEN
    ALTER TABLE public.communication_logs ADD CONSTRAINT communication_logs_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'communication_logs_property_id_fkey' AND conrelid = 'public.communication_logs'::regclass
  ) THEN
    ALTER TABLE public.communication_logs ADD CONSTRAINT communication_logs_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'communication_logs_vendor_id_fkey' AND conrelid = 'public.communication_logs'::regclass
  ) THEN
    ALTER TABLE public.communication_logs ADD CONSTRAINT communication_logs_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'communication_logs_work_order_id_fkey' AND conrelid = 'public.communication_logs'::regclass
  ) THEN
    ALTER TABLE public.communication_logs ADD CONSTRAINT communication_logs_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_pkey' AND conrelid = 'public.push_subscriptions'::regclass
  ) THEN
    ALTER TABLE public.push_subscriptions ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_crew_member_id_endpoint_key' AND conrelid = 'public.push_subscriptions'::regclass
  ) THEN
    ALTER TABLE public.push_subscriptions ADD CONSTRAINT push_subscriptions_crew_member_id_endpoint_key UNIQUE (crew_member_id, endpoint);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_crew_member_id_fkey' AND conrelid = 'public.push_subscriptions'::regclass
  ) THEN
    ALTER TABLE public.push_subscriptions ADD CONSTRAINT push_subscriptions_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_org_id_fkey' AND conrelid = 'public.push_subscriptions'::regclass
  ) THEN
    ALTER TABLE public.push_subscriptions ADD CONSTRAINT push_subscriptions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quote_requests_pkey' AND conrelid = 'public.quote_requests'::regclass
  ) THEN
    ALTER TABLE public.quote_requests ADD CONSTRAINT quote_requests_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quote_requests_quote_token_key' AND conrelid = 'public.quote_requests'::regclass
  ) THEN
    ALTER TABLE public.quote_requests ADD CONSTRAINT quote_requests_quote_token_key UNIQUE (quote_token);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quote_requests_org_id_fkey' AND conrelid = 'public.quote_requests'::regclass
  ) THEN
    ALTER TABLE public.quote_requests ADD CONSTRAINT quote_requests_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quote_requests_vendor_id_fkey' AND conrelid = 'public.quote_requests'::regclass
  ) THEN
    ALTER TABLE public.quote_requests ADD CONSTRAINT quote_requests_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quote_requests_work_order_id_fkey' AND conrelid = 'public.quote_requests'::regclass
  ) THEN
    ALTER TABLE public.quote_requests ADD CONSTRAINT quote_requests_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integration_providers_pkey' AND conrelid = 'public.integration_providers'::regclass
  ) THEN
    ALTER TABLE public.integration_providers ADD CONSTRAINT integration_providers_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integration_providers_auth_type_check' AND conrelid = 'public.integration_providers'::regclass
  ) THEN
    ALTER TABLE public.integration_providers ADD CONSTRAINT integration_providers_auth_type_check CHECK ((auth_type = ANY (ARRAY['oauth2'::text, 'api_key'::text])));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integration_connections_pkey' AND conrelid = 'public.integration_connections'::regclass
  ) THEN
    ALTER TABLE public.integration_connections ADD CONSTRAINT integration_connections_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integration_connections_user_id_provider_id_key' AND conrelid = 'public.integration_connections'::regclass
  ) THEN
    ALTER TABLE public.integration_connections ADD CONSTRAINT integration_connections_user_id_provider_id_key UNIQUE (user_id, provider_id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_integration_connections_org_provider' AND conrelid = 'public.integration_connections'::regclass
  ) THEN
    ALTER TABLE public.integration_connections ADD CONSTRAINT uq_integration_connections_org_provider UNIQUE (org_id, provider_id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integration_connections_org_id_fkey' AND conrelid = 'public.integration_connections'::regclass
  ) THEN
    ALTER TABLE public.integration_connections ADD CONSTRAINT integration_connections_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integration_connections_provider_id_fkey' AND conrelid = 'public.integration_connections'::regclass
  ) THEN
    ALTER TABLE public.integration_connections ADD CONSTRAINT integration_connections_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES integration_providers(id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integration_connections_user_id_fkey' AND conrelid = 'public.integration_connections'::regclass
  ) THEN
    ALTER TABLE public.integration_connections ADD CONSTRAINT integration_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integration_connections_status_check' AND conrelid = 'public.integration_connections'::regclass
  ) THEN
    ALTER TABLE public.integration_connections ADD CONSTRAINT integration_connections_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'error'::text])));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'oauth_states_pkey' AND conrelid = 'public.oauth_states'::regclass
  ) THEN
    ALTER TABLE public.oauth_states ADD CONSTRAINT oauth_states_pkey PRIMARY KEY (state);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'oauth_states_user_id_fkey' AND conrelid = 'public.oauth_states'::regclass
  ) THEN
    ALTER TABLE public.oauth_states ADD CONSTRAINT oauth_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wo_number_counters_pkey' AND conrelid = 'public.wo_number_counters'::regclass
  ) THEN
    ALTER TABLE public.wo_number_counters ADD CONSTRAINT wo_number_counters_pkey PRIMARY KEY (org_id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wo_number_counters_org_id_fkey' AND conrelid = 'public.wo_number_counters'::regclass
  ) THEN
    ALTER TABLE public.wo_number_counters ADD CONSTRAINT wo_number_counters_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_order_line_items_pkey' AND conrelid = 'public.work_order_line_items'::regclass
  ) THEN
    ALTER TABLE public.work_order_line_items ADD CONSTRAINT work_order_line_items_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_order_line_items_org_id_fkey' AND conrelid = 'public.work_order_line_items'::regclass
  ) THEN
    ALTER TABLE public.work_order_line_items ADD CONSTRAINT work_order_line_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_order_line_items_work_order_id_fkey' AND conrelid = 'public.work_order_line_items'::regclass
  ) THEN
    ALTER TABLE public.work_order_line_items ADD CONSTRAINT work_order_line_items_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_order_line_items_quantity_check' AND conrelid = 'public.work_order_line_items'::regclass
  ) THEN
    ALTER TABLE public.work_order_line_items ADD CONSTRAINT work_order_line_items_quantity_check CHECK ((quantity > (0)::numeric));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_order_line_items_unit_cost_check' AND conrelid = 'public.work_order_line_items'::regclass
  ) THEN
    ALTER TABLE public.work_order_line_items ADD CONSTRAINT work_order_line_items_unit_cost_check CHECK ((unit_cost >= (0)::numeric));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_templates_pkey' AND conrelid = 'public.inventory_templates'::regclass
  ) THEN
    ALTER TABLE public.inventory_templates ADD CONSTRAINT inventory_templates_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_template_items_pkey' AND conrelid = 'public.inventory_template_items'::regclass
  ) THEN
    ALTER TABLE public.inventory_template_items ADD CONSTRAINT inventory_template_items_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_template_items_catalog_item_id_fkey' AND conrelid = 'public.inventory_template_items'::regclass
  ) THEN
    ALTER TABLE public.inventory_template_items ADD CONSTRAINT inventory_template_items_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES inventory_catalog(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_template_items_template_id_fkey' AND conrelid = 'public.inventory_template_items'::regclass
  ) THEN
    ALTER TABLE public.inventory_template_items ADD CONSTRAINT inventory_template_items_template_id_fkey FOREIGN KEY (template_id) REFERENCES inventory_templates(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_master_checklist_items_pkey' AND conrelid = 'public.org_master_checklist_items'::regclass
  ) THEN
    ALTER TABLE public.org_master_checklist_items ADD CONSTRAINT org_master_checklist_items_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_master_checklist_items_org_id_fkey' AND conrelid = 'public.org_master_checklist_items'::regclass
  ) THEN
    ALTER TABLE public.org_master_checklist_items ADD CONSTRAINT org_master_checklist_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_master_maintenance_schedules_pkey' AND conrelid = 'public.org_master_maintenance_schedules'::regclass
  ) THEN
    ALTER TABLE public.org_master_maintenance_schedules ADD CONSTRAINT org_master_maintenance_schedules_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_master_maintenance_schedules_org_id_fkey' AND conrelid = 'public.org_master_maintenance_schedules'::regclass
  ) THEN
    ALTER TABLE public.org_master_maintenance_schedules ADD CONSTRAINT org_master_maintenance_schedules_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crew_availability_pkey' AND conrelid = 'public.crew_availability'::regclass
  ) THEN
    ALTER TABLE public.crew_availability ADD CONSTRAINT crew_availability_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crew_availability_crew_member_id_available_date_key' AND conrelid = 'public.crew_availability'::regclass
  ) THEN
    ALTER TABLE public.crew_availability ADD CONSTRAINT crew_availability_crew_member_id_available_date_key UNIQUE (crew_member_id, available_date);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crew_availability_crew_member_id_fkey' AND conrelid = 'public.crew_availability'::regclass
  ) THEN
    ALTER TABLE public.crew_availability ADD CONSTRAINT crew_availability_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assignment_outcomes_pkey' AND conrelid = 'public.assignment_outcomes'::regclass
  ) THEN
    ALTER TABLE public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assignment_outcomes_turnover_id_crew_member_id_key' AND conrelid = 'public.assignment_outcomes'::regclass
  ) THEN
    ALTER TABLE public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_turnover_id_crew_member_id_key UNIQUE (turnover_id, crew_member_id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assignment_outcomes_crew_member_id_fkey' AND conrelid = 'public.assignment_outcomes'::regclass
  ) THEN
    ALTER TABLE public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assignment_outcomes_property_id_fkey' AND conrelid = 'public.assignment_outcomes'::regclass
  ) THEN
    ALTER TABLE public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assignment_outcomes_turnover_id_fkey' AND conrelid = 'public.assignment_outcomes'::regclass
  ) THEN
    ALTER TABLE public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_turnover_id_fkey FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assignment_outcomes_pm_rating_check' AND conrelid = 'public.assignment_outcomes'::regclass
  ) THEN
    ALTER TABLE public.assignment_outcomes ADD CONSTRAINT assignment_outcomes_pm_rating_check CHECK (((pm_rating >= 1) AND (pm_rating <= 5)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_type_standards_pkey' AND conrelid = 'public.asset_type_standards'::regclass
  ) THEN
    ALTER TABLE public.asset_type_standards ADD CONSTRAINT asset_type_standards_pkey PRIMARY KEY (asset_type);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_assets_pkey' AND conrelid = 'public.property_assets'::regclass
  ) THEN
    ALTER TABLE public.property_assets ADD CONSTRAINT property_assets_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_assets_property_id_fkey' AND conrelid = 'public.property_assets'::regclass
  ) THEN
    ALTER TABLE public.property_assets ADD CONSTRAINT property_assets_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_assets_replaced_by_asset_id_fkey' AND conrelid = 'public.property_assets'::regclass
  ) THEN
    ALTER TABLE public.property_assets ADD CONSTRAINT property_assets_replaced_by_asset_id_fkey FOREIGN KEY (replaced_by_asset_id) REFERENCES property_assets(id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_assets_depreciation_method_check' AND conrelid = 'public.property_assets'::regclass
  ) THEN
    ALTER TABLE public.property_assets ADD CONSTRAINT property_assets_depreciation_method_check CHECK ((depreciation_method = ANY (ARRAY['macrs'::text, 'section_179'::text, 'straight_line'::text])));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_assets_health_score_check' AND conrelid = 'public.property_assets'::regclass
  ) THEN
    ALTER TABLE public.property_assets ADD CONSTRAINT property_assets_health_score_check CHECK (((health_score >= 0) AND (health_score <= 100)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_compliance_documents_pkey' AND conrelid = 'public.vendor_compliance_documents'::regclass
  ) THEN
    ALTER TABLE public.vendor_compliance_documents ADD CONSTRAINT vendor_compliance_documents_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_compliance_documents_vendor_id_fkey' AND conrelid = 'public.vendor_compliance_documents'::regclass
  ) THEN
    ALTER TABLE public.vendor_compliance_documents ADD CONSTRAINT vendor_compliance_documents_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_depreciation_entries_pkey' AND conrelid = 'public.asset_depreciation_entries'::regclass
  ) THEN
    ALTER TABLE public.asset_depreciation_entries ADD CONSTRAINT asset_depreciation_entries_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_depreciation_entries_asset_id_tax_year_key' AND conrelid = 'public.asset_depreciation_entries'::regclass
  ) THEN
    ALTER TABLE public.asset_depreciation_entries ADD CONSTRAINT asset_depreciation_entries_asset_id_tax_year_key UNIQUE (asset_id, tax_year);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_depreciation_entries_asset_id_fkey' AND conrelid = 'public.asset_depreciation_entries'::regclass
  ) THEN
    ALTER TABLE public.asset_depreciation_entries ADD CONSTRAINT asset_depreciation_entries_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES property_assets(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedule_templates_pkey' AND conrelid = 'public.maintenance_schedule_templates'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedule_templates ADD CONSTRAINT maintenance_schedule_templates_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedule_template_items_pkey' AND conrelid = 'public.maintenance_schedule_template_items'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedule_template_items ADD CONSTRAINT maintenance_schedule_template_items_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedule_template_items_template_id_fkey' AND conrelid = 'public.maintenance_schedule_template_items'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedule_template_items ADD CONSTRAINT maintenance_schedule_template_items_template_id_fkey FOREIGN KEY (template_id) REFERENCES maintenance_schedule_templates(id) ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedule_template_items_active_from_month_check' AND conrelid = 'public.maintenance_schedule_template_items'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedule_template_items ADD CONSTRAINT maintenance_schedule_template_items_active_from_month_check CHECK (((active_from_month >= 1) AND (active_from_month <= 12)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_schedule_template_items_active_to_month_check' AND conrelid = 'public.maintenance_schedule_template_items'::regclass
  ) THEN
    ALTER TABLE public.maintenance_schedule_template_items ADD CONSTRAINT maintenance_schedule_template_items_active_to_month_check CHECK (((active_to_month >= 1) AND (active_to_month <= 12)));
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_pkey' AND conrelid = 'public.messages'::regclass
  ) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_turnover_id_fkey' AND conrelid = 'public.messages'::regclass
  ) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_turnover_id_fkey FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_work_order_id_fkey' AND conrelid = 'public.messages'::regclass
  ) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_content_check' AND conrelid = 'public.messages'::regclass
  ) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_content_check CHECK ((char_length(content) > 0));
  END IF;
END $do$;

-- ───────────────────────── Pass 4: CREATE INDEX ───────────────────────────────

CREATE INDEX IF NOT EXISTS idx_org_members_invite_token ON public.organization_members USING btree (invite_token);
CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON public.organization_members USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON public.organization_members USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_properties_org_id ON public.properties USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_property_owners_org_id ON public.property_owners USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_property_owners_property_id ON public.property_owners USING btree (property_id);
CREATE INDEX IF NOT EXISTS idx_owner_portal_revoked ON public.owner_portal_tokens USING btree (revoked_at) WHERE (revoked_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_owner_portal_tokens_revoked ON public.owner_portal_tokens USING btree (revoked_at) WHERE (revoked_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_owner_portal_tokens_token ON public.owner_portal_tokens USING btree (token);
CREATE UNIQUE INDEX IF NOT EXISTS owner_portal_multi_unique ON public.owner_portal_tokens USING btree (property_owner_id) WHERE (is_multi = true);
CREATE UNIQUE INDEX IF NOT EXISTS owner_portal_single_unique ON public.owner_portal_tokens USING btree (property_owner_id) WHERE (is_multi IS NOT TRUE);
CREATE INDEX IF NOT EXISTS idx_ical_feeds_org_id ON public.ical_feeds USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_ical_feeds_property_id ON public.ical_feeds USING btree (property_id);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_external_id_source_idx ON public.bookings USING btree (external_id, external_source) WHERE (external_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_ical_uid_unique ON public.bookings USING btree (ical_feed_id, ical_uid) WHERE (ical_uid IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_manual_dates_unique ON public.bookings USING btree (property_id, checkin_date, checkout_date) WHERE ((source = 'manual'::booking_source) AND (status <> 'cancelled'::booking_status));
CREATE INDEX IF NOT EXISTS idx_bookings_checkin ON public.bookings USING btree (checkin_date);
CREATE INDEX IF NOT EXISTS idx_bookings_checkout ON public.bookings USING btree (checkout_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_external_source ON public.bookings USING btree (external_id, external_source) WHERE ((external_id IS NOT NULL) AND (external_source IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_bookings_org_id ON public.bookings USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_bookings_property_id ON public.bookings USING btree (property_id);
CREATE UNIQUE INDEX IF NOT EXISTS crew_members_user_org_unique ON public.crew_members USING btree (org_id, user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_crew_members_invite_token ON public.crew_members USING btree (invite_token);
CREATE INDEX IF NOT EXISTS idx_crew_members_org_id ON public.crew_members USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_crew_members_user_id ON public.crew_members USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_vendors_org_id ON public.vendors USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_checklist_templates_org_id ON public.checklist_templates USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_checklist_templates_property_id ON public.checklist_templates USING btree (property_id);
CREATE INDEX IF NOT EXISTS idx_checklist_sections_template_id ON public.checklist_template_sections USING btree (template_id);
CREATE INDEX IF NOT EXISTS idx_checklist_items_section_id ON public.checklist_template_items USING btree (section_id);
CREATE INDEX IF NOT EXISTS idx_checklist_items_template_id ON public.checklist_template_items USING btree (template_id);
CREATE INDEX IF NOT EXISTS idx_turnovers_booking_id ON public.turnovers USING btree (booking_id) WHERE (booking_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_turnovers_checklist_template_id ON public.turnovers USING btree (checklist_template_id);
CREATE INDEX IF NOT EXISTS idx_turnovers_checkout ON public.turnovers USING btree (checkout_datetime);
CREATE INDEX IF NOT EXISTS idx_turnovers_org_id ON public.turnovers USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_turnovers_prev_booking_id ON public.turnovers USING btree (prev_booking_id);
CREATE INDEX IF NOT EXISTS idx_turnovers_property_id ON public.turnovers USING btree (property_id);
CREATE INDEX IF NOT EXISTS idx_turnovers_status ON public.turnovers USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS turnovers_booking_pair_unique ON public.turnovers USING btree (booking_id, prev_booking_id) WHERE ((booking_id IS NOT NULL) AND (prev_booking_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS turnovers_standalone_booking_unique ON public.turnovers USING btree (booking_id) WHERE ((booking_id IS NOT NULL) AND (prev_booking_id IS NULL));
CREATE INDEX IF NOT EXISTS idx_turnover_assignments_crew_id ON public.turnover_assignments USING btree (crew_member_id);
CREATE INDEX IF NOT EXISTS idx_turnover_assignments_org_id ON public.turnover_assignments USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_turnover_assignments_property_id ON public.turnover_assignments USING btree (property_id) WHERE (property_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_turnover_assignments_turnover_id ON public.turnover_assignments USING btree (turnover_id);
CREATE INDEX IF NOT EXISTS idx_turnover_assignments_user_id ON public.turnover_assignments USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_checklist_instances_org_id ON public.checklist_instances USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_checklist_instances_template_id ON public.checklist_instances USING btree (template_id);
CREATE INDEX IF NOT EXISTS idx_checklist_instances_turnover_id ON public.checklist_instances USING btree (turnover_id);
CREATE INDEX IF NOT EXISTS idx_checklist_instance_items_completed_by_crew_id ON public.checklist_instance_items USING btree (completed_by_crew_id);
CREATE INDEX IF NOT EXISTS idx_checklist_instance_items_instance_id ON public.checklist_instance_items USING btree (instance_id);
CREATE INDEX IF NOT EXISTS idx_checklist_instance_items_turnover_id ON public.checklist_instance_items USING btree (turnover_id) WHERE (turnover_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_inventory_items_brand ON public.inventory_items USING btree (org_id, preferred_brand) WHERE (preferred_brand IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_inventory_items_catalog_item_id ON public.inventory_items USING btree (catalog_item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_org_id ON public.inventory_items USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_property_id ON public.inventory_items USING btree (property_id);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_org_id ON public.inventory_counts USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_property_id ON public.inventory_counts USING btree (property_id);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_submitted_by_crew_id ON public.inventory_counts USING btree (submitted_by_crew_id);
CREATE INDEX IF NOT EXISTS idx_inventory_count_items_count_id ON public.inventory_count_items USING btree (count_id);
CREATE INDEX IF NOT EXISTS idx_inventory_count_items_inventory_item_id ON public.inventory_count_items USING btree (inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_org_id ON public.purchase_orders USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_property_id ON public.purchase_orders USING btree (property_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON public.purchase_orders USING btree (status);
CREATE INDEX IF NOT EXISTS idx_po_items_purchase_order_id ON public.purchase_order_items USING btree (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_inventory_item_id ON public.purchase_order_items USING btree (inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_asset_id ON public.work_orders USING btree (asset_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_assigned_crew_id ON public.work_orders USING btree (assigned_crew_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_assigned_crew_member_id ON public.work_orders USING btree (assigned_crew_member_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_completion_token ON public.work_orders USING btree (completion_token);
CREATE INDEX IF NOT EXISTS idx_work_orders_completion_verified_by ON public.work_orders USING btree (completion_verified_by);
CREATE INDEX IF NOT EXISTS idx_work_orders_org_id ON public.work_orders USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_pending_signoff ON public.work_orders USING btree (public_token_expires_at) WHERE ((public_signed_off_at IS NULL) AND (public_token IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_work_orders_property_id ON public.work_orders USING btree (property_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_orders_public_token ON public.work_orders USING btree (public_token) WHERE (public_token IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_work_orders_scheduled_date ON public.work_orders USING btree (scheduled_date);
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON public.work_orders USING btree (status);
CREATE INDEX IF NOT EXISTS idx_work_orders_vendor_acknowledged_by ON public.work_orders USING btree (vendor_acknowledged_by);
CREATE INDEX IF NOT EXISTS idx_work_orders_vendor_id ON public.work_orders USING btree (vendor_id);
CREATE UNIQUE INDEX IF NOT EXISTS wo_crew_flag_source_unique ON public.work_orders USING btree (source_turnover_id) WHERE ((source = 'crew_flag'::wo_source) AND (source_turnover_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS work_orders_completion_token_unique ON public.work_orders USING btree (completion_token) WHERE (completion_token IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS work_orders_org_wo_number_unique ON public.work_orders USING btree (org_id, wo_number) WHERE (wo_number IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_wo_updates_work_order_id ON public.work_order_updates USING btree (work_order_id);
CREATE INDEX IF NOT EXISTS idx_work_order_updates_org_id ON public.work_order_updates USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_work_order_updates_updated_by_user_id ON public.work_order_updates USING btree (updated_by_user_id);
CREATE INDEX IF NOT EXISTS idx_wo_photos_work_order_id ON public.work_order_photos USING btree (work_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS wo_photos_storage_path_unique ON public.work_order_photos USING btree (storage_path);
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_assigned_vendor_id ON public.maintenance_schedules USING btree (assigned_vendor_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_next_due ON public.maintenance_schedules USING btree (next_due_date);
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_org_due ON public.maintenance_schedules USING btree (org_id, next_due_date) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_org_id ON public.maintenance_schedules USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_property_due ON public.maintenance_schedules USING btree (property_id, next_due_date) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_property_id ON public.maintenance_schedules USING btree (property_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_source_template_item_id ON public.maintenance_schedules USING btree (source_template_item_id);
CREATE INDEX IF NOT EXISTS idx_owner_transactions_purchase_order_id ON public.owner_transactions USING btree (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_owner_transactions_work_order_id ON public.owner_transactions USING btree (work_order_id);
CREATE INDEX IF NOT EXISTS idx_owner_txn_booking_id ON public.owner_transactions USING btree (booking_id);
CREATE INDEX IF NOT EXISTS idx_owner_txn_date ON public.owner_transactions USING btree (transaction_date);
CREATE INDEX IF NOT EXISTS idx_owner_txn_org_id ON public.owner_transactions USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_owner_txn_property_id ON public.owner_transactions USING btree (property_id);
CREATE INDEX IF NOT EXISTS idx_org_milestones_org_id ON public.org_milestones USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_comm_logs_communicated_at ON public.communication_logs USING btree (communicated_at DESC);
CREATE INDEX IF NOT EXISTS idx_comm_logs_crew_member_id ON public.communication_logs USING btree (crew_member_id) WHERE (crew_member_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_comm_logs_org_id ON public.communication_logs USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_comm_logs_property_id ON public.communication_logs USING btree (property_id) WHERE (property_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_comm_logs_vendor_id ON public.communication_logs USING btree (vendor_id) WHERE (vendor_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_comm_logs_work_order_id ON public.communication_logs USING btree (work_order_id) WHERE (work_order_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_comms_log_retention ON public.communication_logs USING btree (org_id, created_at) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_communication_logs_logged_by_user_id ON public.communication_logs USING btree (logged_by_user_id);
CREATE INDEX IF NOT EXISTS idx_push_subs_crew_member ON public.push_subscriptions USING btree (crew_member_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_org_id ON public.push_subscriptions USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_quote_requests_org_id ON public.quote_requests USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_quote_requests_quote_token ON public.quote_requests USING btree (quote_token);
CREATE INDEX IF NOT EXISTS idx_quote_requests_token ON public.quote_requests USING btree (quote_token);
CREATE INDEX IF NOT EXISTS idx_quote_requests_vendor_id ON public.quote_requests USING btree (vendor_id);
CREATE INDEX IF NOT EXISTS idx_quote_requests_wo_status ON public.quote_requests USING btree (work_order_id, status);
CREATE INDEX IF NOT EXISTS idx_quote_requests_work_order_id ON public.quote_requests USING btree (work_order_id);
CREATE INDEX IF NOT EXISTS idx_integration_connections_org_id ON public.integration_connections USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_integration_connections_provider_id ON public.integration_connections USING btree (provider_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_user_id ON public.oauth_states USING btree (user_id);
CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx ON public.oauth_states USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_wo_line_items_org_id ON public.work_order_line_items USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_wo_line_items_work_order_id ON public.work_order_line_items USING btree (work_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_templates_org_unique ON public.inventory_templates USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_inventory_template_items_catalog_item_id ON public.inventory_template_items USING btree (catalog_item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_template_items_template_id ON public.inventory_template_items USING btree (template_id);
CREATE INDEX IF NOT EXISTS idx_org_master_checklist_org_id ON public.org_master_checklist_items USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_org_master_maintenance_org_id ON public.org_master_maintenance_schedules USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_crew_availability_lookup ON public.crew_availability USING btree (crew_member_id, available_date);
CREATE INDEX IF NOT EXISTS idx_assignment_outcomes_crew ON public.assignment_outcomes USING btree (crew_member_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignment_outcomes_property_crew ON public.assignment_outcomes USING btree (property_id, crew_member_id) WHERE (duration_minutes IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_property_assets_org ON public.property_assets USING btree (org_id, health_score);
CREATE INDEX IF NOT EXISTS idx_property_assets_property ON public.property_assets USING btree (property_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_property_assets_replaced_by_asset_id ON public.property_assets USING btree (replaced_by_asset_id);
CREATE INDEX IF NOT EXISTS idx_property_assets_warranty ON public.property_assets USING btree (warranty_expiry_date) WHERE ((warranty_expiry_date IS NOT NULL) AND (is_active = true));
CREATE INDEX IF NOT EXISTS idx_vendor_compliance_expiring ON public.vendor_compliance_documents USING btree (expiry_date, org_id) WHERE ((is_active = true) AND (expiry_date IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_vendor_compliance_vendor ON public.vendor_compliance_documents USING btree (vendor_id, document_type, expiry_date);
CREATE INDEX IF NOT EXISTS idx_depreciation_org_year ON public.asset_depreciation_entries USING btree (org_id, tax_year);
CREATE INDEX IF NOT EXISTS idx_maintenance_schedule_template_items_template_id ON public.maintenance_schedule_template_items USING btree (template_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages USING btree (org_id, sender_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_unread ON public.messages USING btree (recipient_id, read_at) WHERE (read_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_messages_turnover_id ON public.messages USING btree (turnover_id);
CREATE INDEX IF NOT EXISTS idx_messages_work_order_id ON public.messages USING btree (work_order_id);

-- ───────────────────── Pass 5: CREATE POLICY (guarded) ────────────────────────

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_own'
  ) THEN
    CREATE POLICY profiles_own ON public.profiles AS PERMISSIVE FOR ALL TO public
    USING ((id = ( SELECT auth.uid() AS uid)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organizations' AND policyname = 'orgs_insert'
  ) THEN
    CREATE POLICY orgs_insert ON public.organizations AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((( SELECT auth.uid() AS uid) IS NOT NULL));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organizations' AND policyname = 'orgs_select'
  ) THEN
    CREATE POLICY orgs_select ON public.organizations AS PERMISSIVE FOR SELECT TO public
    USING ((id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organizations' AND policyname = 'orgs_update'
  ) THEN
    CREATE POLICY orgs_update ON public.organizations AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(id, ARRAY['admin'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organization_members' AND policyname = 'org_members_admin_delete'
  ) THEN
    CREATE POLICY org_members_admin_delete ON public.organization_members AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organization_members' AND policyname = 'org_members_admin_manage'
  ) THEN
    CREATE POLICY org_members_admin_manage ON public.organization_members AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organization_members' AND policyname = 'org_members_insert_self'
  ) THEN
    CREATE POLICY org_members_insert_self ON public.organization_members AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organization_members' AND policyname = 'org_members_select'
  ) THEN
    CREATE POLICY org_members_select ON public.organization_members AS PERMISSIVE FOR SELECT TO public
    USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'properties' AND policyname = 'properties_delete'
  ) THEN
    CREATE POLICY properties_delete ON public.properties AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'properties' AND policyname = 'properties_insert'
  ) THEN
    CREATE POLICY properties_insert ON public.properties AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'properties' AND policyname = 'properties_select'
  ) THEN
    CREATE POLICY properties_select ON public.properties AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'properties' AND policyname = 'properties_update'
  ) THEN
    CREATE POLICY properties_update ON public.properties AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'property_owners' AND policyname = 'property_owners_delete'
  ) THEN
    CREATE POLICY property_owners_delete ON public.property_owners AS PERMISSIVE FOR DELETE TO authenticated
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'property_owners' AND policyname = 'property_owners_insert'
  ) THEN
    CREATE POLICY property_owners_insert ON public.property_owners AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'property_owners' AND policyname = 'property_owners_select'
  ) THEN
    CREATE POLICY property_owners_select ON public.property_owners AS PERMISSIVE FOR SELECT TO authenticated
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'property_owners' AND policyname = 'property_owners_service_role'
  ) THEN
    CREATE POLICY property_owners_service_role ON public.property_owners AS PERMISSIVE FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'property_owners' AND policyname = 'property_owners_update'
  ) THEN
    CREATE POLICY property_owners_update ON public.property_owners AS PERMISSIVE FOR UPDATE TO authenticated
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'owner_portal_tokens' AND policyname = 'portal_tokens_manage'
  ) THEN
    CREATE POLICY portal_tokens_manage ON public.owner_portal_tokens AS PERMISSIVE FOR ALL TO public
    USING ((property_owner_id IN ( SELECT property_owners.id
   FROM property_owners
  WHERE is_org_member(property_owners.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ical_feeds' AND policyname = 'ical_feeds_manage'
  ) THEN
    CREATE POLICY ical_feeds_manage ON public.ical_feeds AS PERMISSIVE FOR ALL TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bookings' AND policyname = 'bookings_delete'
  ) THEN
    CREATE POLICY bookings_delete ON public.bookings AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bookings' AND policyname = 'bookings_insert'
  ) THEN
    CREATE POLICY bookings_insert ON public.bookings AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bookings' AND policyname = 'bookings_select'
  ) THEN
    CREATE POLICY bookings_select ON public.bookings AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bookings' AND policyname = 'bookings_update'
  ) THEN
    CREATE POLICY bookings_update ON public.bookings AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crew_members' AND policyname = 'crew_members_delete'
  ) THEN
    CREATE POLICY crew_members_delete ON public.crew_members AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crew_members' AND policyname = 'crew_members_insert'
  ) THEN
    CREATE POLICY crew_members_insert ON public.crew_members AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crew_members' AND policyname = 'crew_members_select'
  ) THEN
    CREATE POLICY crew_members_select ON public.crew_members AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (user_id = ( SELECT auth.uid() AS uid))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crew_members' AND policyname = 'crew_members_update'
  ) THEN
    CREATE POLICY crew_members_update ON public.crew_members AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendors' AND policyname = 'vendors_delete'
  ) THEN
    CREATE POLICY vendors_delete ON public.vendors AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendors' AND policyname = 'vendors_insert'
  ) THEN
    CREATE POLICY vendors_insert ON public.vendors AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendors' AND policyname = 'vendors_select'
  ) THEN
    CREATE POLICY vendors_select ON public.vendors AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendors' AND policyname = 'vendors_update'
  ) THEN
    CREATE POLICY vendors_update ON public.vendors AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_templates' AND policyname = 'checklist_templates_delete'
  ) THEN
    CREATE POLICY checklist_templates_delete ON public.checklist_templates AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_templates' AND policyname = 'checklist_templates_insert'
  ) THEN
    CREATE POLICY checklist_templates_insert ON public.checklist_templates AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_templates' AND policyname = 'checklist_templates_select'
  ) THEN
    CREATE POLICY checklist_templates_select ON public.checklist_templates AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_templates' AND policyname = 'checklist_templates_update'
  ) THEN
    CREATE POLICY checklist_templates_update ON public.checklist_templates AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_template_sections' AND policyname = 'checklist_template_sections_delete'
  ) THEN
    CREATE POLICY checklist_template_sections_delete ON public.checklist_template_sections AS PERMISSIVE FOR DELETE TO public
    USING ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_template_sections' AND policyname = 'checklist_template_sections_insert'
  ) THEN
    CREATE POLICY checklist_template_sections_insert ON public.checklist_template_sections AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_template_sections' AND policyname = 'checklist_template_sections_select'
  ) THEN
    CREATE POLICY checklist_template_sections_select ON public.checklist_template_sections AS PERMISSIVE FOR SELECT TO public
    USING (((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))) OR (template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE (checklist_templates.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_template_sections' AND policyname = 'checklist_template_sections_update'
  ) THEN
    CREATE POLICY checklist_template_sections_update ON public.checklist_template_sections AS PERMISSIVE FOR UPDATE TO public
    USING ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
    WITH CHECK ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_template_items' AND policyname = 'checklist_template_items_delete'
  ) THEN
    CREATE POLICY checklist_template_items_delete ON public.checklist_template_items AS PERMISSIVE FOR DELETE TO public
    USING ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_template_items' AND policyname = 'checklist_template_items_insert'
  ) THEN
    CREATE POLICY checklist_template_items_insert ON public.checklist_template_items AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_template_items' AND policyname = 'checklist_template_items_select'
  ) THEN
    CREATE POLICY checklist_template_items_select ON public.checklist_template_items AS PERMISSIVE FOR SELECT TO public
    USING (((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))) OR (template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE (checklist_templates.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_template_items' AND policyname = 'checklist_template_items_update'
  ) THEN
    CREATE POLICY checklist_template_items_update ON public.checklist_template_items AS PERMISSIVE FOR UPDATE TO public
    USING ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
    WITH CHECK ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'turnovers' AND policyname = 'turnovers_delete'
  ) THEN
    CREATE POLICY turnovers_delete ON public.turnovers AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'turnovers' AND policyname = 'turnovers_insert'
  ) THEN
    CREATE POLICY turnovers_insert ON public.turnovers AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'turnovers' AND policyname = 'turnovers_select'
  ) THEN
    CREATE POLICY turnovers_select ON public.turnovers AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (id IN ( SELECT get_crew_turnover_ids() AS get_crew_turnover_ids)) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'turnovers' AND policyname = 'turnovers_update'
  ) THEN
    CREATE POLICY turnovers_update ON public.turnovers AS PERMISSIVE FOR UPDATE TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (id IN ( SELECT get_crew_turnover_ids() AS get_crew_turnover_ids))))
    WITH CHECK ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (id IN ( SELECT get_crew_turnover_ids() AS get_crew_turnover_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'turnover_assignments' AND policyname = 'turnover_assignments_delete'
  ) THEN
    CREATE POLICY turnover_assignments_delete ON public.turnover_assignments AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'turnover_assignments' AND policyname = 'turnover_assignments_insert'
  ) THEN
    CREATE POLICY turnover_assignments_insert ON public.turnover_assignments AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'turnover_assignments' AND policyname = 'turnover_assignments_select'
  ) THEN
    CREATE POLICY turnover_assignments_select ON public.turnover_assignments AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = ( SELECT auth.uid() AS uid)))) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'turnover_assignments' AND policyname = 'turnover_assignments_update'
  ) THEN
    CREATE POLICY turnover_assignments_update ON public.turnover_assignments AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_instances' AND policyname = 'checklist_instances_delete'
  ) THEN
    CREATE POLICY checklist_instances_delete ON public.checklist_instances AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_instances' AND policyname = 'checklist_instances_insert'
  ) THEN
    CREATE POLICY checklist_instances_insert ON public.checklist_instances AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_instances' AND policyname = 'checklist_instances_select'
  ) THEN
    CREATE POLICY checklist_instances_select ON public.checklist_instances AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (turnover_id IN ( SELECT ta.turnover_id
   FROM (turnover_assignments ta
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = ( SELECT auth.uid() AS uid)))) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_instances' AND policyname = 'checklist_instances_update'
  ) THEN
    CREATE POLICY checklist_instances_update ON public.checklist_instances AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_instance_items' AND policyname = 'checklist_instance_items_delete'
  ) THEN
    CREATE POLICY checklist_instance_items_delete ON public.checklist_instance_items AS PERMISSIVE FOR DELETE TO public
    USING ((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_instance_items' AND policyname = 'checklist_instance_items_insert'
  ) THEN
    CREATE POLICY checklist_instance_items_insert ON public.checklist_instance_items AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_instance_items' AND policyname = 'checklist_instance_items_select'
  ) THEN
    CREATE POLICY checklist_instance_items_select ON public.checklist_instance_items AS PERMISSIVE FOR SELECT TO public
    USING (((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))) OR (instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE (checklist_instances.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'checklist_instance_items' AND policyname = 'checklist_instance_items_update'
  ) THEN
    CREATE POLICY checklist_instance_items_update ON public.checklist_instance_items AS PERMISSIVE FOR UPDATE TO public
    USING (((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))) OR (instance_id IN ( SELECT ci.id
   FROM ((checklist_instances ci
     JOIN turnover_assignments ta ON ((ci.turnover_id = ta.turnover_id)))
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = ( SELECT auth.uid() AS uid))))))
    WITH CHECK (((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))) OR (instance_id IN ( SELECT ci.id
   FROM ((checklist_instances ci
     JOIN turnover_assignments ta ON ((ci.turnover_id = ta.turnover_id)))
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = ( SELECT auth.uid() AS uid))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_catalog' AND policyname = 'inventory_catalog_read'
  ) THEN
    CREATE POLICY inventory_catalog_read ON public.inventory_catalog AS PERMISSIVE FOR SELECT TO public
    USING (true);
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_items' AND policyname = 'inventory_items_delete'
  ) THEN
    CREATE POLICY inventory_items_delete ON public.inventory_items AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_items' AND policyname = 'inventory_items_insert'
  ) THEN
    CREATE POLICY inventory_items_insert ON public.inventory_items AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_items' AND policyname = 'inventory_items_select'
  ) THEN
    CREATE POLICY inventory_items_select ON public.inventory_items AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (property_id IN ( SELECT DISTINCT t.property_id
   FROM ((turnovers t
     JOIN turnover_assignments ta ON ((ta.turnover_id = t.id)))
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = ( SELECT auth.uid() AS uid)))) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_items' AND policyname = 'inventory_items_update'
  ) THEN
    CREATE POLICY inventory_items_update ON public.inventory_items AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_counts' AND policyname = 'inventory_counts_crew_insert'
  ) THEN
    CREATE POLICY inventory_counts_crew_insert ON public.inventory_counts AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((submitted_by_crew_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = ( SELECT auth.uid() AS uid)))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_counts' AND policyname = 'inventory_counts_delete'
  ) THEN
    CREATE POLICY inventory_counts_delete ON public.inventory_counts AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_counts' AND policyname = 'inventory_counts_select'
  ) THEN
    CREATE POLICY inventory_counts_select ON public.inventory_counts AS PERMISSIVE FOR SELECT TO public
    USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_counts' AND policyname = 'inventory_counts_update'
  ) THEN
    CREATE POLICY inventory_counts_update ON public.inventory_counts AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_count_items' AND policyname = 'count_items_crew_insert'
  ) THEN
    CREATE POLICY count_items_crew_insert ON public.inventory_count_items AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((count_id IN ( SELECT ic.id
   FROM (inventory_counts ic
     JOIN crew_members cm ON ((ic.submitted_by_crew_id = cm.id)))
  WHERE (cm.user_id = ( SELECT auth.uid() AS uid)))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_count_items' AND policyname = 'count_items_select'
  ) THEN
    CREATE POLICY count_items_select ON public.inventory_count_items AS PERMISSIVE FOR SELECT TO public
    USING ((count_id IN ( SELECT inventory_counts.id
   FROM inventory_counts
  WHERE (inventory_counts.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchase_orders' AND policyname = 'purchase_orders_delete'
  ) THEN
    CREATE POLICY purchase_orders_delete ON public.purchase_orders AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchase_orders' AND policyname = 'purchase_orders_insert'
  ) THEN
    CREATE POLICY purchase_orders_insert ON public.purchase_orders AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchase_orders' AND policyname = 'purchase_orders_select'
  ) THEN
    CREATE POLICY purchase_orders_select ON public.purchase_orders AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchase_orders' AND policyname = 'purchase_orders_update'
  ) THEN
    CREATE POLICY purchase_orders_update ON public.purchase_orders AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchase_order_items' AND policyname = 'po_items_manage'
  ) THEN
    CREATE POLICY po_items_manage ON public.purchase_order_items AS PERMISSIVE FOR ALL TO public
    USING ((purchase_order_id IN ( SELECT purchase_orders.id
   FROM purchase_orders
  WHERE is_org_member(purchase_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_orders' AND policyname = 'work_orders_delete'
  ) THEN
    CREATE POLICY work_orders_delete ON public.work_orders AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_orders' AND policyname = 'work_orders_insert'
  ) THEN
    CREATE POLICY work_orders_insert ON public.work_orders AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_orders' AND policyname = 'work_orders_select'
  ) THEN
    CREATE POLICY work_orders_select ON public.work_orders AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_orders' AND policyname = 'work_orders_update'
  ) THEN
    CREATE POLICY work_orders_update ON public.work_orders AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_order_updates' AND policyname = 'wo_updates_insert'
  ) THEN
    CREATE POLICY wo_updates_insert ON public.work_order_updates AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_order_updates' AND policyname = 'wo_updates_select'
  ) THEN
    CREATE POLICY wo_updates_select ON public.work_order_updates AS PERMISSIVE FOR SELECT TO public
    USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_order_photos' AND policyname = 'work_order_photos_delete'
  ) THEN
    CREATE POLICY work_order_photos_delete ON public.work_order_photos AS PERMISSIVE FOR DELETE TO public
    USING ((work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE is_org_member(work_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_order_photos' AND policyname = 'work_order_photos_insert'
  ) THEN
    CREATE POLICY work_order_photos_insert ON public.work_order_photos AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE is_org_member(work_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_order_photos' AND policyname = 'work_order_photos_select'
  ) THEN
    CREATE POLICY work_order_photos_select ON public.work_order_photos AS PERMISSIVE FOR SELECT TO public
    USING (((work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE is_org_member(work_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))) OR (work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE (work_orders.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_order_photos' AND policyname = 'work_order_photos_update'
  ) THEN
    CREATE POLICY work_order_photos_update ON public.work_order_photos AS PERMISSIVE FOR UPDATE TO public
    USING ((work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE is_org_member(work_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
    WITH CHECK ((work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE is_org_member(work_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedules' AND policyname = 'maintenance_schedules_delete'
  ) THEN
    CREATE POLICY maintenance_schedules_delete ON public.maintenance_schedules AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedules' AND policyname = 'maintenance_schedules_insert'
  ) THEN
    CREATE POLICY maintenance_schedules_insert ON public.maintenance_schedules AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedules' AND policyname = 'maintenance_schedules_select'
  ) THEN
    CREATE POLICY maintenance_schedules_select ON public.maintenance_schedules AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedules' AND policyname = 'maintenance_schedules_update'
  ) THEN
    CREATE POLICY maintenance_schedules_update ON public.maintenance_schedules AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'owner_transactions' AND policyname = 'owner_transactions_manage'
  ) THEN
    CREATE POLICY owner_transactions_manage ON public.owner_transactions AS PERMISSIVE FOR ALL TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'owner_transactions' AND policyname = 'owner_transactions_select'
  ) THEN
    CREATE POLICY owner_transactions_select ON public.owner_transactions AS PERMISSIVE FOR SELECT TO public
    USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_milestones' AND policyname = 'org_milestones_delete'
  ) THEN
    CREATE POLICY org_milestones_delete ON public.org_milestones AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_milestones' AND policyname = 'org_milestones_insert'
  ) THEN
    CREATE POLICY org_milestones_insert ON public.org_milestones AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_milestones' AND policyname = 'org_milestones_select'
  ) THEN
    CREATE POLICY org_milestones_select ON public.org_milestones AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_milestones' AND policyname = 'org_milestones_update'
  ) THEN
    CREATE POLICY org_milestones_update ON public.org_milestones AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'communication_logs' AND policyname = 'communication_logs_delete'
  ) THEN
    CREATE POLICY communication_logs_delete ON public.communication_logs AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'communication_logs' AND policyname = 'communication_logs_insert'
  ) THEN
    CREATE POLICY communication_logs_insert ON public.communication_logs AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'communication_logs' AND policyname = 'communication_logs_select'
  ) THEN
    CREATE POLICY communication_logs_select ON public.communication_logs AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'communication_logs' AND policyname = 'communication_logs_update'
  ) THEN
    CREATE POLICY communication_logs_update ON public.communication_logs AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'push_subscriptions' AND policyname = 'Crew members manage own push subscriptions'
  ) THEN
    CREATE POLICY "Crew members manage own push subscriptions" ON public.push_subscriptions AS PERMISSIVE FOR ALL TO public
    USING ((crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = ( SELECT auth.uid() AS uid)))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quote_requests' AND policyname = 'quote_requests_delete'
  ) THEN
    CREATE POLICY quote_requests_delete ON public.quote_requests AS PERMISSIVE FOR DELETE TO authenticated
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quote_requests' AND policyname = 'quote_requests_insert'
  ) THEN
    CREATE POLICY quote_requests_insert ON public.quote_requests AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quote_requests' AND policyname = 'quote_requests_select'
  ) THEN
    CREATE POLICY quote_requests_select ON public.quote_requests AS PERMISSIVE FOR SELECT TO authenticated
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quote_requests' AND policyname = 'quote_requests_service_role'
  ) THEN
    CREATE POLICY quote_requests_service_role ON public.quote_requests AS PERMISSIVE FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quote_requests' AND policyname = 'quote_requests_update'
  ) THEN
    CREATE POLICY quote_requests_update ON public.quote_requests AS PERMISSIVE FOR UPDATE TO authenticated
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'integration_providers' AND policyname = 'Anyone can read active providers'
  ) THEN
    CREATE POLICY "Anyone can read active providers" ON public.integration_providers AS PERMISSIVE FOR SELECT TO public
    USING ((is_active = true));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'integration_connections' AND policyname = 'integration_connections_deny_delete'
  ) THEN
    CREATE POLICY integration_connections_deny_delete ON public.integration_connections AS PERMISSIVE FOR DELETE TO public
    USING (false);
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'integration_connections' AND policyname = 'integration_connections_deny_insert'
  ) THEN
    CREATE POLICY integration_connections_deny_insert ON public.integration_connections AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (false);
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'integration_connections' AND policyname = 'integration_connections_deny_update'
  ) THEN
    CREATE POLICY integration_connections_deny_update ON public.integration_connections AS PERMISSIVE FOR UPDATE TO public
    USING (false);
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'integration_connections' AND policyname = 'integration_connections_select'
  ) THEN
    CREATE POLICY integration_connections_select ON public.integration_connections AS PERMISSIVE FOR SELECT TO public
    USING (((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (( SELECT auth.uid() AS uid) = user_id)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'wo_number_counters' AND policyname = 'wo_counters_deny_all'
  ) THEN
    CREATE POLICY wo_counters_deny_all ON public.wo_number_counters AS PERMISSIVE FOR ALL TO public
    USING (false);
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_order_line_items' AND policyname = 'Managers and above delete line items'
  ) THEN
    CREATE POLICY "Managers and above delete line items" ON public.work_order_line_items AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_order_line_items' AND policyname = 'Managers and above insert line items'
  ) THEN
    CREATE POLICY "Managers and above insert line items" ON public.work_order_line_items AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_order_line_items' AND policyname = 'Members view org line items'
  ) THEN
    CREATE POLICY "Members view org line items" ON public.work_order_line_items AS PERMISSIVE FOR SELECT TO public
    USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_order_line_items' AND policyname = 'work_order_line_items_update'
  ) THEN
    CREATE POLICY work_order_line_items_update ON public.work_order_line_items AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_templates' AND policyname = 'inventory_templates_delete'
  ) THEN
    CREATE POLICY inventory_templates_delete ON public.inventory_templates AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_templates' AND policyname = 'inventory_templates_insert'
  ) THEN
    CREATE POLICY inventory_templates_insert ON public.inventory_templates AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_templates' AND policyname = 'inventory_templates_select'
  ) THEN
    CREATE POLICY inventory_templates_select ON public.inventory_templates AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_templates' AND policyname = 'inventory_templates_update'
  ) THEN
    CREATE POLICY inventory_templates_update ON public.inventory_templates AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_template_items' AND policyname = 'inventory_template_items_delete'
  ) THEN
    CREATE POLICY inventory_template_items_delete ON public.inventory_template_items AS PERMISSIVE FOR DELETE TO public
    USING ((template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE is_org_member(inventory_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_template_items' AND policyname = 'inventory_template_items_insert'
  ) THEN
    CREATE POLICY inventory_template_items_insert ON public.inventory_template_items AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE is_org_member(inventory_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_template_items' AND policyname = 'inventory_template_items_select'
  ) THEN
    CREATE POLICY inventory_template_items_select ON public.inventory_template_items AS PERMISSIVE FOR SELECT TO public
    USING (((template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE is_org_member(inventory_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))) OR (template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE (inventory_templates.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_template_items' AND policyname = 'inventory_template_items_update'
  ) THEN
    CREATE POLICY inventory_template_items_update ON public.inventory_template_items AS PERMISSIVE FOR UPDATE TO public
    USING ((template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE is_org_member(inventory_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
    WITH CHECK ((template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE is_org_member(inventory_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_master_checklist_items' AND policyname = 'Admins and managers manage master checklist'
  ) THEN
    CREATE POLICY "Admins and managers manage master checklist" ON public.org_master_checklist_items AS PERMISSIVE FOR ALL TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_master_checklist_items' AND policyname = 'org_master_checklist_items_select'
  ) THEN
    CREATE POLICY org_master_checklist_items_select ON public.org_master_checklist_items AS PERMISSIVE FOR SELECT TO public
    USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_master_maintenance_schedules' AND policyname = 'Admins managers owners manage master maintenance'
  ) THEN
    CREATE POLICY "Admins managers owners manage master maintenance" ON public.org_master_maintenance_schedules AS PERMISSIVE FOR ALL TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_master_maintenance_schedules' AND policyname = 'org_master_maintenance_schedules_select'
  ) THEN
    CREATE POLICY org_master_maintenance_schedules_select ON public.org_master_maintenance_schedules AS PERMISSIVE FOR SELECT TO public
    USING ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crew_availability' AND policyname = 'crew_availability_delete'
  ) THEN
    CREATE POLICY crew_availability_delete ON public.crew_availability AS PERMISSIVE FOR DELETE TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = ( SELECT auth.uid() AS uid))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crew_availability' AND policyname = 'crew_availability_insert'
  ) THEN
    CREATE POLICY crew_availability_insert ON public.crew_availability AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = ( SELECT auth.uid() AS uid))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crew_availability' AND policyname = 'crew_availability_select'
  ) THEN
    CREATE POLICY crew_availability_select ON public.crew_availability AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = ( SELECT auth.uid() AS uid)))) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crew_availability' AND policyname = 'crew_availability_update'
  ) THEN
    CREATE POLICY crew_availability_update ON public.crew_availability AS PERMISSIVE FOR UPDATE TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = ( SELECT auth.uid() AS uid))))))
    WITH CHECK ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = ( SELECT auth.uid() AS uid))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'assignment_outcomes' AND policyname = 'assignment_outcomes_delete'
  ) THEN
    CREATE POLICY assignment_outcomes_delete ON public.assignment_outcomes AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'assignment_outcomes' AND policyname = 'assignment_outcomes_insert'
  ) THEN
    CREATE POLICY assignment_outcomes_insert ON public.assignment_outcomes AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'assignment_outcomes' AND policyname = 'assignment_outcomes_select'
  ) THEN
    CREATE POLICY assignment_outcomes_select ON public.assignment_outcomes AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'assignment_outcomes' AND policyname = 'assignment_outcomes_update'
  ) THEN
    CREATE POLICY assignment_outcomes_update ON public.assignment_outcomes AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'asset_type_standards' AND policyname = 'asset_type_standards_no_delete'
  ) THEN
    CREATE POLICY asset_type_standards_no_delete ON public.asset_type_standards AS PERMISSIVE FOR DELETE TO public
    USING (false);
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'asset_type_standards' AND policyname = 'asset_type_standards_no_insert'
  ) THEN
    CREATE POLICY asset_type_standards_no_insert ON public.asset_type_standards AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (false);
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'asset_type_standards' AND policyname = 'asset_type_standards_no_update'
  ) THEN
    CREATE POLICY asset_type_standards_no_update ON public.asset_type_standards AS PERMISSIVE FOR UPDATE TO public
    USING (false);
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'asset_type_standards' AND policyname = 'asset_type_standards_select'
  ) THEN
    CREATE POLICY asset_type_standards_select ON public.asset_type_standards AS PERMISSIVE FOR SELECT TO public
    USING ((( SELECT auth.role() AS role) = 'authenticated'::text));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'property_assets' AND policyname = 'property_assets_delete'
  ) THEN
    CREATE POLICY property_assets_delete ON public.property_assets AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'property_assets' AND policyname = 'property_assets_insert'
  ) THEN
    CREATE POLICY property_assets_insert ON public.property_assets AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'property_assets' AND policyname = 'property_assets_select'
  ) THEN
    CREATE POLICY property_assets_select ON public.property_assets AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'property_assets' AND policyname = 'property_assets_update'
  ) THEN
    CREATE POLICY property_assets_update ON public.property_assets AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendor_compliance_documents' AND policyname = 'vendor_compliance_documents_delete'
  ) THEN
    CREATE POLICY vendor_compliance_documents_delete ON public.vendor_compliance_documents AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendor_compliance_documents' AND policyname = 'vendor_compliance_documents_insert'
  ) THEN
    CREATE POLICY vendor_compliance_documents_insert ON public.vendor_compliance_documents AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendor_compliance_documents' AND policyname = 'vendor_compliance_documents_select'
  ) THEN
    CREATE POLICY vendor_compliance_documents_select ON public.vendor_compliance_documents AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendor_compliance_documents' AND policyname = 'vendor_compliance_documents_update'
  ) THEN
    CREATE POLICY vendor_compliance_documents_update ON public.vendor_compliance_documents AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'asset_depreciation_entries' AND policyname = 'asset_depreciation_entries_delete'
  ) THEN
    CREATE POLICY asset_depreciation_entries_delete ON public.asset_depreciation_entries AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'asset_depreciation_entries' AND policyname = 'asset_depreciation_entries_insert'
  ) THEN
    CREATE POLICY asset_depreciation_entries_insert ON public.asset_depreciation_entries AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'asset_depreciation_entries' AND policyname = 'asset_depreciation_entries_select'
  ) THEN
    CREATE POLICY asset_depreciation_entries_select ON public.asset_depreciation_entries AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR (org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'asset_depreciation_entries' AND policyname = 'asset_depreciation_entries_update'
  ) THEN
    CREATE POLICY asset_depreciation_entries_update ON public.asset_depreciation_entries AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedule_templates' AND policyname = 'maintenance_schedule_templates_delete'
  ) THEN
    CREATE POLICY maintenance_schedule_templates_delete ON public.maintenance_schedule_templates AS PERMISSIVE FOR DELETE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedule_templates' AND policyname = 'maintenance_schedule_templates_insert'
  ) THEN
    CREATE POLICY maintenance_schedule_templates_insert ON public.maintenance_schedule_templates AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedule_templates' AND policyname = 'maintenance_schedule_templates_select'
  ) THEN
    CREATE POLICY maintenance_schedule_templates_select ON public.maintenance_schedule_templates AS PERMISSIVE FOR SELECT TO public
    USING ((is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]) OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (is_system = true))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedule_templates' AND policyname = 'maintenance_schedule_templates_update'
  ) THEN
    CREATE POLICY maintenance_schedule_templates_update ON public.maintenance_schedule_templates AS PERMISSIVE FOR UPDATE TO public
    USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedule_template_items' AND policyname = 'maintenance_schedule_template_items_delete'
  ) THEN
    CREATE POLICY maintenance_schedule_template_items_delete ON public.maintenance_schedule_template_items AS PERMISSIVE FOR DELETE TO public
    USING ((template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false)))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedule_template_items' AND policyname = 'maintenance_schedule_template_items_insert'
  ) THEN
    CREATE POLICY maintenance_schedule_template_items_insert ON public.maintenance_schedule_template_items AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false)))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedule_template_items' AND policyname = 'maintenance_schedule_template_items_select'
  ) THEN
    CREATE POLICY maintenance_schedule_template_items_select ON public.maintenance_schedule_template_items AS PERMISSIVE FOR SELECT TO public
    USING (((template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false)))) OR (template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE ((maintenance_schedule_templates.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (maintenance_schedule_templates.is_system = true))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maintenance_schedule_template_items' AND policyname = 'maintenance_schedule_template_items_update'
  ) THEN
    CREATE POLICY maintenance_schedule_template_items_update ON public.maintenance_schedule_template_items AS PERMISSIVE FOR UPDATE TO public
    USING ((template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false)))))
    WITH CHECK ((template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false)))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'messages' AND policyname = 'messages_delete'
  ) THEN
    CREATE POLICY messages_delete ON public.messages AS PERMISSIVE FOR DELETE TO public
    USING (((sender_id = ( SELECT auth.uid() AS uid)) OR (org_id IN ( SELECT organization_members.org_id
   FROM organization_members
  WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND (organization_members.role = ANY (ARRAY['owner'::member_role, 'admin'::member_role])) AND (organization_members.invite_accepted_at IS NOT NULL))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'messages' AND policyname = 'messages_insert'
  ) THEN
    CREATE POLICY messages_insert ON public.messages AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((sender_id = ( SELECT auth.uid() AS uid)) AND ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (org_id IN ( SELECT crew_members.org_id
   FROM crew_members
  WHERE (crew_members.user_id = ( SELECT auth.uid() AS uid)))))));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'messages' AND policyname = 'messages_mark_read'
  ) THEN
    CREATE POLICY messages_mark_read ON public.messages AS PERMISSIVE FOR UPDATE TO public
    USING ((recipient_id = ( SELECT auth.uid() AS uid)))
    WITH CHECK ((recipient_id = ( SELECT auth.uid() AS uid)));
  END IF;
END $pol$;

DO $pol$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'messages' AND policyname = 'messages_select'
  ) THEN
    CREATE POLICY messages_select ON public.messages AS PERMISSIVE FOR SELECT TO public
    USING (((sender_id = ( SELECT auth.uid() AS uid)) OR (recipient_id = ( SELECT auth.uid() AS uid))));
  END IF;
END $pol$;

-- ───────────────────── Pass 6: GRANT (authenticated / anon) ───────────────────

GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.profiles TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.organizations TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.organization_members TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.organization_members TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.properties TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.properties TO authenticated;
GRANT SELECT ON TABLE public.property_owners TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.property_owners TO authenticated;
GRANT SELECT ON TABLE public.owner_portal_tokens TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.owner_portal_tokens TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.ical_feeds TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.bookings TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.bookings TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.crew_members TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.vendors TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.checklist_templates TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.checklist_template_sections TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.checklist_template_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.turnovers TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.turnover_assignments TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.checklist_instances TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.checklist_instance_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.inventory_catalog TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.inventory_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.inventory_counts TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.inventory_count_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.purchase_orders TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.purchase_order_items TO authenticated;
GRANT SELECT ON TABLE public.work_orders TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.work_orders TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.work_order_updates TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.work_order_photos TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.maintenance_schedules TO authenticated;
GRANT SELECT ON TABLE public.owner_transactions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.owner_transactions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.org_milestones TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.communication_logs TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.push_subscriptions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.quote_requests TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.integration_providers TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.integration_providers TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.integration_connections TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.integration_connections TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.work_order_line_items TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.work_order_line_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.inventory_templates TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.inventory_templates TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.inventory_template_items TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.inventory_template_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.org_master_checklist_items TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.org_master_checklist_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.org_master_maintenance_schedules TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.org_master_maintenance_schedules TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.crew_availability TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.assignment_outcomes TO authenticated;
GRANT SELECT ON TABLE public.asset_type_standards TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.property_assets TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.vendor_compliance_documents TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.asset_depreciation_entries TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.maintenance_schedule_templates TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.maintenance_schedule_template_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.messages TO authenticated;
