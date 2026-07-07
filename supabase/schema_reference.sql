--
-- FieldStay — Supabase schema_reference.sql
--
-- Generated: 2026-07-07T15:09:51Z (UTC)  (sections 1-3 pulled ~15:00-15:07, sections 4-6 ~15:09 — all within the same generation pass)
--
-- This file was generated via Supabase MCP tool introspection (execute_sql /
-- list_extensions against pg_catalog, information_schema, pg_policies, etc.)
-- run directly against the LIVE project `vpmznjktllhmmbfnxuvk`. It was NOT
-- produced by `supabase db dump --schema public` (scripts/generate-schema-reference.sh
-- could not run in this environment — no Supabase CLI credentials/DB connection
-- string were available). The content is semantically accurate as of the
-- Generated timestamp above but will not be byte-identical to `db dump` output
-- (formatting, statement ordering, and comment style differ).
--
-- SCOPE / FORMAT NOTE: As of this generation, the migration ledger in
-- supabase/migrations/ has been fully reconciled to match live production
-- exactly (every file's version/name/content matches what's actually
-- applied). That directory is the authoritative source for full DDL —
-- complete CREATE FUNCTION bodies, trigger definitions, and RLS policy
-- expressions. This file is deliberately a COMPACT STRUCTURAL OVERVIEW:
-- table/column/constraint/index shapes, enum definitions, function/trigger
-- signatures, and RLS policy names+commands — NOT full bodies. Where a
-- function's defining migration could be identified by grepping
-- supabase/migrations/*.sql, it is noted inline as "-- see: <file>"; read
-- that file for the exact implementation.
--

-- =============================================================================
-- 1. EXTENSIONS (installed only)
-- =============================================================================

-- name                schema        version
-- ----                ------        -------
-- pgcrypto            extensions    1.3
-- plpgsql             pg_catalog    1.0
-- uuid-ossp           extensions    1.1
-- pg_stat_statements  extensions    1.11
-- vector              extensions    0.8.0
-- hypopg              extensions    1.4.1
-- index_advisor       extensions    0.2.0
-- supabase_vault      vault         0.3.1

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS plpgsql WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS hypopg WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS index_advisor WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- =============================================================================
-- 2. ENUM TYPES (public schema)
-- =============================================================================

CREATE TYPE public.asset_type AS ENUM (
  'hvac', 'water_heater', 'roof', 'refrigerator', 'washer', 'dryer', 'dishwasher',
  'microwave', 'oven_range', 'pool_pump', 'hot_tub', 'garage_door', 'smart_lock',
  'deck_structure', 'electrical_panel', 'plumbing_system', 'septic_system',
  'well_pump', 'generator', 'solar_system', 'other', 'water_shutoff_valve',
  'solar_inverter', 'whole_home_water_filter', 'heated_tile_system',
  'range_hood_vent', 'coffee_station', 'toaster_oven', 'wifi_router',
  'fire_extinguisher', 'thermostat'
);

CREATE TYPE public.booking_source AS ENUM (
  'airbnb', 'vrbo', 'booking_com', 'direct', 'manual', 'other', 'ownerrez'
);

CREATE TYPE public.booking_status AS ENUM (
  'confirmed', 'cancelled', 'blocked', 'tentative'
);

CREATE TYPE public.checklist_status AS ENUM (
  'not_started', 'in_progress', 'completed'
);

CREATE TYPE public.comm_channel AS ENUM (
  'email', 'sms', 'phone', 'in_person', 'note'
);

CREATE TYPE public.comm_recipient_type AS ENUM (
  'vendor', 'crew'
);

CREATE TYPE public.comm_source AS ENUM (
  'manual', 'system'
);

CREATE TYPE public.compliance_doc_type AS ENUM (
  'coi', 'workers_comp', 'business_license', 'contractor_license', 'bonding', 'other'
);

CREATE TYPE public.contact_pref AS ENUM (
  'email', 'sms', 'both'
);

CREATE TYPE public.crew_role AS ENUM (
  'cleaning', 'landscaping', 'maintenance', 'general'
);

CREATE TYPE public.ical_source AS ENUM (
  'airbnb', 'vrbo', 'booking_com', 'direct', 'other'
);

CREATE TYPE public.inventory_category AS ENUM (
  'paper_goods', 'cleaning', 'kitchen', 'bath', 'laundry', 'bedroom', 'outdoor',
  'other', 'bedroom_linens', 'maintenance_safety', 'guest_experience', 'technology'
);

CREATE TYPE public.line_item_type AS ENUM (
  'labor', 'material', 'equipment', 'subcontractor', 'other'
);

CREATE TYPE public.macrs_class AS ENUM (
  '5_year', '15_year', '27_5_year', '39_year', 'section_179'
);

CREATE TYPE public.member_role AS ENUM (
  'admin', 'manager', 'crew', 'viewer', 'owner'
);

CREATE TYPE public.org_plan AS ENUM (
  'starter', 'growth', 'pro', 'enterprise', 'portfolio'
);

CREATE TYPE public.org_plan_status AS ENUM (
  'trialing', 'active', 'past_due', 'cancelled', 'paused'
);

CREATE TYPE public.po_status AS ENUM (
  'draft', 'sent', 'acknowledged', 'ordered', 'received', 'cancelled'
);

CREATE TYPE public.priority_level AS ENUM (
  'low', 'medium', 'high', 'urgent'
);

CREATE TYPE public.property_type AS ENUM (
  'house', 'condo', 'cabin', 'cottage', 'townhouse', 'other'
);

CREATE TYPE public.quote_request_status AS ENUM (
  'pending', 'submitted', 'approved', 'declined', 'expired'
);

CREATE TYPE public.schedule_frequency AS ENUM (
  'weekly', 'biweekly', 'monthly', 'quarterly', 'semi_annual', 'annual'
);

CREATE TYPE public.schedule_type AS ENUM (
  'routine', 'seasonal'
);

CREATE TYPE public.support_category AS ENUM (
  'faq', 'technical', 'account_specific'
);

CREATE TYPE public.support_message_role AS ENUM (
  'user', 'assistant', 'human'
);

CREATE TYPE public.sync_status AS ENUM (
  'pending', 'success', 'error'
);

CREATE TYPE public.turnover_status AS ENUM (
  'pending_assignment', 'assigned', 'in_progress', 'completed', 'flagged', 'cancelled'
);

CREATE TYPE public.txn_category AS ENUM (
  'booking_revenue', 'cleaning_fee', 'maintenance', 'restock', 'utility',
  'insurance', 'supplies', 'other'
);

CREATE TYPE public.txn_type AS ENUM (
  'revenue', 'expense'
);

CREATE TYPE public.vendor_specialty AS ENUM (
  'plumbing', 'electrical', 'hvac', 'landscaping', 'cleaning', 'pest_control',
  'pool', 'roofing', 'general', 'other'
);

CREATE TYPE public.wo_category AS ENUM (
  'hvac', 'plumbing', 'electrical', 'appliance', 'cleaning', 'landscaping',
  'roofing', 'flooring', 'windows_doors', 'pest_control', 'pool', 'structural',
  'general', 'other'
);

CREATE TYPE public.wo_source AS ENUM (
  'manual', 'maintenance_schedule', 'crew_flag', 'guest_report'
);

-- NOTE: 'quote_requested' has enumsortorder 1.5 in pg_enum (inserted between
-- 'pending' and 'assigned' via ALTER TYPE ... ADD VALUE ... BEFORE, not
-- appended) — ordinal position among labels is pending, quote_requested,
-- assigned, in_progress, completed, cancelled.
CREATE TYPE public.wo_status AS ENUM (
  'pending', 'quote_requested', 'assigned', 'in_progress', 'completed', 'cancelled'
);


-- =============================================================================
-- 3. TABLES (public schema, alphabetical)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TABLE: public.asset_depreciation_entries
-- -----------------------------------------------------------------------------
CREATE TABLE public.asset_depreciation_entries (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  asset_id  uuid  NOT NULL,
  tax_year  smallint  NOT NULL,
  macrs_class  macrs_class  NOT NULL,
  cost_basis  numeric(12,2)  NOT NULL,
  prior_cumulative_depreciation  numeric(12,2)  NOT NULL  DEFAULT 0,
  current_year_depreciation  numeric(12,2)  NOT NULL,
  ending_adjusted_basis  numeric(12,2)  NOT NULL,
  depreciation_rate  numeric(6,4),
  notes  text,
  generated_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   asset_depreciation_entries_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   asset_depreciation_entries_asset_id_fkey: FOREIGN KEY (asset_id) REFERENCES property_assets(id) ON DELETE CASCADE
-- Unique Constraints:
--   asset_depreciation_entries_asset_id_tax_year_key: UNIQUE (asset_id, tax_year)
-- Indexes:
--   asset_depreciation_entries_asset_id_tax_year_key: CREATE UNIQUE INDEX asset_depreciation_entries_asset_id_tax_year_key ON public.asset_depreciation_entries USING btree (asset_id, tax_year)
--   asset_depreciation_entries_pkey: CREATE UNIQUE INDEX asset_depreciation_entries_pkey ON public.asset_depreciation_entries USING btree (id)
--   idx_depreciation_org_year: CREATE INDEX idx_depreciation_org_year ON public.asset_depreciation_entries USING btree (org_id, tax_year)
-- RLS: ENABLED
-- Policies:
--   asset_depreciation_entries_delete  (DELETE)  roles={public}
--   asset_depreciation_entries_insert  (INSERT)  roles={public}
--   asset_depreciation_entries_select  (SELECT)  roles={public}
--   asset_depreciation_entries_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.asset_type_standards
-- -----------------------------------------------------------------------------
CREATE TABLE public.asset_type_standards (
  asset_type  asset_type  NOT NULL,
  display_name  text  NOT NULL,
  lifespan_min_years  smallint  NOT NULL,
  lifespan_max_years  smallint  NOT NULL,
  avg_replacement_cost_low  integer,
  avg_replacement_cost_high  integer,
  macrs_class_default  macrs_class  NOT NULL  DEFAULT '5_year'::macrs_class,
  vendor_specialty_default  vendor_specialty,
  notes  text,
  age_weight  numeric  NOT NULL  DEFAULT 60,
  condition_weight  numeric  NOT NULL  DEFAULT 40,
  weight_updated_at  timestamp with time zone
);

-- Primary Key:
--   asset_type_standards_pkey: PRIMARY KEY (asset_type)
-- Check Constraints:
--   asset_type_standards_age_weight_check: CHECK (((age_weight >= (30)::numeric) AND (age_weight <= (70)::numeric)))
--   asset_type_standards_condition_weight_check: CHECK (((condition_weight >= (30)::numeric) AND (condition_weight <= (70)::numeric)))
--   asset_weights_sum_100: CHECK ((round((age_weight + condition_weight)) = (100)::numeric))
-- Indexes:
--   asset_type_standards_pkey: CREATE UNIQUE INDEX asset_type_standards_pkey ON public.asset_type_standards USING btree (asset_type)
-- RLS: ENABLED
-- Policies:
--   asset_type_standards_no_delete  (DELETE)  roles={public}
--   asset_type_standards_no_insert  (INSERT)  roles={public}
--   asset_type_standards_no_update  (UPDATE)  roles={public}
--   asset_type_standards_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.assignment_outcomes
-- -----------------------------------------------------------------------------
CREATE TABLE public.assignment_outcomes (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  turnover_id  uuid  NOT NULL,
  crew_member_id  uuid  NOT NULL,
  property_id  uuid,
  suggested_score  smallint,
  score_breakdown  jsonb,
  was_suggestion  boolean  NOT NULL  DEFAULT false,
  was_accepted  boolean,
  override_reason  text,
  started_at  timestamp with time zone,
  completed_at  timestamp with time zone,
  duration_minutes  integer  DEFAULT CASE WHEN ((started_at IS NOT NULL) AND (completed_at IS NOT NULL) AND ((EXTRACT(epoch FROM (completed_at - started_at)) / (60)::numeric) <= (480)::numeric)) THEN (EXTRACT(epoch FROM (completed_at - started_at)) / (60)::numeric) ELSE NULL::numeric END,
  pm_rating  smallint,
  property_bedrooms  smallint,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   assignment_outcomes_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   assignment_outcomes_crew_member_id_fkey: FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE
--   assignment_outcomes_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL
--   assignment_outcomes_turnover_id_fkey: FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE CASCADE
-- Unique Constraints:
--   assignment_outcomes_turnover_id_crew_member_id_key: UNIQUE (turnover_id, crew_member_id)
-- Check Constraints:
--   assignment_outcomes_pm_rating_check: CHECK (((pm_rating >= 1) AND (pm_rating <= 5)))
-- Indexes:
--   assignment_outcomes_pkey: CREATE UNIQUE INDEX assignment_outcomes_pkey ON public.assignment_outcomes USING btree (id)
--   assignment_outcomes_turnover_id_crew_member_id_key: CREATE UNIQUE INDEX assignment_outcomes_turnover_id_crew_member_id_key ON public.assignment_outcomes USING btree (turnover_id, crew_member_id)
--   idx_assignment_outcomes_crew: CREATE INDEX idx_assignment_outcomes_crew ON public.assignment_outcomes USING btree (crew_member_id, completed_at DESC)
--   idx_assignment_outcomes_property_crew: CREATE INDEX idx_assignment_outcomes_property_crew ON public.assignment_outcomes USING btree (property_id, crew_member_id) WHERE (duration_minutes IS NOT NULL)
-- RLS: ENABLED
-- Policies:
--   assignment_outcomes_delete  (DELETE)  roles={public}
--   assignment_outcomes_insert  (INSERT)  roles={public}
--   assignment_outcomes_select  (SELECT)  roles={public}
--   assignment_outcomes_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.audit_events
-- -----------------------------------------------------------------------------
CREATE TABLE public.audit_events (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid,
  actor_id  uuid,
  action  text  NOT NULL,
  target_type  text,
  target_id  text,
  metadata  jsonb,
  ip_address  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   audit_events_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   audit_events_actor_id_fkey: FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL
--   audit_events_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE SET NULL
-- Indexes:
--   audit_events_pkey: CREATE UNIQUE INDEX audit_events_pkey ON public.audit_events USING btree (id)
--   idx_audit_events_action: CREATE INDEX idx_audit_events_action ON public.audit_events USING btree (action)
--   idx_audit_events_actor_id: CREATE INDEX idx_audit_events_actor_id ON public.audit_events USING btree (actor_id)
--   idx_audit_events_created: CREATE INDEX idx_audit_events_created ON public.audit_events USING btree (created_at DESC)
--   idx_audit_events_org_created: CREATE INDEX idx_audit_events_org_created ON public.audit_events USING btree (org_id, created_at DESC)
--   idx_audit_events_org_id: CREATE INDEX idx_audit_events_org_id ON public.audit_events USING btree (org_id)
-- RLS: ENABLED
-- Policies:
--   audit_events_deny_delete  (DELETE)  roles={public}
--   audit_events_deny_update  (UPDATE)  roles={public}
--   audit_events_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.bookings
-- -----------------------------------------------------------------------------
CREATE TABLE public.bookings (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  property_id  uuid  NOT NULL,
  org_id  uuid  NOT NULL,
  ical_feed_id  uuid,
  ical_uid  text,
  guest_name  text,
  guest_email  text,
  checkin_date  date  NOT NULL,
  checkout_date  date  NOT NULL,
  checkin_time  time without time zone,
  checkout_time  time without time zone,
  source  booking_source  DEFAULT 'other'::booking_source,
  status  booking_status  NOT NULL  DEFAULT 'confirmed'::booking_status,
  notes  text,
  raw_ical_data  jsonb,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  external_id  text,
  external_source  text,
  has_overlap_conflict  boolean  NOT NULL  DEFAULT false,
  is_block  boolean  NOT NULL  DEFAULT false,
  guidebook_token  uuid  DEFAULT gen_random_uuid(),
  guidebook_pre_arrival_email_sent_at  timestamp with time zone,
  door_code  text,
  door_code_lock  text,
  door_code_synced_at  timestamp with time zone
);

-- Primary Key:
--   bookings_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   bookings_ical_feed_id_fkey: FOREIGN KEY (ical_feed_id) REFERENCES ical_feeds(id) ON DELETE SET NULL
--   bookings_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   bookings_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
-- Unique Constraints:
--   bookings_external_id_external_source_key: UNIQUE (external_id, external_source)
--   bookings_ical_feed_id_ical_uid_key: UNIQUE (ical_feed_id, ical_uid)
-- Indexes:
--   bookings_external_id_external_source_key: CREATE UNIQUE INDEX bookings_external_id_external_source_key ON public.bookings USING btree (external_id, external_source)
--   bookings_external_id_source_idx: CREATE UNIQUE INDEX bookings_external_id_source_idx ON public.bookings USING btree (external_id, external_source) WHERE (external_id IS NOT NULL)
--   bookings_guidebook_token_idx: CREATE UNIQUE INDEX bookings_guidebook_token_idx ON public.bookings USING btree (guidebook_token)
--   bookings_ical_feed_id_ical_uid_key: CREATE UNIQUE INDEX bookings_ical_feed_id_ical_uid_key ON public.bookings USING btree (ical_feed_id, ical_uid)
--   bookings_ical_uid_unique: CREATE UNIQUE INDEX bookings_ical_uid_unique ON public.bookings USING btree (ical_feed_id, ical_uid) WHERE (ical_uid IS NOT NULL)
--   bookings_manual_dates_unique: CREATE UNIQUE INDEX bookings_manual_dates_unique ON public.bookings USING btree (property_id, checkin_date, checkout_date) WHERE ((source = 'manual'::booking_source) AND (status <> 'cancelled'::booking_status))
--   bookings_pkey: CREATE UNIQUE INDEX bookings_pkey ON public.bookings USING btree (id)
--   idx_bookings_checkin: CREATE INDEX idx_bookings_checkin ON public.bookings USING btree (checkin_date)
--   idx_bookings_checkout: CREATE INDEX idx_bookings_checkout ON public.bookings USING btree (checkout_date)
--   idx_bookings_external_source: CREATE UNIQUE INDEX idx_bookings_external_source ON public.bookings USING btree (external_id, external_source) WHERE ((external_id IS NOT NULL) AND (external_source IS NOT NULL))
--   idx_bookings_guidebook_pre_arrival_pending: CREATE INDEX idx_bookings_guidebook_pre_arrival_pending ON public.bookings USING btree (checkin_date) WHERE (guidebook_pre_arrival_email_sent_at IS NULL)
--   idx_bookings_org_checkin: CREATE INDEX idx_bookings_org_checkin ON public.bookings USING btree (org_id, checkin_date)
--   idx_bookings_org_checkout: CREATE INDEX idx_bookings_org_checkout ON public.bookings USING btree (org_id, checkout_date)
--   idx_bookings_org_id: CREATE INDEX idx_bookings_org_id ON public.bookings USING btree (org_id)
--   idx_bookings_property_id: CREATE INDEX idx_bookings_property_id ON public.bookings USING btree (property_id)
--   idx_bookings_property_overlap_scan: CREATE INDEX idx_bookings_property_overlap_scan ON public.bookings USING btree (property_id, checkin_date, checkout_date) WHERE (status = 'confirmed'::booking_status)
-- RLS: ENABLED
-- Policies:
--   bookings_delete  (DELETE)  roles={public}
--   bookings_insert  (INSERT)  roles={public}
--   bookings_select  (SELECT)  roles={public}
--   bookings_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.checklist_instance_items
-- -----------------------------------------------------------------------------
CREATE TABLE public.checklist_instance_items (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  instance_id  uuid  NOT NULL,
  section_name  text  NOT NULL,
  task  text  NOT NULL,
  requires_photo  boolean  NOT NULL  DEFAULT false,
  notes  text,
  sort_order  integer  NOT NULL  DEFAULT 0,
  is_completed  boolean  NOT NULL  DEFAULT false,
  completed_at  timestamp with time zone,
  completed_by_crew_id  uuid,
  photo_storage_path  text,
  crew_notes  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  is_section_final_item  boolean  NOT NULL  DEFAULT false,
  turnover_id  uuid,
  photo_reason  text,
  is_mandatory  boolean  NOT NULL  DEFAULT false,
  non_deletable  boolean  NOT NULL  DEFAULT false,
  asset_discovery_type  text
);

-- Primary Key:
--   checklist_instance_items_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   checklist_instance_items_completed_by_crew_id_fkey: FOREIGN KEY (completed_by_crew_id) REFERENCES crew_members(id) ON DELETE SET NULL
--   checklist_instance_items_instance_id_fkey: FOREIGN KEY (instance_id) REFERENCES checklist_instances(id) ON DELETE CASCADE
--   checklist_instance_items_turnover_id_fkey: FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE CASCADE
-- Indexes:
--   checklist_instance_items_pkey: CREATE UNIQUE INDEX checklist_instance_items_pkey ON public.checklist_instance_items USING btree (id)
--   idx_checklist_instance_items_completed_by_crew_id: CREATE INDEX idx_checklist_instance_items_completed_by_crew_id ON public.checklist_instance_items USING btree (completed_by_crew_id)
--   idx_checklist_instance_items_instance_id: CREATE INDEX idx_checklist_instance_items_instance_id ON public.checklist_instance_items USING btree (instance_id)
--   idx_checklist_instance_items_turnover_id: CREATE INDEX idx_checklist_instance_items_turnover_id ON public.checklist_instance_items USING btree (turnover_id) WHERE (turnover_id IS NOT NULL)
-- RLS: ENABLED
-- Policies:
--   checklist_instance_items_delete  (DELETE)  roles={public}
--   checklist_instance_items_insert  (INSERT)  roles={public}
--   checklist_instance_items_select  (SELECT)  roles={public}
--   checklist_instance_items_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.checklist_instances
-- -----------------------------------------------------------------------------
CREATE TABLE public.checklist_instances (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  turnover_id  uuid  NOT NULL,
  org_id  uuid  NOT NULL,
  template_id  uuid,
  template_snapshot  jsonb  NOT NULL,
  status  checklist_status  NOT NULL  DEFAULT 'not_started'::checklist_status,
  started_at  timestamp with time zone,
  completed_at  timestamp with time zone,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  section_photo_path  text
);

-- Primary Key:
--   checklist_instances_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   checklist_instances_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   checklist_instances_template_id_fkey: FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE SET NULL
--   checklist_instances_turnover_id_fkey: FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE CASCADE
-- Indexes:
--   checklist_instances_pkey: CREATE UNIQUE INDEX checklist_instances_pkey ON public.checklist_instances USING btree (id)
--   idx_checklist_instances_org_id: CREATE INDEX idx_checklist_instances_org_id ON public.checklist_instances USING btree (org_id)
--   idx_checklist_instances_template_id: CREATE INDEX idx_checklist_instances_template_id ON public.checklist_instances USING btree (template_id)
--   idx_checklist_instances_turnover_id: CREATE INDEX idx_checklist_instances_turnover_id ON public.checklist_instances USING btree (turnover_id)
-- RLS: ENABLED
-- Policies:
--   checklist_instances_delete  (DELETE)  roles={public}
--   checklist_instances_insert  (INSERT)  roles={public}
--   checklist_instances_select  (SELECT)  roles={public}
--   checklist_instances_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.checklist_item_signals
-- -----------------------------------------------------------------------------
CREATE TABLE public.checklist_item_signals (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  property_id  uuid  NOT NULL,
  section_name  text  NOT NULL,
  task  text  NOT NULL,
  alpha  numeric  NOT NULL  DEFAULT 2,
  beta  numeric  NOT NULL  DEFAULT 1,
  flag_probability  numeric  DEFAULT (beta / (alpha + beta)),
  dynamic_photo_required  boolean  DEFAULT ((beta / (alpha + beta)) >= 0.20),
  reason  text,
  total_completions  integer  NOT NULL  DEFAULT 0,
  total_flags  integer  NOT NULL  DEFAULT 0,
  computed_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   checklist_item_signals_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   checklist_item_signals_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   checklist_item_signals_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
-- Unique Constraints:
--   checklist_item_signals_property_id_section_name_task_key: UNIQUE (property_id, section_name, task)
-- Indexes:
--   checklist_item_signals_pkey: CREATE UNIQUE INDEX checklist_item_signals_pkey ON public.checklist_item_signals USING btree (id)
--   checklist_item_signals_property_id_section_name_task_key: CREATE UNIQUE INDEX checklist_item_signals_property_id_section_name_task_key ON public.checklist_item_signals USING btree (property_id, section_name, task)
-- RLS: ENABLED
-- Policies:
--   org members read own signals  (SELECT)  roles={public}
--   service role manages signals  (ALL)  roles={service_role}

-- -----------------------------------------------------------------------------
-- TABLE: public.checklist_template_items
-- -----------------------------------------------------------------------------
CREATE TABLE public.checklist_template_items (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  section_id  uuid  NOT NULL,
  template_id  uuid  NOT NULL,
  task  text  NOT NULL,
  requires_photo  boolean  NOT NULL  DEFAULT false,
  notes  text,
  sort_order  integer  NOT NULL  DEFAULT 0,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   checklist_template_items_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   checklist_template_items_section_id_fkey: FOREIGN KEY (section_id) REFERENCES checklist_template_sections(id) ON DELETE CASCADE
--   checklist_template_items_template_id_fkey: FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE
-- Indexes:
--   checklist_template_items_pkey: CREATE UNIQUE INDEX checklist_template_items_pkey ON public.checklist_template_items USING btree (id)
--   idx_checklist_items_section_id: CREATE INDEX idx_checklist_items_section_id ON public.checklist_template_items USING btree (section_id)
--   idx_checklist_items_template_id: CREATE INDEX idx_checklist_items_template_id ON public.checklist_template_items USING btree (template_id)
-- RLS: ENABLED
-- Policies:
--   checklist_template_items_delete  (DELETE)  roles={public}
--   checklist_template_items_insert  (INSERT)  roles={public}
--   checklist_template_items_select  (SELECT)  roles={public}
--   checklist_template_items_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.checklist_template_sections
-- -----------------------------------------------------------------------------
CREATE TABLE public.checklist_template_sections (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  template_id  uuid  NOT NULL,
  name  text  NOT NULL,
  sort_order  integer  NOT NULL  DEFAULT 0,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  requires_section_photo  boolean  NOT NULL  DEFAULT false
);

-- Primary Key:
--   checklist_template_sections_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   checklist_template_sections_template_id_fkey: FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE
-- Indexes:
--   checklist_template_sections_pkey: CREATE UNIQUE INDEX checklist_template_sections_pkey ON public.checklist_template_sections USING btree (id)
--   idx_checklist_sections_template_id: CREATE INDEX idx_checklist_sections_template_id ON public.checklist_template_sections USING btree (template_id)
-- RLS: ENABLED
-- Policies:
--   checklist_template_sections_delete  (DELETE)  roles={public}
--   checklist_template_sections_insert  (INSERT)  roles={public}
--   checklist_template_sections_select  (SELECT)  roles={public}
--   checklist_template_sections_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.checklist_templates
-- -----------------------------------------------------------------------------
CREATE TABLE public.checklist_templates (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  property_id  uuid,
  name  text  NOT NULL,
  description  text,
  is_default  boolean  NOT NULL  DEFAULT false,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   checklist_templates_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   checklist_templates_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   checklist_templates_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
-- Indexes:
--   checklist_templates_pkey: CREATE UNIQUE INDEX checklist_templates_pkey ON public.checklist_templates USING btree (id)
--   idx_checklist_templates_org_id: CREATE INDEX idx_checklist_templates_org_id ON public.checklist_templates USING btree (org_id)
--   idx_checklist_templates_property_id: CREATE INDEX idx_checklist_templates_property_id ON public.checklist_templates USING btree (property_id)
-- RLS: ENABLED
-- Policies:
--   checklist_templates_delete  (DELETE)  roles={public}
--   checklist_templates_insert  (INSERT)  roles={public}
--   checklist_templates_select  (SELECT)  roles={public}
--   checklist_templates_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.communication_logs
-- -----------------------------------------------------------------------------
CREATE TABLE public.communication_logs (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  recipient_type  comm_recipient_type  NOT NULL,
  vendor_id  uuid,
  crew_member_id  uuid,
  channel  comm_channel  NOT NULL  DEFAULT 'email'::comm_channel,
  subject  text,
  body  text,
  property_id  uuid,
  work_order_id  uuid,
  source  comm_source  NOT NULL  DEFAULT 'manual'::comm_source,
  logged_by_user_id  uuid,
  communicated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  deleted_at  timestamp with time zone,
  dedup_key  text
);

-- Primary Key:
--   communication_logs_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   communication_logs_crew_member_id_fkey: FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE SET NULL
--   communication_logs_logged_by_user_id_fkey: FOREIGN KEY (logged_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL
--   communication_logs_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   communication_logs_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL
--   communication_logs_vendor_id_fkey: FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL
--   communication_logs_work_order_id_fkey: FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL
-- Indexes:
--   communication_logs_pkey: CREATE UNIQUE INDEX communication_logs_pkey ON public.communication_logs USING btree (id)
--   idx_comm_logs_communicated_at: CREATE INDEX idx_comm_logs_communicated_at ON public.communication_logs USING btree (communicated_at DESC)
--   idx_comm_logs_crew_member_id: CREATE INDEX idx_comm_logs_crew_member_id ON public.communication_logs USING btree (crew_member_id) WHERE (crew_member_id IS NOT NULL)
--   idx_comm_logs_org_id: CREATE INDEX idx_comm_logs_org_id ON public.communication_logs USING btree (org_id)
--   idx_comm_logs_property_id: CREATE INDEX idx_comm_logs_property_id ON public.communication_logs USING btree (property_id) WHERE (property_id IS NOT NULL)
--   idx_comm_logs_vendor_id: CREATE INDEX idx_comm_logs_vendor_id ON public.communication_logs USING btree (vendor_id) WHERE (vendor_id IS NOT NULL)
--   idx_comm_logs_work_order_id: CREATE INDEX idx_comm_logs_work_order_id ON public.communication_logs USING btree (work_order_id) WHERE (work_order_id IS NOT NULL)
--   idx_comms_log_retention: CREATE INDEX idx_comms_log_retention ON public.communication_logs USING btree (org_id, created_at) WHERE (deleted_at IS NULL)
--   idx_communication_logs_dedup_key: CREATE UNIQUE INDEX idx_communication_logs_dedup_key ON public.communication_logs USING btree (dedup_key) WHERE (dedup_key IS NOT NULL)
--   idx_communication_logs_logged_by_user_id: CREATE INDEX idx_communication_logs_logged_by_user_id ON public.communication_logs USING btree (logged_by_user_id)
--   idx_communication_logs_org_communicated: CREATE INDEX idx_communication_logs_org_communicated ON public.communication_logs USING btree (org_id, communicated_at DESC) WHERE (deleted_at IS NULL)
-- RLS: ENABLED
-- Policies:
--   communication_logs_delete  (DELETE)  roles={public}
--   communication_logs_insert  (INSERT)  roles={public}
--   communication_logs_select  (SELECT)  roles={public}
--   communication_logs_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.crew_availability
-- -----------------------------------------------------------------------------
CREATE TABLE public.crew_availability (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  crew_member_id  uuid  NOT NULL,
  available_date  date  NOT NULL,
  is_available  boolean  NOT NULL  DEFAULT true,
  notes  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   crew_availability_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   crew_availability_crew_member_id_fkey: FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE
-- Unique Constraints:
--   crew_availability_crew_member_id_available_date_key: UNIQUE (crew_member_id, available_date)
-- Indexes:
--   crew_availability_crew_member_id_available_date_key: CREATE UNIQUE INDEX crew_availability_crew_member_id_available_date_key ON public.crew_availability USING btree (crew_member_id, available_date)
--   crew_availability_pkey: CREATE UNIQUE INDEX crew_availability_pkey ON public.crew_availability USING btree (id)
--   idx_crew_availability_lookup: CREATE INDEX idx_crew_availability_lookup ON public.crew_availability USING btree (crew_member_id, available_date)
-- RLS: ENABLED
-- Policies:
--   crew_availability_delete  (DELETE)  roles={public}
--   crew_availability_insert  (INSERT)  roles={public}
--   crew_availability_select  (SELECT)  roles={public}
--   crew_availability_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.crew_feedback
-- -----------------------------------------------------------------------------
CREATE TABLE public.crew_feedback (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  crew_member_id  uuid  NOT NULL,
  property_id  uuid,
  feedback_text  text  NOT NULL,
  submitted_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   crew_feedback_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   crew_feedback_crew_member_id_fkey: FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE
--   crew_feedback_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   crew_feedback_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL
-- Indexes:
--   crew_feedback_crew_member_id_idx: CREATE INDEX crew_feedback_crew_member_id_idx ON public.crew_feedback USING btree (crew_member_id)
--   crew_feedback_org_id_idx: CREATE INDEX crew_feedback_org_id_idx ON public.crew_feedback USING btree (org_id)
--   crew_feedback_pkey: CREATE UNIQUE INDEX crew_feedback_pkey ON public.crew_feedback USING btree (id)
--   idx_crew_feedback_crew_member_id: CREATE INDEX idx_crew_feedback_crew_member_id ON public.crew_feedback USING btree (crew_member_id)
--   idx_crew_feedback_org_id: CREATE INDEX idx_crew_feedback_org_id ON public.crew_feedback USING btree (org_id)
-- RLS: ENABLED
-- Policies:
--   cf_org_members_select  (SELECT)  roles={public}
--   cf_restrict_insert  (INSERT)  roles={public}
--   crew_feedback_manage  (ALL)  roles={public}
--   crew_feedback_select  (SELECT)  roles={public}
--   crew_feedback_staff_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.crew_members
-- -----------------------------------------------------------------------------
CREATE TABLE public.crew_members (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  user_id  uuid,
  name  text  NOT NULL,
  email  text,
  phone  text,
  preferred_contact  contact_pref  DEFAULT 'email'::contact_pref,
  sms_carrier  text,
  specialty  text  DEFAULT 'cleaning'::text,
  is_active  boolean  NOT NULL  DEFAULT true,
  notes  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  invite_token  uuid  DEFAULT gen_random_uuid(),
  invite_sent_at  timestamp with time zone,
  invite_accepted_at  timestamp with time zone,
  role  crew_role  NOT NULL  DEFAULT 'general'::crew_role,
  home_lat  numeric(9,6),
  home_lng  numeric(9,6),
  reliability_score  numeric(4,3)  NOT NULL  DEFAULT 1.0,
  capacity_score  numeric(4,3)  NOT NULL  DEFAULT 1.0,
  home_zip  text,
  external_id  text,
  external_source  text
);

-- Primary Key:
--   crew_members_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   crew_members_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   crew_members_user_id_fkey: FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL
-- Unique Constraints:
--   crew_members_invite_token_key: UNIQUE (invite_token)
-- Check Constraints:
--   crew_members_capacity_score_check: CHECK (((capacity_score >= (0)::numeric) AND (capacity_score <= (1)::numeric)))
--   crew_members_reliability_score_check: CHECK (((reliability_score >= (0)::numeric) AND (reliability_score <= (1)::numeric)))
-- Indexes:
--   crew_members_external_unique: CREATE UNIQUE INDEX crew_members_external_unique ON public.crew_members USING btree (org_id, external_id, external_source)
--   crew_members_invite_token_key: CREATE UNIQUE INDEX crew_members_invite_token_key ON public.crew_members USING btree (invite_token)
--   crew_members_pkey: CREATE UNIQUE INDEX crew_members_pkey ON public.crew_members USING btree (id)
--   crew_members_user_org_unique: CREATE UNIQUE INDEX crew_members_user_org_unique ON public.crew_members USING btree (org_id, user_id) WHERE (user_id IS NOT NULL)
--   idx_crew_members_invite_token: CREATE INDEX idx_crew_members_invite_token ON public.crew_members USING btree (invite_token)
--   idx_crew_members_org_id: CREATE INDEX idx_crew_members_org_id ON public.crew_members USING btree (org_id)
--   idx_crew_members_user_id: CREATE INDEX idx_crew_members_user_id ON public.crew_members USING btree (user_id)
-- RLS: ENABLED
-- Policies:
--   crew_members_delete  (DELETE)  roles={public}
--   crew_members_insert  (INSERT)  roles={public}
--   crew_members_select  (SELECT)  roles={public}
--   crew_members_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.guidebook_configurations
-- -----------------------------------------------------------------------------
CREATE TABLE public.guidebook_configurations (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  is_active  boolean  NOT NULL  DEFAULT false,
  grace_period_ends_at  timestamp with time zone,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  extension_messaging_enabled  boolean  NOT NULL  DEFAULT false,
  extension_gap_threshold_days  integer  NOT NULL  DEFAULT 7,
  extension_discount_pct  integer,
  extension_contact_method  text  DEFAULT 'email'::text,
  extension_ownerrez_url  text,
  extension_message_days_before  integer  NOT NULL  DEFAULT 2,
  trial_ends_at  timestamp with time zone
);

-- Primary Key:
--   guidebook_configurations_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   guidebook_configurations_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
-- Unique Constraints:
--   guidebook_configurations_org_id_key: UNIQUE (org_id)
-- Check Constraints:
--   guidebook_configurations_extension_contact_method_check: CHECK ((extension_contact_method = ANY (ARRAY['ownerrez_url'::text, 'email'::text, 'sms'::text])))
--   guidebook_configurations_extension_discount_pct_check: CHECK (((extension_discount_pct >= 0) AND (extension_discount_pct <= 100)))
-- Indexes:
--   guidebook_configurations_grace_period_idx: CREATE INDEX guidebook_configurations_grace_period_idx ON public.guidebook_configurations USING btree (grace_period_ends_at) WHERE (grace_period_ends_at IS NOT NULL)
--   guidebook_configurations_org_id_idx: CREATE INDEX guidebook_configurations_org_id_idx ON public.guidebook_configurations USING btree (org_id)
--   guidebook_configurations_org_id_key: CREATE UNIQUE INDEX guidebook_configurations_org_id_key ON public.guidebook_configurations USING btree (org_id)
--   guidebook_configurations_pkey: CREATE UNIQUE INDEX guidebook_configurations_pkey ON public.guidebook_configurations USING btree (id)
-- RLS: ENABLED
-- Policies:
--   gc_org_members_select  (SELECT)  roles={public}
--   gc_org_members_update  (UPDATE)  roles={public}
--   gc_restrict_delete  (DELETE)  roles={public}
--   gc_restrict_insert  (INSERT)  roles={public}
--   gc_restrict_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.guidebook_guest_sms_optins
-- -----------------------------------------------------------------------------
CREATE TABLE public.guidebook_guest_sms_optins (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  property_id  uuid  NOT NULL,
  booking_id  uuid  NOT NULL,
  phone_e164  text  NOT NULL,
  is_active  boolean  NOT NULL  DEFAULT true,
  door_code_sent_at  timestamp with time zone,
  last_morning_sms_date  date,
  last_evening_sms_date  date,
  opted_in_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  opted_out_at  timestamp with time zone,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   guidebook_guest_sms_optins_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   guidebook_guest_sms_optins_booking_id_fkey: FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
--   guidebook_guest_sms_optins_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   guidebook_guest_sms_optins_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
-- Unique Constraints:
--   guidebook_guest_sms_optins_booking_id_key: UNIQUE (booking_id)
-- Indexes:
--   guidebook_guest_sms_optins_booking_id_idx: CREATE INDEX guidebook_guest_sms_optins_booking_id_idx ON public.guidebook_guest_sms_optins USING btree (booking_id)
--   guidebook_guest_sms_optins_booking_id_key: CREATE UNIQUE INDEX guidebook_guest_sms_optins_booking_id_key ON public.guidebook_guest_sms_optins USING btree (booking_id)
--   guidebook_guest_sms_optins_org_id_idx: CREATE INDEX guidebook_guest_sms_optins_org_id_idx ON public.guidebook_guest_sms_optins USING btree (org_id)
--   guidebook_guest_sms_optins_phone_idx: CREATE INDEX guidebook_guest_sms_optins_phone_idx ON public.guidebook_guest_sms_optins USING btree (phone_e164) WHERE (is_active = true)
--   guidebook_guest_sms_optins_pkey: CREATE UNIQUE INDEX guidebook_guest_sms_optins_pkey ON public.guidebook_guest_sms_optins USING btree (id)
-- RLS: ENABLED
-- Policies:
--   gso_org_members_manage  (ALL)  roles={public}
--   gso_org_members_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.guidebook_property_configs
-- -----------------------------------------------------------------------------
CREATE TABLE public.guidebook_property_configs (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  property_id  uuid  NOT NULL,
  slug  text  NOT NULL,
  check_in_instructions  text,
  check_out_instructions  text,
  wifi_network  text,
  wifi_password  text,
  house_rules  text,
  is_published  boolean  NOT NULL  DEFAULT false,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   guidebook_property_configs_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   guidebook_property_configs_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   guidebook_property_configs_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
-- Unique Constraints:
--   guidebook_property_configs_org_id_property_id_key: UNIQUE (org_id, property_id)
--   guidebook_property_configs_slug_key: UNIQUE (slug)
-- Indexes:
--   guidebook_property_configs_org_id_property_id_key: CREATE UNIQUE INDEX guidebook_property_configs_org_id_property_id_key ON public.guidebook_property_configs USING btree (org_id, property_id)
--   guidebook_property_configs_pkey: CREATE UNIQUE INDEX guidebook_property_configs_pkey ON public.guidebook_property_configs USING btree (id)
--   guidebook_property_configs_property_id_idx: CREATE INDEX guidebook_property_configs_property_id_idx ON public.guidebook_property_configs USING btree (property_id)
--   guidebook_property_configs_slug_idx: CREATE INDEX guidebook_property_configs_slug_idx ON public.guidebook_property_configs USING btree (slug)
--   guidebook_property_configs_slug_key: CREATE UNIQUE INDEX guidebook_property_configs_slug_key ON public.guidebook_property_configs USING btree (slug)
-- RLS: ENABLED
-- Policies:
--   gpc_org_members_manage  (ALL)  roles={public}
--   gpc_org_members_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.guidebook_sponsors
-- -----------------------------------------------------------------------------
CREATE TABLE public.guidebook_sponsors (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  slot_number  integer  NOT NULL,
  business_name  text  NOT NULL,
  business_description  text,
  business_phone  text,
  business_website  text,
  custom_offer_text  text,
  featured_item  text,
  address  text,
  lat  numeric(10,7),
  lng  numeric(10,7),
  slot_type  text  NOT NULL,
  slot_context  text,
  media_kit_token  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  stripe_customer_id  text,
  stripe_subscription_id  text,
  checkout_session_id  text,
  status  text  NOT NULL  DEFAULT 'pending'::text,
  activated_at  timestamp with time zone,
  deactivated_at  timestamp with time zone,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  offer_type  text  NOT NULL  DEFAULT 'none'::text,
  offer_value  numeric(10,2),
  offer_item  text,
  photo_storage_path  text
);

-- Primary Key:
--   guidebook_sponsors_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   guidebook_sponsors_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
-- Unique Constraints:
--   guidebook_sponsors_org_id_slot_number_key: UNIQUE (org_id, slot_number)
-- Check Constraints:
--   guidebook_sponsors_offer_type_check: CHECK ((offer_type = ANY (ARRAY['percentage'::text, 'fixed_amount'::text, 'item'::text, 'custom'::text, 'none'::text])))
--   guidebook_sponsors_slot_number_check: CHECK (((slot_number >= 1) AND (slot_number <= 6)))
--   guidebook_sponsors_slot_type_check: CHECK ((slot_type = ANY (ARRAY['morning_brew'::text, 'dinner_pints'::text, 'rainy_day'::text, 'outdoor_adventure'::text, 'general'::text, 'other'::text])))
--   guidebook_sponsors_status_check: CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'payment_failed'::text, 'cancelled'::text])))
-- Indexes:
--   guidebook_sponsors_media_kit_token_idx: CREATE INDEX guidebook_sponsors_media_kit_token_idx ON public.guidebook_sponsors USING btree (media_kit_token)
--   guidebook_sponsors_org_id_idx: CREATE INDEX guidebook_sponsors_org_id_idx ON public.guidebook_sponsors USING btree (org_id)
--   guidebook_sponsors_org_id_slot_number_key: CREATE UNIQUE INDEX guidebook_sponsors_org_id_slot_number_key ON public.guidebook_sponsors USING btree (org_id, slot_number)
--   guidebook_sponsors_pkey: CREATE UNIQUE INDEX guidebook_sponsors_pkey ON public.guidebook_sponsors USING btree (id)
--   guidebook_sponsors_status_idx: CREATE INDEX guidebook_sponsors_status_idx ON public.guidebook_sponsors USING btree (status)
-- RLS: ENABLED
-- Policies:
--   gs_org_members_delete  (DELETE)  roles={public}
--   gs_org_members_insert  (INSERT)  roles={public}
--   gs_org_members_select  (SELECT)  roles={public}
--   gs_org_members_update  (UPDATE)  roles={public}
-- -----------------------------------------------------------------------------
-- TABLE: public.ical_feeds
-- -----------------------------------------------------------------------------
CREATE TABLE public.ical_feeds (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  property_id  uuid  NOT NULL,
  org_id  uuid  NOT NULL,
  name  text  NOT NULL,
  url  text  NOT NULL,
  source  ical_source  DEFAULT 'other'::ical_source,
  last_synced_at  timestamp with time zone,
  last_sync_status  sync_status  DEFAULT 'pending'::sync_status,
  last_sync_error  text,
  is_active  boolean  NOT NULL  DEFAULT true,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   ical_feeds_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   ical_feeds_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   ical_feeds_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
-- Check Constraints:
--   ical_feeds_url_must_be_https: CHECK ((url ~~ 'https://%'::text))
-- Indexes:
--   ical_feeds_pkey: CREATE UNIQUE INDEX ical_feeds_pkey ON public.ical_feeds USING btree (id)
--   idx_ical_feeds_org_id: CREATE INDEX idx_ical_feeds_org_id ON public.ical_feeds USING btree (org_id)
--   idx_ical_feeds_property_id: CREATE INDEX idx_ical_feeds_property_id ON public.ical_feeds USING btree (property_id)
-- RLS: ENABLED
-- Policies:
--   ical_feeds_manage  (ALL)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.integration_connections
-- -----------------------------------------------------------------------------
CREATE TABLE public.integration_connections (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  user_id  uuid  NOT NULL,
  provider_id  text  NOT NULL,
  external_user_id  text,
  vault_secret_id  uuid,
  scope  text,
  status  text  NOT NULL  DEFAULT 'active'::text,
  metadata  jsonb  NOT NULL  DEFAULT '{}'::jsonb,
  connected_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  last_used_at  timestamp with time zone,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  refresh_token_vault_secret_id  uuid,
  expires_at  timestamp with time zone,
  org_id  uuid,
  reconnect_email_sent_at  timestamp with time zone
);

-- Primary Key:
--   integration_connections_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   integration_connections_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   integration_connections_provider_id_fkey: FOREIGN KEY (provider_id) REFERENCES integration_providers(id)
--   integration_connections_user_id_fkey: FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
-- Unique Constraints:
--   integration_connections_user_id_provider_id_key: UNIQUE (user_id, provider_id)
--   uq_integration_connections_org_provider: UNIQUE (org_id, provider_id)
-- Check Constraints:
--   integration_connections_status_check: CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'error'::text])))
-- Indexes:
--   idx_integration_connections_org_id: CREATE INDEX idx_integration_connections_org_id ON public.integration_connections USING btree (org_id)
--   idx_integration_connections_provider_id: CREATE INDEX idx_integration_connections_provider_id ON public.integration_connections USING btree (provider_id)
--   integration_connections_org_provider_active_uniq: CREATE UNIQUE INDEX integration_connections_org_provider_active_uniq ON public.integration_connections USING btree (org_id, provider_id) WHERE ((status = 'active'::text) AND (org_id IS NOT NULL))
--   integration_connections_pkey: CREATE UNIQUE INDEX integration_connections_pkey ON public.integration_connections USING btree (id)
--   integration_connections_user_id_provider_id_key: CREATE UNIQUE INDEX integration_connections_user_id_provider_id_key ON public.integration_connections USING btree (user_id, provider_id)
--   uq_integration_connections_org_provider: CREATE UNIQUE INDEX uq_integration_connections_org_provider ON public.integration_connections USING btree (org_id, provider_id)
-- RLS: ENABLED
-- Policies:
--   integration_connections_deny_delete  (DELETE)  roles={public}
--   integration_connections_deny_insert  (INSERT)  roles={public}
--   integration_connections_deny_update  (UPDATE)  roles={public}
--   integration_connections_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.integration_providers
-- -----------------------------------------------------------------------------
CREATE TABLE public.integration_providers (
  id  text  NOT NULL,
  display_name  text  NOT NULL,
  auth_type  text  NOT NULL,
  is_active  boolean  NOT NULL  DEFAULT true,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   integration_providers_pkey: PRIMARY KEY (id)
-- Check Constraints:
--   integration_providers_auth_type_check: CHECK ((auth_type = ANY (ARRAY['oauth2'::text, 'api_key'::text])))
-- Indexes:
--   integration_providers_pkey: CREATE UNIQUE INDEX integration_providers_pkey ON public.integration_providers USING btree (id)
-- RLS: ENABLED
-- Policies:
--   Anyone can read active providers  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.inventory_catalog
-- -----------------------------------------------------------------------------
CREATE TABLE public.inventory_catalog (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  name  text  NOT NULL,
  category  inventory_category  NOT NULL  DEFAULT 'other'::inventory_category,
  default_unit  text  NOT NULL  DEFAULT 'units'::text,
  description  text,
  is_active  boolean  NOT NULL  DEFAULT true,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   inventory_catalog_pkey: PRIMARY KEY (id)
-- Indexes:
--   inventory_catalog_pkey: CREATE UNIQUE INDEX inventory_catalog_pkey ON public.inventory_catalog USING btree (id)
-- RLS: ENABLED
-- Policies:
--   inventory_catalog_read  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.inventory_count_draft_items
-- -----------------------------------------------------------------------------
CREATE TABLE public.inventory_count_draft_items (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  draft_id  uuid  NOT NULL,
  item_id  uuid  NOT NULL,
  counted_qty  integer  NOT NULL  DEFAULT 0,
  note  text,
  previous_quantity  integer  NOT NULL  DEFAULT 0,
  notes  text
);

-- Primary Key:
--   inventory_count_draft_items_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   inventory_count_draft_items_draft_id_fkey: FOREIGN KEY (draft_id) REFERENCES inventory_count_drafts(id) ON DELETE CASCADE
--   inventory_count_draft_items_item_id_fkey: FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE CASCADE
-- Indexes:
--   idx_inventory_count_draft_items_draft_id: CREATE INDEX idx_inventory_count_draft_items_draft_id ON public.inventory_count_draft_items USING btree (draft_id)
--   idx_inventory_count_draft_items_item_id: CREATE INDEX idx_inventory_count_draft_items_item_id ON public.inventory_count_draft_items USING btree (item_id)
--   inventory_count_draft_items_pkey: CREATE UNIQUE INDEX inventory_count_draft_items_pkey ON public.inventory_count_draft_items USING btree (id)
-- RLS: ENABLED
-- Policies:
--   inventory_count_draft_items_delete  (DELETE)  roles={public}
--   inventory_count_draft_items_insert  (INSERT)  roles={public}
--   inventory_count_draft_items_select  (SELECT)  roles={public}
--   inventory_count_draft_items_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.inventory_count_drafts
-- -----------------------------------------------------------------------------
CREATE TABLE public.inventory_count_drafts (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  property_id  uuid  NOT NULL,
  org_id  uuid  NOT NULL,
  submitted_by  uuid,
  status  text  NOT NULL  DEFAULT 'draft'::text,
  notes  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   inventory_count_drafts_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   inventory_count_drafts_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
--   inventory_count_drafts_submitted_by_fkey: FOREIGN KEY (submitted_by) REFERENCES crew_members(id) ON DELETE SET NULL
-- Check Constraints:
--   inventory_count_drafts_status_check: CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'approved'::text, 'rejected'::text])))
-- Indexes:
--   idx_inventory_count_drafts_property_id: CREATE INDEX idx_inventory_count_drafts_property_id ON public.inventory_count_drafts USING btree (property_id)
--   idx_inventory_count_drafts_submitted_by: CREATE INDEX idx_inventory_count_drafts_submitted_by ON public.inventory_count_drafts USING btree (submitted_by)
--   inventory_count_drafts_pkey: CREATE UNIQUE INDEX inventory_count_drafts_pkey ON public.inventory_count_drafts USING btree (id)
-- RLS: ENABLED
-- Policies:
--   inventory_count_drafts_delete  (DELETE)  roles={public}
--   inventory_count_drafts_insert  (INSERT)  roles={public}
--   inventory_count_drafts_select  (SELECT)  roles={public}
--   inventory_count_drafts_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.inventory_count_items
-- -----------------------------------------------------------------------------
CREATE TABLE public.inventory_count_items (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  count_id  uuid  NOT NULL,
  inventory_item_id  uuid  NOT NULL,
  quantity_counted  integer  NOT NULL,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   inventory_count_items_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   inventory_count_items_count_id_fkey: FOREIGN KEY (count_id) REFERENCES inventory_counts(id) ON DELETE CASCADE
--   inventory_count_items_inventory_item_id_fkey: FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE
-- Indexes:
--   idx_inventory_count_items_count_id: CREATE INDEX idx_inventory_count_items_count_id ON public.inventory_count_items USING btree (count_id)
--   idx_inventory_count_items_inventory_item_id: CREATE INDEX idx_inventory_count_items_inventory_item_id ON public.inventory_count_items USING btree (inventory_item_id)
--   inventory_count_items_pkey: CREATE UNIQUE INDEX inventory_count_items_pkey ON public.inventory_count_items USING btree (id)
-- RLS: ENABLED
-- Policies:
--   count_items_admin_manager_insert  (INSERT)  roles={public}
--   count_items_crew_insert  (INSERT)  roles={public}
--   count_items_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.inventory_counts
-- -----------------------------------------------------------------------------
CREATE TABLE public.inventory_counts (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  property_id  uuid  NOT NULL,
  org_id  uuid  NOT NULL,
  submitted_by_crew_id  uuid,
  submitted_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  notes  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   inventory_counts_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   inventory_counts_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   inventory_counts_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
--   inventory_counts_submitted_by_crew_id_fkey: FOREIGN KEY (submitted_by_crew_id) REFERENCES crew_members(id) ON DELETE SET NULL
-- Indexes:
--   idx_inventory_counts_org_id: CREATE INDEX idx_inventory_counts_org_id ON public.inventory_counts USING btree (org_id)
--   idx_inventory_counts_property_id: CREATE INDEX idx_inventory_counts_property_id ON public.inventory_counts USING btree (property_id)
--   idx_inventory_counts_submitted_by_crew_id: CREATE INDEX idx_inventory_counts_submitted_by_crew_id ON public.inventory_counts USING btree (submitted_by_crew_id)
--   inventory_counts_pkey: CREATE UNIQUE INDEX inventory_counts_pkey ON public.inventory_counts USING btree (id)
-- RLS: ENABLED
-- Policies:
--   inventory_counts_admin_manager_insert  (INSERT)  roles={public}
--   inventory_counts_crew_insert  (INSERT)  roles={public}
--   inventory_counts_delete  (DELETE)  roles={public}
--   inventory_counts_select  (SELECT)  roles={public}
--   inventory_counts_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.inventory_items
-- -----------------------------------------------------------------------------
CREATE TABLE public.inventory_items (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  property_id  uuid  NOT NULL,
  org_id  uuid  NOT NULL,
  catalog_item_id  uuid,
  name  text  NOT NULL,
  category  inventory_category  NOT NULL  DEFAULT 'other'::inventory_category,
  unit  text  NOT NULL  DEFAULT 'units'::text,
  par_level  numeric  NOT NULL  DEFAULT 0,
  current_quantity  integer  NOT NULL  DEFAULT 0,
  low_stock_threshold_pct  integer  NOT NULL  DEFAULT 30,
  is_active  boolean  NOT NULL  DEFAULT true,
  notes  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  preferred_brand  text,
  first_count_recorded_at  timestamp with time zone
);

-- Primary Key:
--   inventory_items_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   inventory_items_catalog_item_id_fkey: FOREIGN KEY (catalog_item_id) REFERENCES inventory_catalog(id) ON DELETE SET NULL
--   inventory_items_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   inventory_items_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
-- Indexes:
--   idx_inventory_items_brand: CREATE INDEX idx_inventory_items_brand ON public.inventory_items USING btree (org_id, preferred_brand) WHERE (preferred_brand IS NOT NULL)
--   idx_inventory_items_catalog_item_id: CREATE INDEX idx_inventory_items_catalog_item_id ON public.inventory_items USING btree (catalog_item_id)
--   idx_inventory_items_org_id: CREATE INDEX idx_inventory_items_org_id ON public.inventory_items USING btree (org_id)
--   idx_inventory_items_property_id: CREATE INDEX idx_inventory_items_property_id ON public.inventory_items USING btree (property_id)
--   inventory_items_pkey: CREATE UNIQUE INDEX inventory_items_pkey ON public.inventory_items USING btree (id)
-- RLS: ENABLED
-- Policies:
--   inventory_items_delete  (DELETE)  roles={public}
--   inventory_items_insert  (INSERT)  roles={public}
--   inventory_items_select  (SELECT)  roles={public}
--   inventory_items_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.inventory_template_items
-- -----------------------------------------------------------------------------
CREATE TABLE public.inventory_template_items (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  template_id  uuid  NOT NULL,
  name  text  NOT NULL,
  category  text,
  unit  text,
  par_qty  integer  NOT NULL  DEFAULT 0,
  sort_order  integer  NOT NULL  DEFAULT 0,
  par_level  numeric  NOT NULL  DEFAULT 1,
  preferred_brand  text,
  notes  text,
  catalog_item_id  uuid
);

-- Primary Key:
--   inventory_template_items_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   inventory_template_items_catalog_item_id_fkey: FOREIGN KEY (catalog_item_id) REFERENCES inventory_catalog(id) ON DELETE SET NULL
--   inventory_template_items_template_id_fkey: FOREIGN KEY (template_id) REFERENCES inventory_templates(id) ON DELETE CASCADE
-- Indexes:
--   idx_inventory_template_items_catalog_item_id: CREATE INDEX idx_inventory_template_items_catalog_item_id ON public.inventory_template_items USING btree (catalog_item_id)
--   idx_inventory_template_items_template_id: CREATE INDEX idx_inventory_template_items_template_id ON public.inventory_template_items USING btree (template_id)
--   inventory_template_items_pkey: CREATE UNIQUE INDEX inventory_template_items_pkey ON public.inventory_template_items USING btree (id)
-- RLS: ENABLED
-- Policies:
--   inventory_template_items_delete  (DELETE)  roles={public}
--   inventory_template_items_insert  (INSERT)  roles={public}
--   inventory_template_items_select  (SELECT)  roles={public}
--   inventory_template_items_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.inventory_templates
-- -----------------------------------------------------------------------------
CREATE TABLE public.inventory_templates (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  name  text  NOT NULL,
  description  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   inventory_templates_pkey: PRIMARY KEY (id)
-- Indexes:
--   inventory_templates_org_unique: CREATE UNIQUE INDEX inventory_templates_org_unique ON public.inventory_templates USING btree (org_id)
--   inventory_templates_pkey: CREATE UNIQUE INDEX inventory_templates_pkey ON public.inventory_templates USING btree (id)
-- RLS: ENABLED
-- Policies:
--   inventory_templates_delete  (DELETE)  roles={public}
--   inventory_templates_insert  (INSERT)  roles={public}
--   inventory_templates_select  (SELECT)  roles={public}
--   inventory_templates_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.maintenance_catalog_items
-- -----------------------------------------------------------------------------
CREATE TABLE public.maintenance_catalog_items (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  name  text  NOT NULL,
  category  text  NOT NULL,
  suggested_recurrence  text,
  asset_category  text,
  description  text,
  sort_order  integer  NOT NULL  DEFAULT 0,
  is_active  boolean  NOT NULL  DEFAULT true,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   maintenance_catalog_items_pkey: PRIMARY KEY (id)
-- Indexes:
--   maintenance_catalog_items_pkey: CREATE UNIQUE INDEX maintenance_catalog_items_pkey ON public.maintenance_catalog_items USING btree (id)
-- RLS: ENABLED
-- Policies:
--   catalog_items_authenticated_read  (SELECT)  roles={public}
--   catalog_items_service_role  (ALL)  roles={service_role}

-- -----------------------------------------------------------------------------
-- TABLE: public.maintenance_completions
-- -----------------------------------------------------------------------------
CREATE TABLE public.maintenance_completions (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  maintenance_schedule_id  uuid  NOT NULL,
  property_id  uuid  NOT NULL,
  org_id  uuid  NOT NULL,
  asset_category  text,
  completed_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  completed_by  uuid,
  notes  text,
  work_order_id  uuid,
  next_due_date_set  date,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   maintenance_completions_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   maintenance_completions_completed_by_fkey: FOREIGN KEY (completed_by) REFERENCES auth.users(id) ON DELETE SET NULL
--   maintenance_completions_maintenance_schedule_id_fkey: FOREIGN KEY (maintenance_schedule_id) REFERENCES maintenance_schedules(id) ON DELETE CASCADE
--   maintenance_completions_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   maintenance_completions_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
-- Indexes:
--   idx_maintenance_completions_asset: CREATE INDEX idx_maintenance_completions_asset ON public.maintenance_completions USING btree (org_id, asset_category, completed_at DESC) WHERE (asset_category IS NOT NULL)
--   idx_maintenance_completions_completed_by: CREATE INDEX idx_maintenance_completions_completed_by ON public.maintenance_completions USING btree (completed_by)
--   idx_maintenance_completions_property: CREATE INDEX idx_maintenance_completions_property ON public.maintenance_completions USING btree (property_id, completed_at DESC)
--   idx_maintenance_completions_schedule: CREATE INDEX idx_maintenance_completions_schedule ON public.maintenance_completions USING btree (maintenance_schedule_id, completed_at DESC)
--   maintenance_completions_pkey: CREATE UNIQUE INDEX maintenance_completions_pkey ON public.maintenance_completions USING btree (id)
-- RLS: ENABLED
-- Policies:
--   maintenance_completions_delete  (DELETE)  roles={public}
--   maintenance_completions_insert  (INSERT)  roles={public}
--   maintenance_completions_select  (SELECT)  roles={public}
--   maintenance_completions_service  (ALL)  roles={service_role}
--   maintenance_completions_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.maintenance_schedule_template_items
-- -----------------------------------------------------------------------------
CREATE TABLE public.maintenance_schedule_template_items (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  template_id  uuid  NOT NULL,
  name  text  NOT NULL,
  description  text,
  schedule_frequency  schedule_frequency  NOT NULL,
  vendor_specialty_hint  vendor_specialty,
  estimated_cost  numeric(10,2),
  is_optional_flag  text,
  sort_order  integer  NOT NULL  DEFAULT 0,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  asset_category  text,
  active_from_month  integer,
  active_to_month  integer
);

-- Primary Key:
--   maintenance_schedule_template_items_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   maintenance_schedule_template_items_template_id_fkey: FOREIGN KEY (template_id) REFERENCES maintenance_schedule_templates(id) ON DELETE CASCADE
-- Check Constraints:
--   maintenance_schedule_template_items_active_from_month_check: CHECK (((active_from_month >= 1) AND (active_from_month <= 12)))
--   maintenance_schedule_template_items_active_to_month_check: CHECK (((active_to_month >= 1) AND (active_to_month <= 12)))
-- Indexes:
--   idx_maintenance_schedule_template_items_template_id: CREATE INDEX idx_maintenance_schedule_template_items_template_id ON public.maintenance_schedule_template_items USING btree (template_id)
--   maintenance_schedule_template_items_pkey: CREATE UNIQUE INDEX maintenance_schedule_template_items_pkey ON public.maintenance_schedule_template_items USING btree (id)
-- RLS: ENABLED
-- Policies:
--   maintenance_schedule_template_items_delete  (DELETE)  roles={public}
--   maintenance_schedule_template_items_insert  (INSERT)  roles={public}
--   maintenance_schedule_template_items_select  (SELECT)  roles={public}
--   maintenance_schedule_template_items_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.maintenance_schedule_templates
-- -----------------------------------------------------------------------------
CREATE TABLE public.maintenance_schedule_templates (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  name  text  NOT NULL,
  description  text,
  is_system  boolean  NOT NULL  DEFAULT false,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   maintenance_schedule_templates_pkey: PRIMARY KEY (id)
-- Indexes:
--   maintenance_schedule_templates_pkey: CREATE UNIQUE INDEX maintenance_schedule_templates_pkey ON public.maintenance_schedule_templates USING btree (id)
-- RLS: ENABLED
-- Policies:
--   maintenance_schedule_templates_delete  (DELETE)  roles={public}
--   maintenance_schedule_templates_insert  (INSERT)  roles={public}
--   maintenance_schedule_templates_select  (SELECT)  roles={public}
--   maintenance_schedule_templates_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.maintenance_schedules
-- -----------------------------------------------------------------------------
CREATE TABLE public.maintenance_schedules (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  property_id  uuid  NOT NULL,
  org_id  uuid  NOT NULL,
  assigned_vendor_id  uuid,
  name  text  NOT NULL,
  description  text,
  schedule_type  schedule_type  NOT NULL  DEFAULT 'routine'::schedule_type,
  frequency  schedule_frequency,
  month_due  integer,
  day_of_month_due  integer,
  estimated_cost  numeric(10,2),
  instructions  text,
  auto_create_wo  boolean  NOT NULL  DEFAULT true,
  last_completed_date  date,
  next_due_date  date,
  is_active  boolean  NOT NULL  DEFAULT true,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  vendor_specialty_hint  vendor_specialty,
  active_from_month  integer,
  active_to_month  integer,
  asset_category  text,
  is_from_standard_template  boolean  NOT NULL  DEFAULT false,
  source_template_item_id  uuid,
  source_catalog_item_id  uuid
);

-- Primary Key:
--   maintenance_schedules_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   maintenance_schedules_assigned_vendor_id_fkey: FOREIGN KEY (assigned_vendor_id) REFERENCES vendors(id) ON DELETE SET NULL
--   maintenance_schedules_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   maintenance_schedules_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
--   maintenance_schedules_source_template_item_id_fkey: FOREIGN KEY (source_template_item_id) REFERENCES maintenance_schedule_template_items(id) ON DELETE SET NULL
-- Check Constraints:
--   maintenance_schedules_active_from_month_check: CHECK (((active_from_month >= 1) AND (active_from_month <= 12)))
--   maintenance_schedules_active_to_month_check: CHECK (((active_to_month >= 1) AND (active_to_month <= 12)))
--   maintenance_schedules_day_of_month_due_check: CHECK (((day_of_month_due >= 1) AND (day_of_month_due <= 31)))
--   maintenance_schedules_month_due_check: CHECK (((month_due >= 1) AND (month_due <= 12)))
-- Indexes:
--   idx_maintenance_schedules_assigned_vendor_id: CREATE INDEX idx_maintenance_schedules_assigned_vendor_id ON public.maintenance_schedules USING btree (assigned_vendor_id)
--   idx_maintenance_schedules_next_due: CREATE INDEX idx_maintenance_schedules_next_due ON public.maintenance_schedules USING btree (next_due_date)
--   idx_maintenance_schedules_org_due: CREATE INDEX idx_maintenance_schedules_org_due ON public.maintenance_schedules USING btree (org_id, next_due_date) WHERE (is_active = true)
--   idx_maintenance_schedules_org_id: CREATE INDEX idx_maintenance_schedules_org_id ON public.maintenance_schedules USING btree (org_id)
--   idx_maintenance_schedules_property_due: CREATE INDEX idx_maintenance_schedules_property_due ON public.maintenance_schedules USING btree (property_id, next_due_date) WHERE (is_active = true)
--   idx_maintenance_schedules_property_id: CREATE INDEX idx_maintenance_schedules_property_id ON public.maintenance_schedules USING btree (property_id)
--   idx_maintenance_schedules_source_template_item_id: CREATE INDEX idx_maintenance_schedules_source_template_item_id ON public.maintenance_schedules USING btree (source_template_item_id)
--   maintenance_schedules_pkey: CREATE UNIQUE INDEX maintenance_schedules_pkey ON public.maintenance_schedules USING btree (id)
-- RLS: ENABLED
-- Policies:
--   maintenance_schedules_delete  (DELETE)  roles={public}
--   maintenance_schedules_insert  (INSERT)  roles={public}
--   maintenance_schedules_select  (SELECT)  roles={public}
--   maintenance_schedules_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.messages
-- -----------------------------------------------------------------------------
CREATE TABLE public.messages (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  sender_id  uuid  NOT NULL,
  recipient_id  uuid  NOT NULL,
  content  text  NOT NULL,
  read_at  timestamp with time zone,
  turnover_id  uuid,
  work_order_id  uuid,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  group_id  uuid,
  group_label  text
);

-- Primary Key:
--   messages_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   messages_turnover_id_fkey: FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE SET NULL
--   messages_work_order_id_fkey: FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL
-- Check Constraints:
--   messages_content_check: CHECK ((char_length(content) > 0))
-- Indexes:
--   idx_messages_conversation: CREATE INDEX idx_messages_conversation ON public.messages USING btree (org_id, sender_id, recipient_id, created_at DESC)
--   idx_messages_group_id: CREATE INDEX idx_messages_group_id ON public.messages USING btree (group_id) WHERE (group_id IS NOT NULL)
--   idx_messages_recipient_unread: CREATE INDEX idx_messages_recipient_unread ON public.messages USING btree (recipient_id, read_at) WHERE (read_at IS NULL)
--   idx_messages_turnover_id: CREATE INDEX idx_messages_turnover_id ON public.messages USING btree (turnover_id)
--   idx_messages_work_order_id: CREATE INDEX idx_messages_work_order_id ON public.messages USING btree (work_order_id)
--   messages_pkey: CREATE UNIQUE INDEX messages_pkey ON public.messages USING btree (id)
-- RLS: ENABLED
-- Policies:
--   messages_delete  (DELETE)  roles={public}
--   messages_insert  (INSERT)  roles={public}
--   messages_mark_read  (UPDATE)  roles={public}
--   messages_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.oauth_states
-- -----------------------------------------------------------------------------
CREATE TABLE public.oauth_states (
  state  text  NOT NULL,
  user_id  uuid,
  provider_id  text  NOT NULL,
  return_to  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  expires_at  timestamp with time zone  NOT NULL  DEFAULT (now() + '00:10:00'::interval)
);

-- Primary Key:
--   oauth_states_pkey: PRIMARY KEY (state)
-- Foreign Keys:
--   oauth_states_user_id_fkey: FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
-- Indexes:
--   idx_oauth_states_user_id: CREATE INDEX idx_oauth_states_user_id ON public.oauth_states USING btree (user_id)
--   oauth_states_expires_at_idx: CREATE INDEX oauth_states_expires_at_idx ON public.oauth_states USING btree (expires_at)
--   oauth_states_pkey: CREATE UNIQUE INDEX oauth_states_pkey ON public.oauth_states USING btree (state)
-- RLS: ENABLED
-- Policies: (none)

-- -----------------------------------------------------------------------------
-- TABLE: public.org_invites
-- -----------------------------------------------------------------------------
CREATE TABLE public.org_invites (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  invited_by  uuid  NOT NULL,
  email  text  NOT NULL,
  role  member_role  NOT NULL  DEFAULT 'admin'::member_role,
  token  text  NOT NULL  DEFAULT encode(gen_random_bytes(32), 'hex'::text),
  expires_at  timestamp with time zone  NOT NULL  DEFAULT (now() + '7 days'::interval),
  accepted_at  timestamp with time zone,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   org_invites_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   org_invites_invited_by_fkey: FOREIGN KEY (invited_by) REFERENCES auth.users(id)
--   org_invites_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
-- Unique Constraints:
--   org_invites_token_key: UNIQUE (token)
-- Check Constraints:
--   org_invites_role_check: CHECK ((role = 'admin'::member_role))
-- Indexes:
--   idx_org_invites_email: CREATE INDEX idx_org_invites_email ON public.org_invites USING btree (email)
--   idx_org_invites_invited_by: CREATE INDEX idx_org_invites_invited_by ON public.org_invites USING btree (invited_by)
--   idx_org_invites_org_id: CREATE INDEX idx_org_invites_org_id ON public.org_invites USING btree (org_id)
--   idx_org_invites_token: CREATE INDEX idx_org_invites_token ON public.org_invites USING btree (token)
--   org_invites_active_email_unique: CREATE UNIQUE INDEX org_invites_active_email_unique ON public.org_invites USING btree (org_id, email) WHERE (accepted_at IS NULL)
--   org_invites_pkey: CREATE UNIQUE INDEX org_invites_pkey ON public.org_invites USING btree (id)
--   org_invites_token_key: CREATE UNIQUE INDEX org_invites_token_key ON public.org_invites USING btree (token)
-- RLS: ENABLED
-- Policies:
--   Owners can manage org invites  (ALL)  roles={public}
-- -----------------------------------------------------------------------------
-- TABLE: public.org_master_checklist_items
-- -----------------------------------------------------------------------------
CREATE TABLE public.org_master_checklist_items (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  section  text  NOT NULL,
  task  text  NOT NULL,
  sort_order  integer  NOT NULL  DEFAULT 0,
  source  text  NOT NULL  DEFAULT 'catalog'::text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   org_master_checklist_items_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   org_master_checklist_items_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
-- Indexes:
--   idx_org_master_checklist_org_id: CREATE INDEX idx_org_master_checklist_org_id ON public.org_master_checklist_items USING btree (org_id)
--   org_master_checklist_items_pkey: CREATE UNIQUE INDEX org_master_checklist_items_pkey ON public.org_master_checklist_items USING btree (id)
-- RLS: ENABLED
-- Policies:
--   Admins and managers manage master checklist  (ALL)  roles={public}
--   org_master_checklist_items_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.org_master_maintenance_schedules
-- -----------------------------------------------------------------------------
CREATE TABLE public.org_master_maintenance_schedules (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  title  text  NOT NULL,
  description  text,
  frequency  text  NOT NULL  DEFAULT 'monthly'::text,
  month_day  integer,
  week_day  integer,
  estimated_cost  numeric(10,2),
  specialty  text,
  notes  text,
  is_active  boolean  NOT NULL  DEFAULT true,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   org_master_maintenance_schedules_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   org_master_maintenance_schedules_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
-- Indexes:
--   idx_org_master_maintenance_org_id: CREATE INDEX idx_org_master_maintenance_org_id ON public.org_master_maintenance_schedules USING btree (org_id)
--   org_master_maintenance_schedules_pkey: CREATE UNIQUE INDEX org_master_maintenance_schedules_pkey ON public.org_master_maintenance_schedules USING btree (id)
-- RLS: ENABLED
-- Policies:
--   Admins managers owners manage master maintenance  (ALL)  roles={public}
--   org_master_maintenance_schedules_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.org_milestones
-- -----------------------------------------------------------------------------
CREATE TABLE public.org_milestones (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  milestone  text  NOT NULL,
  achieved_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  prompted_at  timestamp with time zone,
  review_clicked  boolean  NOT NULL  DEFAULT false,
  dismissed  boolean  NOT NULL  DEFAULT false,
  value  jsonb
);

-- Primary Key:
--   org_milestones_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   org_milestones_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
-- Unique Constraints:
--   org_milestones_org_id_milestone_key: UNIQUE (org_id, milestone)
-- Indexes:
--   idx_org_milestones_org_id: CREATE INDEX idx_org_milestones_org_id ON public.org_milestones USING btree (org_id)
--   org_milestones_org_id_milestone_key: CREATE UNIQUE INDEX org_milestones_org_id_milestone_key ON public.org_milestones USING btree (org_id, milestone)
--   org_milestones_pkey: CREATE UNIQUE INDEX org_milestones_pkey ON public.org_milestones USING btree (id)
-- RLS: ENABLED
-- Policies:
--   org_milestones_delete  (DELETE)  roles={public}
--   org_milestones_insert  (INSERT)  roles={public}
--   org_milestones_select  (SELECT)  roles={public}
--   org_milestones_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.org_sms_templates
-- -----------------------------------------------------------------------------
CREATE TABLE public.org_sms_templates (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  key  text  NOT NULL,
  body  text  NOT NULL,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   org_sms_templates_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   org_sms_templates_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
-- Unique Constraints:
--   org_sms_templates_org_key_unique: UNIQUE (org_id, key)
-- Check Constraints:
--   org_sms_templates_body_check: CHECK (((char_length(body) >= 1) AND (char_length(body) <= 1000)))
-- Indexes:
--   idx_org_sms_templates_org_id: CREATE INDEX idx_org_sms_templates_org_id ON public.org_sms_templates USING btree (org_id)
--   org_sms_templates_org_key_unique: CREATE UNIQUE INDEX org_sms_templates_org_key_unique ON public.org_sms_templates USING btree (org_id, key)
--   org_sms_templates_pkey: CREATE UNIQUE INDEX org_sms_templates_pkey ON public.org_sms_templates USING btree (id)
-- RLS: ENABLED
-- Policies:
--   org_sms_templates_delete  (DELETE)  roles={authenticated}
--   org_sms_templates_insert  (INSERT)  roles={authenticated}
--   org_sms_templates_select  (SELECT)  roles={authenticated}
--   org_sms_templates_update  (UPDATE)  roles={authenticated}

-- -----------------------------------------------------------------------------
-- TABLE: public.organization_members
-- -----------------------------------------------------------------------------
CREATE TABLE public.organization_members (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  user_id  uuid,
  role  member_role  NOT NULL  DEFAULT 'viewer'::member_role,
  invited_email  text,
  invite_token  uuid  DEFAULT gen_random_uuid(),
  invite_accepted_at  timestamp with time zone,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   organization_members_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   organization_members_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   organization_members_user_id_fkey: FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
-- Unique Constraints:
--   organization_members_invite_token_key: UNIQUE (invite_token)
--   organization_members_org_id_user_id_key: UNIQUE (org_id, user_id)
-- Indexes:
--   idx_org_members_invite_token: CREATE INDEX idx_org_members_invite_token ON public.organization_members USING btree (invite_token)
--   idx_org_members_org_id: CREATE INDEX idx_org_members_org_id ON public.organization_members USING btree (org_id)
--   idx_org_members_user_id: CREATE INDEX idx_org_members_user_id ON public.organization_members USING btree (user_id)
--   organization_members_invite_token_key: CREATE UNIQUE INDEX organization_members_invite_token_key ON public.organization_members USING btree (invite_token)
--   organization_members_org_id_user_id_key: CREATE UNIQUE INDEX organization_members_org_id_user_id_key ON public.organization_members USING btree (org_id, user_id)
--   organization_members_pkey: CREATE UNIQUE INDEX organization_members_pkey ON public.organization_members USING btree (id)
-- RLS: ENABLED
-- Policies:
--   org_members_admin_delete  (DELETE)  roles={public}
--   org_members_admin_manage  (UPDATE)  roles={public}
--   org_members_insert_self  (INSERT)  roles={public}
--   org_members_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.organizations
-- -----------------------------------------------------------------------------
CREATE TABLE public.organizations (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  name  text  NOT NULL,
  slug  text  NOT NULL,
  billing_email  text,
  stripe_customer_id  text,
  stripe_subscription_id  text,
  plan  org_plan  NOT NULL  DEFAULT 'starter'::org_plan,
  plan_status  org_plan_status  NOT NULL  DEFAULT 'trialing'::org_plan_status,
  trial_ends_at  timestamp with time zone,
  max_properties  integer  NOT NULL  DEFAULT 5,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  repuguard_status  text  DEFAULT 'inactive'::text,
  repuguard_trial_start  timestamp with time zone,
  repuguard_trial_end  timestamp with time zone,
  repuguard_stripe_subscription_id  text,
  repuguard_founding_member  boolean  NOT NULL  DEFAULT false,
  onboarding_steps_completed  jsonb  NOT NULL  DEFAULT '{}'::jsonb,
  auto_assign_mode  text  NOT NULL  DEFAULT 'suggest'::text,
  auto_assign_enabled  boolean  NOT NULL  DEFAULT true,
  preferred_retailer  text  DEFAULT 'walmart'::text,
  kroger_location_id  text,
  kroger_location_name  text,
  comms_log_retention_days  smallint  NOT NULL  DEFAULT 365,
  slack_webhook_url  text
);
-- NOTE: attnum sequence has a gap (23 -> 27); columns at ordinal positions 24-26 were dropped from this table.

-- Primary Key:
--   organizations_pkey: PRIMARY KEY (id)
-- Unique Constraints:
--   organizations_slug_key: UNIQUE (slug)
--   organizations_stripe_customer_id_key: UNIQUE (stripe_customer_id)
--   organizations_stripe_subscription_id_key: UNIQUE (stripe_subscription_id)
-- Check Constraints:
--   organizations_auto_assign_mode_check: CHECK ((auto_assign_mode = ANY (ARRAY['suggest'::text, 'autopilot'::text, 'disabled'::text])))
--   organizations_preferred_retailer_check: CHECK ((preferred_retailer = ANY (ARRAY['walmart'::text, 'kroger'::text, 'amazon_business'::text, 'none'::text])))
--   organizations_repuguard_status_check: CHECK ((repuguard_status = ANY (ARRAY['inactive'::text, 'trial'::text, 'active'::text, 'cancelled'::text])))
-- Indexes:
--   organizations_pkey: CREATE UNIQUE INDEX organizations_pkey ON public.organizations USING btree (id)
--   organizations_slug_key: CREATE UNIQUE INDEX organizations_slug_key ON public.organizations USING btree (slug)
--   organizations_stripe_customer_id_key: CREATE UNIQUE INDEX organizations_stripe_customer_id_key ON public.organizations USING btree (stripe_customer_id)
--   organizations_stripe_subscription_id_key: CREATE UNIQUE INDEX organizations_stripe_subscription_id_key ON public.organizations USING btree (stripe_subscription_id)
-- RLS: ENABLED
-- Policies:
--   orgs_insert  (INSERT)  roles={public}
--   orgs_select  (SELECT)  roles={public}
--   orgs_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.owner_portal_tokens
-- -----------------------------------------------------------------------------
CREATE TABLE public.owner_portal_tokens (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  property_owner_id  uuid  NOT NULL,
  token  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  expires_at  timestamp with time zone,
  last_accessed_at  timestamp with time zone,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  revoked_at  timestamp with time zone,
  property_ids  uuid[],
  is_multi  boolean  NOT NULL  DEFAULT false
);

-- Primary Key:
--   owner_portal_tokens_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   owner_portal_tokens_property_owner_id_fkey: FOREIGN KEY (property_owner_id) REFERENCES property_owners(id) ON DELETE CASCADE
-- Unique Constraints:
--   owner_portal_tokens_owner_type_unique: UNIQUE (property_owner_id, is_multi)
--   owner_portal_tokens_token_key: UNIQUE (token)
-- Indexes:
--   idx_owner_portal_revoked: CREATE INDEX idx_owner_portal_revoked ON public.owner_portal_tokens USING btree (revoked_at) WHERE (revoked_at IS NOT NULL)
--   idx_owner_portal_tokens_revoked: CREATE INDEX idx_owner_portal_tokens_revoked ON public.owner_portal_tokens USING btree (revoked_at) WHERE (revoked_at IS NULL)
--   idx_owner_portal_tokens_token: CREATE INDEX idx_owner_portal_tokens_token ON public.owner_portal_tokens USING btree (token)
--   owner_portal_multi_unique: CREATE UNIQUE INDEX owner_portal_multi_unique ON public.owner_portal_tokens USING btree (property_owner_id) WHERE (is_multi = true)
--   owner_portal_single_unique: CREATE UNIQUE INDEX owner_portal_single_unique ON public.owner_portal_tokens USING btree (property_owner_id) WHERE (is_multi IS NOT TRUE)
--   owner_portal_tokens_owner_type_unique: CREATE UNIQUE INDEX owner_portal_tokens_owner_type_unique ON public.owner_portal_tokens USING btree (property_owner_id, is_multi)
--   owner_portal_tokens_pkey: CREATE UNIQUE INDEX owner_portal_tokens_pkey ON public.owner_portal_tokens USING btree (id)
--   owner_portal_tokens_token_key: CREATE UNIQUE INDEX owner_portal_tokens_token_key ON public.owner_portal_tokens USING btree (token)
-- RLS: ENABLED
-- Policies:
--   portal_tokens_manage  (ALL)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.owner_transactions
-- -----------------------------------------------------------------------------
CREATE TABLE public.owner_transactions (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  property_id  uuid  NOT NULL,
  org_id  uuid  NOT NULL,
  transaction_type  txn_type  NOT NULL,
  category  txn_category  NOT NULL  DEFAULT 'other'::txn_category,
  amount  numeric(10,2)  NOT NULL,
  description  text  NOT NULL,
  transaction_date  date  NOT NULL,
  work_order_id  uuid,
  purchase_order_id  uuid,
  notes  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  booking_id  uuid,
  source  text  DEFAULT 'manual'::text,
  source_reference_id  uuid,
  visible_to_owner  boolean  NOT NULL  DEFAULT true
);

-- Primary Key:
--   owner_transactions_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   owner_transactions_booking_id_fkey: FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
--   owner_transactions_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   owner_transactions_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
--   owner_transactions_purchase_order_id_fkey: FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE SET NULL
--   owner_transactions_work_order_id_fkey: FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL
-- Unique Constraints:
--   owner_transactions_source_ref_unique: UNIQUE (source_reference_id, source)
--   uq_owner_txn_source: UNIQUE (source_reference_id, source)
-- Check Constraints:
--   owner_transactions_source_check: CHECK ((source = ANY (ARRAY['manual'::text, 'wo_completion'::text, 'booking_revenue'::text, 'uplisting_booking'::text, 'inventory_purchase'::text, 'cleaning_fee'::text, 'booking_cancellation'::text])))
-- Indexes:
--   idx_owner_transactions_org_date: CREATE INDEX idx_owner_transactions_org_date ON public.owner_transactions USING btree (org_id, transaction_date DESC)
--   idx_owner_transactions_purchase_order_id: CREATE INDEX idx_owner_transactions_purchase_order_id ON public.owner_transactions USING btree (purchase_order_id)
--   idx_owner_transactions_work_order_id: CREATE INDEX idx_owner_transactions_work_order_id ON public.owner_transactions USING btree (work_order_id)
--   idx_owner_txn_booking_id: CREATE INDEX idx_owner_txn_booking_id ON public.owner_transactions USING btree (booking_id)
--   idx_owner_txn_date: CREATE INDEX idx_owner_txn_date ON public.owner_transactions USING btree (transaction_date)
--   idx_owner_txn_org_id: CREATE INDEX idx_owner_txn_org_id ON public.owner_transactions USING btree (org_id)
--   idx_owner_txn_property_id: CREATE INDEX idx_owner_txn_property_id ON public.owner_transactions USING btree (property_id)
--   owner_transactions_pkey: CREATE UNIQUE INDEX owner_transactions_pkey ON public.owner_transactions USING btree (id)
--   owner_transactions_source_ref_unique: CREATE UNIQUE INDEX owner_transactions_source_ref_unique ON public.owner_transactions USING btree (source_reference_id, source)
--   uq_owner_txn_source: CREATE UNIQUE INDEX uq_owner_txn_source ON public.owner_transactions USING btree (source_reference_id, source)
-- RLS: ENABLED
-- Policies:
--   owner_transactions_manage  (ALL)  roles={public}
--   owner_transactions_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.pending_integration_links
-- -----------------------------------------------------------------------------
CREATE TABLE public.pending_integration_links (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  pending_link_token  text  NOT NULL,
  provider_id  text  NOT NULL,
  external_user_id  text  NOT NULL,
  vault_secret_id  uuid  NOT NULL,
  refresh_token_vault_secret_id  uuid,
  scope  text,
  metadata  jsonb  NOT NULL  DEFAULT '{}'::jsonb,
  expires_at  timestamp with time zone  NOT NULL  DEFAULT (now() + '00:30:00'::interval),
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   pending_integration_links_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   pending_integration_links_provider_id_fkey: FOREIGN KEY (provider_id) REFERENCES integration_providers(id)
-- Unique Constraints:
--   pending_integration_links_pending_link_token_key: UNIQUE (pending_link_token)
-- Indexes:
--   idx_pending_integration_links_expires_at: CREATE INDEX idx_pending_integration_links_expires_at ON public.pending_integration_links USING btree (expires_at)
-- RLS: ENABLED
-- Policies: (none) — service_role only, same pattern as oauth_states

-- -----------------------------------------------------------------------------
-- TABLE: public.platform_admins
-- -----------------------------------------------------------------------------
CREATE TABLE public.platform_admins (
  user_id  uuid  NOT NULL,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   platform_admins_pkey: PRIMARY KEY (user_id)
-- Foreign Keys:
--   platform_admins_user_id_fkey: FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
-- Indexes:
--   platform_admins_pkey: CREATE UNIQUE INDEX platform_admins_pkey ON public.platform_admins USING btree (user_id)
-- RLS: ENABLED
-- Policies:
--   users_can_check_own_platform_admin_status  (SELECT)  roles={authenticated}

-- -----------------------------------------------------------------------------
-- TABLE: public.platform_staff
-- -----------------------------------------------------------------------------
CREATE TABLE public.platform_staff (
  user_id  uuid  NOT NULL,
  role  text  NOT NULL  DEFAULT 'support'::text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   platform_staff_pkey: PRIMARY KEY (user_id)
-- Foreign Keys:
--   platform_staff_user_id_fkey: FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
-- Check Constraints:
--   platform_staff_role_check: CHECK ((role = ANY (ARRAY['support'::text, 'admin'::text])))
-- Indexes:
--   platform_staff_pkey: CREATE UNIQUE INDEX platform_staff_pkey ON public.platform_staff USING btree (user_id)
-- RLS: ENABLED
-- Policies:
--   platform_staff_restrict_write  (ALL)  roles={public}
--   platform_staff_select_own  (SELECT)  roles={authenticated}
--   platform_staff_self_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.processed_webhooks
-- -----------------------------------------------------------------------------
CREATE TABLE public.processed_webhooks (
  webhook_id  text  NOT NULL,
  processed_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   processed_webhooks_pkey: PRIMARY KEY (webhook_id)
-- Indexes:
--   processed_webhooks_pkey: CREATE UNIQUE INDEX processed_webhooks_pkey ON public.processed_webhooks USING btree (webhook_id)
--   processed_webhooks_processed_at_idx: CREATE INDEX processed_webhooks_processed_at_idx ON public.processed_webhooks USING btree (processed_at)
-- RLS: ENABLED
-- Policies: (none)

-- -----------------------------------------------------------------------------
-- TABLE: public.profiles
-- -----------------------------------------------------------------------------
CREATE TABLE public.profiles (
  id  uuid  NOT NULL,
  full_name  text,
  phone  text,
  avatar_url  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  email_unsubscribed_at  timestamp with time zone
);

-- Primary Key:
--   profiles_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   profiles_id_fkey: FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE
-- Indexes:
--   profiles_pkey: CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id)
-- RLS: ENABLED
-- Policies:
--   profiles_own  (ALL)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.properties
-- -----------------------------------------------------------------------------
CREATE TABLE public.properties (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  name  text  NOT NULL,
  address  text,
  city  text,
  state  text,
  zip  text,
  property_type  property_type  DEFAULT 'house'::property_type,
  bedrooms  integer  DEFAULT 1,
  bathrooms  numeric(3,1)  DEFAULT 1.0,
  max_guests  integer  DEFAULT 2,
  avg_stay_length  numeric(4,1)  DEFAULT 3.0,
  avg_turnovers_per_month  numeric(4,1)  DEFAULT 4.0,
  wifi_name  text,
  wifi_password  text,
  door_code  text,
  checkout_time  time without time zone  DEFAULT '11:00:00'::time without time zone,
  checkin_time  time without time zone  DEFAULT '15:00:00'::time without time zone,
  internal_notes  text,
  setup_steps_completed  jsonb  NOT NULL  DEFAULT '{}'::jsonb,
  is_active  boolean  NOT NULL  DEFAULT true,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  avg_nightly_rate  numeric(10,2)  DEFAULT NULL::numeric,
  external_id  text,
  external_source  text,
  access_instructions  text,
  square_footage  integer,
  cleaning_cost  numeric(10,2),
  same_day_premium_pct  numeric(5,2)  DEFAULT 25.00,
  cleaning_cost_visible_to_owner  boolean  NOT NULL  DEFAULT false,
  lat  numeric(9,6),
  lng  numeric(9,6),
  house_manual  text,
  checkout_instructions  text,
  amenities  jsonb,
  smoking_allowed  boolean,
  pets_allowed  boolean,
  max_pets  integer,
  events_allowed  boolean,
  min_renter_age  integer,
  timezone  text  NOT NULL  DEFAULT 'America/New_York'::text
);

-- Primary Key:
--   properties_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   properties_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
-- Unique Constraints:
--   uq_properties_external_id_source: UNIQUE (external_id, external_source)
-- Indexes:
--   idx_properties_org_id: CREATE INDEX idx_properties_org_id ON public.properties USING btree (org_id)
--   properties_amenities_idx: CREATE INDEX properties_amenities_idx ON public.properties USING gin (amenities) WHERE (amenities IS NOT NULL)
--   properties_pkey: CREATE UNIQUE INDEX properties_pkey ON public.properties USING btree (id)
--   uq_properties_external_id_source: CREATE UNIQUE INDEX uq_properties_external_id_source ON public.properties USING btree (external_id, external_source)
-- RLS: ENABLED
-- Policies:
--   properties_delete  (DELETE)  roles={public}
--   properties_insert  (INSERT)  roles={public}
--   properties_select  (SELECT)  roles={public}
--   properties_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.property_assets
-- -----------------------------------------------------------------------------
CREATE TABLE public.property_assets (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  property_id  uuid  NOT NULL,
  name  text  NOT NULL,
  asset_type  asset_type  NOT NULL,
  make  text,
  model  text,
  serial_number  text,
  installation_date  date,
  manufacture_date  date,
  purchase_price  numeric(12,2),
  estimated_replacement_cost  numeric(12,2),
  expected_lifespan_years  smallint,
  warranty_expiry_date  date,
  warranty_provider  text,
  warranty_notes  text,
  placed_in_service_date  date,
  macrs_class  macrs_class  DEFAULT '5_year'::macrs_class,
  depreciation_method  text  DEFAULT 'macrs'::text,
  salvage_value  numeric(12,2)  DEFAULT 0,
  health_score  smallint,
  health_score_updated_at  timestamp with time zone,
  is_active  boolean  NOT NULL  DEFAULT true,
  replaced_by_asset_id  uuid,
  notes  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  photo_url  text,
  is_na  boolean  NOT NULL  DEFAULT false,
  verified_at  timestamp with time zone,
  replacement_status  text  NOT NULL  DEFAULT 'projected'::text
);

-- Primary Key:
--   property_assets_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   property_assets_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
--   property_assets_replaced_by_asset_id_fkey: FOREIGN KEY (replaced_by_asset_id) REFERENCES property_assets(id)
-- Check Constraints:
--   property_assets_depreciation_method_check: CHECK ((depreciation_method = ANY (ARRAY['macrs'::text, 'section_179'::text, 'straight_line'::text])))
--   property_assets_health_score_check: CHECK (((health_score >= 0) AND (health_score <= 100)))
--   property_assets_replacement_status_check: CHECK ((replacement_status = ANY (ARRAY['projected'::text, 'budgeted'::text, 'approved'::text, 'deferred'::text])))
-- Indexes:
--   idx_property_assets_org: CREATE INDEX idx_property_assets_org ON public.property_assets USING btree (org_id, health_score)
--   idx_property_assets_property: CREATE INDEX idx_property_assets_property ON public.property_assets USING btree (property_id, asset_type)
--   idx_property_assets_replaced_by_asset_id: CREATE INDEX idx_property_assets_replaced_by_asset_id ON public.property_assets USING btree (replaced_by_asset_id)
--   idx_property_assets_replacement_status: CREATE INDEX idx_property_assets_replacement_status ON public.property_assets USING btree (org_id, replacement_status) WHERE (replacement_status <> 'projected'::text)
--   idx_property_assets_warranty: CREATE INDEX idx_property_assets_warranty ON public.property_assets USING btree (warranty_expiry_date) WHERE ((warranty_expiry_date IS NOT NULL) AND (is_active = true))
--   property_assets_pkey: CREATE UNIQUE INDEX property_assets_pkey ON public.property_assets USING btree (id)
--   property_assets_property_active_type_idx: CREATE UNIQUE INDEX property_assets_property_active_type_idx ON public.property_assets USING btree (property_id, asset_type) WHERE (is_active = true)
-- RLS: ENABLED
-- Policies:
--   property_assets_delete  (DELETE)  roles={public}
--   property_assets_insert  (INSERT)  roles={public}
--   property_assets_select  (SELECT)  roles={public}
--   property_assets_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.property_owners
-- -----------------------------------------------------------------------------
CREATE TABLE public.property_owners (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id  uuid  NOT NULL,
  property_id  uuid  NOT NULL,
  name  text  NOT NULL,
  email  text,
  phone  text,
  revenue_share_pct  numeric(5,2),
  notes  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  share_capital_plan  boolean  NOT NULL  DEFAULT false
);

-- Primary Key:
--   property_owners_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   property_owners_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   property_owners_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
-- Indexes:
--   idx_property_owners_org_id: CREATE INDEX idx_property_owners_org_id ON public.property_owners USING btree (org_id)
--   idx_property_owners_property_id: CREATE INDEX idx_property_owners_property_id ON public.property_owners USING btree (property_id)
--   property_owners_pkey: CREATE UNIQUE INDEX property_owners_pkey ON public.property_owners USING btree (id)
-- RLS: ENABLED
-- Policies:
--   property_owners_delete  (DELETE)  roles={authenticated}
--   property_owners_insert  (INSERT)  roles={authenticated}
--   property_owners_select  (SELECT)  roles={authenticated}
--   property_owners_service_role  (ALL)  roles={service_role}
--   property_owners_update  (UPDATE)  roles={authenticated}

-- -----------------------------------------------------------------------------
-- TABLE: public.purchase_order_items
-- -----------------------------------------------------------------------------
CREATE TABLE public.purchase_order_items (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  purchase_order_id  uuid  NOT NULL,
  inventory_item_id  uuid,
  item_name  text  NOT NULL,
  current_quantity  integer  NOT NULL,
  par_level  integer  NOT NULL,
  quantity_to_buy  integer  NOT NULL,
  estimated_unit_cost  numeric(8,2),
  notes  text,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   purchase_order_items_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   purchase_order_items_inventory_item_id_fkey: FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL
--   purchase_order_items_purchase_order_id_fkey: FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
-- Indexes:
--   idx_po_items_purchase_order_id: CREATE INDEX idx_po_items_purchase_order_id ON public.purchase_order_items USING btree (purchase_order_id)
--   idx_purchase_order_items_inventory_item_id: CREATE INDEX idx_purchase_order_items_inventory_item_id ON public.purchase_order_items USING btree (inventory_item_id)
--   purchase_order_items_pkey: CREATE UNIQUE INDEX purchase_order_items_pkey ON public.purchase_order_items USING btree (id)
-- RLS: ENABLED
-- Policies:
--   po_items_manage  (ALL)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.purchase_orders
-- -----------------------------------------------------------------------------
CREATE TABLE public.purchase_orders (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  property_id  uuid  NOT NULL,
  org_id  uuid  NOT NULL,
  status  po_status  NOT NULL  DEFAULT 'draft'::po_status,
  generated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  sent_at  timestamp with time zone,
  acknowledged_at  timestamp with time zone,
  notes  text,
  total_estimated_cost  numeric(10,2),
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  order_email_sent  boolean  NOT NULL  DEFAULT false,
  is_same_day_flip  boolean  NOT NULL  DEFAULT false,
  source_count_id  uuid
);

-- Primary Key:
--   purchase_orders_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   purchase_orders_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   purchase_orders_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
--   purchase_orders_source_count_id_fkey: FOREIGN KEY (source_count_id) REFERENCES inventory_counts(id) ON DELETE SET NULL
-- Indexes:
--   idx_purchase_orders_org_id: CREATE INDEX idx_purchase_orders_org_id ON public.purchase_orders USING btree (org_id)
--   idx_purchase_orders_pending_email: CREATE INDEX idx_purchase_orders_pending_email ON public.purchase_orders USING btree (org_id, created_at) WHERE (order_email_sent = false)
--   idx_purchase_orders_property_id: CREATE INDEX idx_purchase_orders_property_id ON public.purchase_orders USING btree (property_id)
--   idx_purchase_orders_status: CREATE INDEX idx_purchase_orders_status ON public.purchase_orders USING btree (status)
--   po_source_count_unique: CREATE UNIQUE INDEX po_source_count_unique ON public.purchase_orders USING btree (source_count_id) WHERE (source_count_id IS NOT NULL)
--   purchase_orders_pkey: CREATE UNIQUE INDEX purchase_orders_pkey ON public.purchase_orders USING btree (id)
-- RLS: ENABLED
-- Policies:
--   purchase_orders_delete  (DELETE)  roles={public}
--   purchase_orders_insert  (INSERT)  roles={public}
--   purchase_orders_select  (SELECT)  roles={public}
--   purchase_orders_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.push_subscriptions
-- -----------------------------------------------------------------------------
CREATE TABLE public.push_subscriptions (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  crew_member_id  uuid,
  org_id  uuid  NOT NULL,
  endpoint  text  NOT NULL,
  p256dh  text  NOT NULL,
  auth  text  NOT NULL,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  user_id  uuid
);

-- Primary Key:
--   push_subscriptions_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   push_subscriptions_crew_member_id_fkey: FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE
--   push_subscriptions_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   push_subscriptions_user_id_fkey: FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
-- Check Constraints:
--   push_subscriptions_one_owner: CHECK (((crew_member_id IS NOT NULL) <> (user_id IS NOT NULL)))
-- Indexes:
--   idx_push_subs_crew_member: CREATE INDEX idx_push_subs_crew_member ON public.push_subscriptions USING btree (crew_member_id)
--   idx_push_subscriptions_org_id: CREATE INDEX idx_push_subscriptions_org_id ON public.push_subscriptions USING btree (org_id)
--   push_subscriptions_crew_endpoint_key: CREATE UNIQUE INDEX push_subscriptions_crew_endpoint_key ON public.push_subscriptions USING btree (crew_member_id, endpoint) WHERE (crew_member_id IS NOT NULL)
--   push_subscriptions_pkey: CREATE UNIQUE INDEX push_subscriptions_pkey ON public.push_subscriptions USING btree (id)
--   push_subscriptions_user_endpoint_key: CREATE UNIQUE INDEX push_subscriptions_user_endpoint_key ON public.push_subscriptions USING btree (user_id, endpoint) WHERE (user_id IS NOT NULL)
-- RLS: ENABLED
-- Policies:
--   Crew members manage own push subscriptions  (ALL)  roles={public}
--   crew manage own push subscriptions  (ALL)  roles={public}
--   org members manage own push subscriptions  (ALL)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.quote_requests
-- -----------------------------------------------------------------------------
CREATE TABLE public.quote_requests (
  id  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  work_order_id  uuid  NOT NULL,
  org_id  uuid  NOT NULL,
  vendor_id  uuid  NOT NULL,
  status  quote_request_status  NOT NULL  DEFAULT 'pending'::quote_request_status,
  quote_token  text  NOT NULL,
  quote_token_expires_at  timestamp with time zone  NOT NULL,
  quoted_amount  numeric(10,2),
  quote_notes  text,
  sent_at  timestamp with time zone  NOT NULL  DEFAULT now(),
  submitted_at  timestamp with time zone,
  created_at  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   quote_requests_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   quote_requests_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   quote_requests_vendor_id_fkey: FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
--   quote_requests_work_order_id_fkey: FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
-- Unique Constraints:
--   quote_requests_quote_token_key: UNIQUE (quote_token)
-- Indexes:
--   idx_quote_requests_org_id: CREATE INDEX idx_quote_requests_org_id ON public.quote_requests USING btree (org_id)
--   idx_quote_requests_quote_token: CREATE INDEX idx_quote_requests_quote_token ON public.quote_requests USING btree (quote_token)
--   idx_quote_requests_token: CREATE INDEX idx_quote_requests_token ON public.quote_requests USING btree (quote_token)
--   idx_quote_requests_vendor_id: CREATE INDEX idx_quote_requests_vendor_id ON public.quote_requests USING btree (vendor_id)
--   idx_quote_requests_wo_status: CREATE INDEX idx_quote_requests_wo_status ON public.quote_requests USING btree (work_order_id, status)
--   idx_quote_requests_work_order_id: CREATE INDEX idx_quote_requests_work_order_id ON public.quote_requests USING btree (work_order_id)
--   quote_requests_pkey: CREATE UNIQUE INDEX quote_requests_pkey ON public.quote_requests USING btree (id)
--   quote_requests_quote_token_key: CREATE UNIQUE INDEX quote_requests_quote_token_key ON public.quote_requests USING btree (quote_token)
-- RLS: ENABLED
-- Policies:
--   quote_requests_delete  (DELETE)  roles={authenticated}
--   quote_requests_insert  (INSERT)  roles={authenticated}
--   quote_requests_select  (SELECT)  roles={authenticated}
--   quote_requests_service_role  (ALL)  roles={service_role}
--   quote_requests_update  (UPDATE)  roles={authenticated}
-- -----------------------------------------------------------------------------
-- TABLE: public.review_responses
-- -----------------------------------------------------------------------------
CREATE TABLE public.review_responses (
  id                   uuid  NOT NULL  DEFAULT gen_random_uuid(),
  review_id            uuid  NOT NULL,
  org_id               uuid  NOT NULL,
  generated_response   text,
  edited_response      text,
  word_count           integer,
  tone_used            text,
  flags                text[]  NOT NULL  DEFAULT '{}'::text[],
  flag_reason          text,
  generated_at         timestamp with time zone,
  created_at           timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at           timestamp with time zone  NOT NULL  DEFAULT now(),
  regeneration_count   integer  NOT NULL  DEFAULT 0
);

-- Primary Key:
--   review_responses_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   review_responses_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   review_responses_review_id_fkey: FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
-- Indexes:
--   idx_review_responses_org_id: CREATE INDEX idx_review_responses_org_id ON public.review_responses USING btree (org_id)
--   idx_review_responses_review_id: CREATE UNIQUE INDEX idx_review_responses_review_id ON public.review_responses USING btree (review_id)
--   review_responses_pkey: CREATE UNIQUE INDEX review_responses_pkey ON public.review_responses USING btree (id)
-- RLS: ENABLED
-- Policies:
--   review_responses_service_write  (ALL)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.reviews
-- -----------------------------------------------------------------------------
CREATE TABLE public.reviews (
  id               uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id           uuid  NOT NULL,
  property_id      uuid,
  external_id      text  NOT NULL,
  external_source  text  NOT NULL  DEFAULT 'ownerrez'::text,
  guest_name       text,
  rating           integer  NOT NULL,
  review_text      text  NOT NULL,
  review_date      timestamp with time zone,
  response_status  text  NOT NULL  DEFAULT 'pending'::text,
  external_url     text,
  created_at       timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at       timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   reviews_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   reviews_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   reviews_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL
-- Unique Constraints:
--   reviews_external_id_external_source_key: UNIQUE (external_id, external_source)
-- Check Constraints:
--   reviews_rating_check: CHECK (((rating >= 1) AND (rating <= 5)))
--   reviews_response_status_check: CHECK ((response_status = ANY (ARRAY['pending'::text, 'draft'::text, 'ready'::text, 'posted'::text])))
-- Indexes:
--   idx_reviews_org_id: CREATE INDEX idx_reviews_org_id ON public.reviews USING btree (org_id)
--   idx_reviews_property_id: CREATE INDEX idx_reviews_property_id ON public.reviews USING btree (property_id)
--   idx_reviews_status: CREATE INDEX idx_reviews_status ON public.reviews USING btree (response_status)
--   reviews_external_id_external_source_key: CREATE UNIQUE INDEX reviews_external_id_external_source_key ON public.reviews USING btree (external_id, external_source)
--   reviews_pkey: CREATE UNIQUE INDEX reviews_pkey ON public.reviews USING btree (id)
-- RLS: ENABLED
-- Policies:
--   reviews_delete  (DELETE)  roles={public}
--   reviews_insert  (INSERT)  roles={public}
--   reviews_select  (SELECT)  roles={public}
--   reviews_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.stay_extension_requests
-- -----------------------------------------------------------------------------
CREATE TABLE public.stay_extension_requests (
  id                     uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id                 uuid  NOT NULL,
  booking_id             uuid  NOT NULL,
  property_id            uuid  NOT NULL,
  gap_days               integer  NOT NULL,
  discount_pct           integer,
  next_booking_checkin   date,
  status                 text  NOT NULL  DEFAULT 'pending'::text,
  sms_sent_at            timestamp with time zone,
  pm_notified_at         timestamp with time zone,
  created_at             timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at             timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   stay_extension_requests_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   stay_extension_requests_booking_id_fkey: FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
--   stay_extension_requests_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   stay_extension_requests_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
-- Unique Constraints:
--   stay_extension_requests_booking_id_key: UNIQUE (booking_id)
-- Check Constraints:
--   stay_extension_requests_discount_pct_check: CHECK (((discount_pct >= 0) AND (discount_pct <= 100)))
--   stay_extension_requests_status_check: CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])))
-- Indexes:
--   idx_stay_extension_requests_booking: CREATE INDEX idx_stay_extension_requests_booking ON public.stay_extension_requests USING btree (booking_id)
--   idx_stay_extension_requests_org: CREATE INDEX idx_stay_extension_requests_org ON public.stay_extension_requests USING btree (org_id)
--   stay_extension_requests_booking_id_key: CREATE UNIQUE INDEX stay_extension_requests_booking_id_key ON public.stay_extension_requests USING btree (booking_id)
--   stay_extension_requests_pkey: CREATE UNIQUE INDEX stay_extension_requests_pkey ON public.stay_extension_requests USING btree (id)
-- RLS: ENABLED
-- Policies:
--   ser_org_members_select  (SELECT)  roles={public}
--   ser_restrict_insert  (INSERT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.stripe_processed_events
-- -----------------------------------------------------------------------------
CREATE TABLE public.stripe_processed_events (
  stripe_event_id   text  NOT NULL,
  processed_at      timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   stripe_processed_events_pkey: PRIMARY KEY (stripe_event_id)
-- Indexes:
--   stripe_processed_events_pkey: CREATE UNIQUE INDEX stripe_processed_events_pkey ON public.stripe_processed_events USING btree (stripe_event_id)
-- RLS: ENABLED
-- Policies:
--   stripe_events_deny_all  (ALL)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.support_conversations
-- -----------------------------------------------------------------------------
CREATE TABLE public.support_conversations (
  id                   uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id               uuid  NOT NULL,
  user_id              uuid  NOT NULL,
  status               text  NOT NULL  DEFAULT 'open'::text,
  created_at           timestamp with time zone  NOT NULL  DEFAULT now(),
  last_message_at      timestamp with time zone  NOT NULL  DEFAULT now(),
  needs_human          boolean  NOT NULL  DEFAULT false,
  escalation_reason    text,
  escalated_at         timestamp with time zone,
  resolved_at          timestamp with time zone,
  assigned_staff_id    uuid,
  staff_notified_at    timestamp with time zone
);

-- Primary Key:
--   support_conversations_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   support_conversations_assigned_staff_id_fkey: FOREIGN KEY (assigned_staff_id) REFERENCES auth.users(id)
--   support_conversations_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   support_conversations_user_id_fkey: FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
-- Indexes:
--   idx_support_conversations_needs_human: CREATE INDEX idx_support_conversations_needs_human ON public.support_conversations USING btree (needs_human, last_message_at DESC) WHERE (needs_human = true)
--   idx_support_conversations_org: CREATE INDEX idx_support_conversations_org ON public.support_conversations USING btree (org_id)
--   idx_support_conversations_status_recent: CREATE INDEX idx_support_conversations_status_recent ON public.support_conversations USING btree (status, last_message_at DESC)
--   idx_support_conversations_user: CREATE INDEX idx_support_conversations_user ON public.support_conversations USING btree (user_id)
--   support_conversations_pkey: CREATE UNIQUE INDEX support_conversations_pkey ON public.support_conversations USING btree (id)
-- RLS: ENABLED
-- Policies:
--   org members access own conversations  (ALL)  roles={public}
--   support_conversations_staff_select  (SELECT)  roles={public}
--   support_conversations_staff_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.support_kb_chunks
-- -----------------------------------------------------------------------------
CREATE TABLE public.support_kb_chunks (
  id           uuid  NOT NULL  DEFAULT gen_random_uuid(),
  title        text  NOT NULL,
  content      text  NOT NULL,
  embedding    vector(1536),
  source       text,
  created_at   timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at   timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   support_kb_chunks_pkey: PRIMARY KEY (id)
-- Indexes:
--   support_kb_chunks_embedding_idx: CREATE INDEX support_kb_chunks_embedding_idx ON public.support_kb_chunks USING hnsw (embedding vector_cosine_ops)
--   support_kb_chunks_pkey: CREATE UNIQUE INDEX support_kb_chunks_pkey ON public.support_kb_chunks USING btree (id)
-- RLS: ENABLED
-- Policies:
--   authenticated users read kb chunks  (SELECT)  roles={authenticated}

-- -----------------------------------------------------------------------------
-- TABLE: public.support_messages
-- -----------------------------------------------------------------------------
CREATE TABLE public.support_messages (
  id                 uuid  NOT NULL  DEFAULT gen_random_uuid(),
  conversation_id    uuid  NOT NULL,
  role               support_message_role  NOT NULL,
  content            text  NOT NULL,
  category           support_category,
  model_used         text,
  created_at         timestamp with time zone  NOT NULL  DEFAULT now(),
  sent_by_user_id    uuid
);

-- Primary Key:
--   support_messages_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   support_messages_conversation_id_fkey: FOREIGN KEY (conversation_id) REFERENCES support_conversations(id) ON DELETE CASCADE
--   support_messages_sent_by_user_id_fkey: FOREIGN KEY (sent_by_user_id) REFERENCES auth.users(id)
-- Indexes:
--   idx_support_messages_conversation: CREATE INDEX idx_support_messages_conversation ON public.support_messages USING btree (conversation_id)
--   support_messages_pkey: CREATE UNIQUE INDEX support_messages_pkey ON public.support_messages USING btree (id)
-- RLS: ENABLED
-- Policies:
--   org members access own conversation messages  (ALL)  roles={public}
--   support_messages_staff_insert  (INSERT)  roles={public}
--   support_messages_staff_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.system_job_runs
-- -----------------------------------------------------------------------------
CREATE TABLE public.system_job_runs (
  id              uuid  NOT NULL  DEFAULT gen_random_uuid(),
  function_id     text  NOT NULL,
  function_name   text  NOT NULL,
  run_id          text  NOT NULL,
  org_id          uuid,
  status          text  NOT NULL  DEFAULT 'started'::text,
  attempt         integer  NOT NULL  DEFAULT 1,
  started_at      timestamp with time zone  NOT NULL  DEFAULT now(),
  finished_at     timestamp with time zone,
  duration_ms     integer,
  error_message   text,
  error_stack     text,
  metadata        jsonb  NOT NULL  DEFAULT '{}'::jsonb,
  created_at      timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   system_job_runs_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   system_job_runs_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE SET NULL
-- Unique Constraints:
--   system_job_runs_run_function_unique: UNIQUE (run_id, function_id)
-- Check Constraints:
--   system_job_runs_status_check: CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text])))
-- Indexes:
--   idx_system_job_runs_function_started: CREATE INDEX idx_system_job_runs_function_started ON public.system_job_runs USING btree (function_id, started_at DESC)
--   idx_system_job_runs_org: CREATE INDEX idx_system_job_runs_org ON public.system_job_runs USING btree (org_id) WHERE (org_id IS NOT NULL)
--   idx_system_job_runs_status: CREATE INDEX idx_system_job_runs_status ON public.system_job_runs USING btree (status)
--   idx_system_job_runs_stuck: CREATE INDEX idx_system_job_runs_stuck ON public.system_job_runs USING btree (started_at) WHERE (status = 'started'::text)
--   system_job_runs_pkey: CREATE UNIQUE INDEX system_job_runs_pkey ON public.system_job_runs USING btree (id)
--   system_job_runs_run_function_unique: CREATE UNIQUE INDEX system_job_runs_run_function_unique ON public.system_job_runs USING btree (run_id, function_id)
-- RLS: ENABLED
-- Policies:
--   platform_admins_can_view_job_runs  (SELECT)  roles={authenticated}

-- -----------------------------------------------------------------------------
-- TABLE: public.turnover_assignments
-- -----------------------------------------------------------------------------
CREATE TABLE public.turnover_assignments (
  id                  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  turnover_id         uuid  NOT NULL,
  crew_member_id      uuid  NOT NULL,
  assigned_at         timestamp with time zone  NOT NULL  DEFAULT now(),
  notified_at         timestamp with time zone,
  notification_type   contact_pref,
  created_at          timestamp with time zone  NOT NULL  DEFAULT now(),
  user_id             uuid,
  property_id         uuid,
  org_id              uuid
);

-- Primary Key:
--   turnover_assignments_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   turnover_assignments_crew_member_id_fkey: FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE
--   turnover_assignments_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   turnover_assignments_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL
--   turnover_assignments_turnover_id_fkey: FOREIGN KEY (turnover_id) REFERENCES turnovers(id) ON DELETE CASCADE
--   turnover_assignments_user_id_fkey: FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL
-- Unique Constraints:
--   turnover_assignments_crew_unique: UNIQUE (turnover_id, crew_member_id)
-- Indexes:
--   idx_turnover_assignments_crew_id: CREATE INDEX idx_turnover_assignments_crew_id ON public.turnover_assignments USING btree (crew_member_id)
--   idx_turnover_assignments_org_id: CREATE INDEX idx_turnover_assignments_org_id ON public.turnover_assignments USING btree (org_id)
--   idx_turnover_assignments_property_id: CREATE INDEX idx_turnover_assignments_property_id ON public.turnover_assignments USING btree (property_id) WHERE (property_id IS NOT NULL)
--   idx_turnover_assignments_turnover_id: CREATE INDEX idx_turnover_assignments_turnover_id ON public.turnover_assignments USING btree (turnover_id)
--   idx_turnover_assignments_user_id: CREATE INDEX idx_turnover_assignments_user_id ON public.turnover_assignments USING btree (user_id) WHERE (user_id IS NOT NULL)
--   turnover_assignments_crew_unique: CREATE UNIQUE INDEX turnover_assignments_crew_unique ON public.turnover_assignments USING btree (turnover_id, crew_member_id)
--   turnover_assignments_pkey: CREATE UNIQUE INDEX turnover_assignments_pkey ON public.turnover_assignments USING btree (id)
-- RLS: ENABLED
-- Policies:
--   turnover_assignments_delete  (DELETE)  roles={public}
--   turnover_assignments_insert  (INSERT)  roles={public}
--   turnover_assignments_select  (SELECT)  roles={public}
--   turnover_assignments_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.turnovers
-- -----------------------------------------------------------------------------
CREATE TABLE public.turnovers (
  id                       uuid  NOT NULL  DEFAULT gen_random_uuid(),
  property_id              uuid  NOT NULL,
  org_id                   uuid  NOT NULL,
  booking_id               uuid,
  prev_booking_id          uuid,
  checkout_datetime        timestamp with time zone  NOT NULL,
  checkin_datetime         timestamp with time zone  NOT NULL,
  window_minutes           integer,
  status                   turnover_status  NOT NULL  DEFAULT 'pending_assignment'::turnover_status,
  priority                 priority_level  NOT NULL  DEFAULT 'medium'::priority_level,
  checklist_template_id    uuid,
  notes                    text,
  completion_notes         text,
  completed_at             timestamp with time zone,
  auto_generated           boolean  NOT NULL  DEFAULT true,
  created_at               timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at               timestamp with time zone  NOT NULL  DEFAULT now(),
  started_at               timestamp with time zone,
  suggested_crew_ids       uuid[],
  suggestion_reasoning     text,
  suggestion_status        text,
  is_same_day_turnover     boolean  NOT NULL  DEFAULT false,
  is_archived              boolean  NOT NULL  DEFAULT false
);

-- Primary Key:
--   turnovers_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   turnovers_booking_id_fkey: FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
--   turnovers_checklist_template_id_fkey: FOREIGN KEY (checklist_template_id) REFERENCES checklist_templates(id) ON DELETE SET NULL
--   turnovers_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   turnovers_prev_booking_id_fkey: FOREIGN KEY (prev_booking_id) REFERENCES bookings(id) ON DELETE SET NULL
--   turnovers_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
-- Check Constraints:
--   turnovers_suggestion_status_check: CHECK (((suggestion_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'overridden'::text, 'dismissed'::text])) OR (suggestion_status IS NULL)))
-- Indexes:
--   idx_turnovers_active: CREATE INDEX idx_turnovers_active ON public.turnovers USING btree (org_id, is_archived, status) WHERE (is_archived = false)
--   idx_turnovers_booking_id: CREATE INDEX idx_turnovers_booking_id ON public.turnovers USING btree (booking_id) WHERE (booking_id IS NOT NULL)
--   idx_turnovers_checklist_template_id: CREATE INDEX idx_turnovers_checklist_template_id ON public.turnovers USING btree (checklist_template_id)
--   idx_turnovers_checkout: CREATE INDEX idx_turnovers_checkout ON public.turnovers USING btree (checkout_datetime)
--   idx_turnovers_org_id: CREATE INDEX idx_turnovers_org_id ON public.turnovers USING btree (org_id)
--   idx_turnovers_org_status_checkout: CREATE INDEX idx_turnovers_org_status_checkout ON public.turnovers USING btree (org_id, status, checkout_datetime)
--   idx_turnovers_prev_booking_id: CREATE INDEX idx_turnovers_prev_booking_id ON public.turnovers USING btree (prev_booking_id)
--   idx_turnovers_property_id: CREATE INDEX idx_turnovers_property_id ON public.turnovers USING btree (property_id)
--   idx_turnovers_status: CREATE INDEX idx_turnovers_status ON public.turnovers USING btree (status)
--   turnovers_booking_pair_unique: CREATE UNIQUE INDEX turnovers_booking_pair_unique ON public.turnovers USING btree (booking_id, prev_booking_id) WHERE ((booking_id IS NOT NULL) AND (prev_booking_id IS NOT NULL))
--   turnovers_pkey: CREATE UNIQUE INDEX turnovers_pkey ON public.turnovers USING btree (id)
--   turnovers_standalone_booking_unique: CREATE UNIQUE INDEX turnovers_standalone_booking_unique ON public.turnovers USING btree (booking_id) WHERE ((booking_id IS NOT NULL) AND (prev_booking_id IS NULL))
--   turnovers_standalone_unique: CREATE UNIQUE INDEX turnovers_standalone_unique ON public.turnovers USING btree (booking_id) WHERE ((booking_id IS NOT NULL) AND (prev_booking_id IS NULL))
-- RLS: ENABLED
-- Policies:
--   turnovers_delete  (DELETE)  roles={public}
--   turnovers_insert  (INSERT)  roles={public}
--   turnovers_select  (SELECT)  roles={public}
--   turnovers_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.vendor_compliance_documents
-- -----------------------------------------------------------------------------
CREATE TABLE public.vendor_compliance_documents (
  id                    uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id                uuid  NOT NULL,
  vendor_id             uuid  NOT NULL,
  document_type         compliance_doc_type  NOT NULL,
  document_name         text  NOT NULL,
  policy_number         text,
  issuer_name           text,
  effective_date        date,
  expiry_date           date,
  coverage_amount       numeric(12,2),
  document_url          text,
  is_verified           boolean  NOT NULL  DEFAULT false,
  verification_notes    text,
  is_active             boolean  NOT NULL  DEFAULT true,
  created_at            timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at            timestamp with time zone  NOT NULL  DEFAULT now(),
  first_warned_at       timestamp with time zone,
  hard_blocked_at       timestamp with time zone
);

-- Primary Key:
--   vendor_compliance_documents_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   vendor_compliance_documents_vendor_id_fkey: FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
-- Indexes:
--   idx_vendor_compliance_expiring: CREATE INDEX idx_vendor_compliance_expiring ON public.vendor_compliance_documents USING btree (expiry_date, org_id) WHERE ((is_active = true) AND (expiry_date IS NOT NULL))
--   idx_vendor_compliance_vendor: CREATE INDEX idx_vendor_compliance_vendor ON public.vendor_compliance_documents USING btree (vendor_id, document_type, expiry_date)
--   vendor_compliance_documents_pkey: CREATE UNIQUE INDEX vendor_compliance_documents_pkey ON public.vendor_compliance_documents USING btree (id)
-- RLS: ENABLED
-- Policies:
--   vendor_compliance_documents_delete  (DELETE)  roles={public}
--   vendor_compliance_documents_insert  (INSERT)  roles={public}
--   vendor_compliance_documents_select  (SELECT)  roles={public}
--   vendor_compliance_documents_update  (UPDATE)  roles={public}
-- NOTE: org_id has no FK constraint defined in pg_constraint (only vendor_id is FK-enforced) — verified via live query, not a typo.

-- -----------------------------------------------------------------------------
-- TABLE: public.vendors
-- -----------------------------------------------------------------------------
CREATE TABLE public.vendors (
  id                                uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id                            uuid  NOT NULL,
  name                              text  NOT NULL,
  contact_name                      text,
  email                             text,
  phone                             text,
  specialty                         vendor_specialty  DEFAULT 'general'::vendor_specialty,
  portal_enabled                    boolean  NOT NULL  DEFAULT false,
  notes                             text,
  is_active                         boolean  NOT NULL  DEFAULT true,
  created_at                        timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at                        timestamp with time zone  NOT NULL  DEFAULT now(),
  avg_rating                        numeric(3,2),
  rating_count                      integer  NOT NULL  DEFAULT 0,
  lat                               numeric(9,6),
  lng                               numeric(9,6),
  service_zip                       text,
  service_radius_miles              smallint  DEFAULT 25,
  address                           text,
  city                              text,
  state                             text,
  stripe_connect_token              uuid  NOT NULL  DEFAULT gen_random_uuid(),
  stripe_connect_account_id         text,
  stripe_connect_charges_enabled    boolean  NOT NULL  DEFAULT false,
  stripe_connect_onboarded_at       timestamp with time zone,
  stripe_connect_invite_sent_at     timestamp with time zone
);

-- Primary Key:
--   vendors_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   vendors_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
-- Indexes:
--   idx_vendors_org_id: CREATE INDEX idx_vendors_org_id ON public.vendors USING btree (org_id)
--   idx_vendors_stripe_connect_account_id: CREATE UNIQUE INDEX idx_vendors_stripe_connect_account_id ON public.vendors USING btree (stripe_connect_account_id) WHERE (stripe_connect_account_id IS NOT NULL)
--   idx_vendors_stripe_connect_token: CREATE UNIQUE INDEX idx_vendors_stripe_connect_token ON public.vendors USING btree (stripe_connect_token)
--   vendors_pkey: CREATE UNIQUE INDEX vendors_pkey ON public.vendors USING btree (id)
-- RLS: ENABLED
-- Policies:
--   vendors_delete  (DELETE)  roles={public}
--   vendors_insert  (INSERT)  roles={public}
--   vendors_select  (SELECT)  roles={public}
--   vendors_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.wo_number_counters
-- -----------------------------------------------------------------------------
CREATE TABLE public.wo_number_counters (
  org_id         uuid  NOT NULL,
  last_number    integer  NOT NULL  DEFAULT 0,
  current_year   smallint  NOT NULL  DEFAULT (EXTRACT(year FROM now()))::smallint
);

-- Primary Key:
--   wo_number_counters_pkey: PRIMARY KEY (org_id)
-- Foreign Keys:
--   wo_number_counters_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
-- Indexes:
--   wo_number_counters_pkey: CREATE UNIQUE INDEX wo_number_counters_pkey ON public.wo_number_counters USING btree (org_id)
-- RLS: ENABLED
-- Policies:
--   wo_counters_deny_all  (ALL)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.work_order_invoices
-- -----------------------------------------------------------------------------
CREATE TABLE public.work_order_invoices (
  id                            uuid  NOT NULL  DEFAULT gen_random_uuid(),
  org_id                        uuid  NOT NULL,
  work_order_id                 uuid  NOT NULL,
  vendor_id                     uuid  NOT NULL,
  property_id                   uuid  NOT NULL,
  invoice_number                text  NOT NULL,
  status                        text  NOT NULL  DEFAULT 'pending_payment'::text,
  subtotal                      numeric  NOT NULL  DEFAULT 0,
  total                         numeric  NOT NULL  DEFAULT 0,
  platform_fee_amount           numeric  NOT NULL  DEFAULT 0,
  stripe_checkout_session_id    text,
  stripe_payment_intent_id      text,
  paid_at                       timestamp with time zone,
  submitted_at                  timestamp with time zone  NOT NULL  DEFAULT now(),
  created_at                    timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   work_order_invoices_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   work_order_invoices_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   work_order_invoices_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE RESTRICT
--   work_order_invoices_vendor_id_fkey: FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT
--   work_order_invoices_work_order_id_fkey: FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
-- Unique Constraints:
--   work_order_invoices_work_order_id_key: UNIQUE (work_order_id)
-- Check Constraints:
--   work_order_invoices_platform_fee_amount_check: CHECK ((platform_fee_amount >= (0)::numeric))
--   work_order_invoices_status_check: CHECK ((status = ANY (ARRAY['pending_payment'::text, 'paid'::text, 'cancelled'::text])))
--   work_order_invoices_subtotal_check: CHECK ((subtotal >= (0)::numeric))
--   work_order_invoices_total_check: CHECK ((total >= (0)::numeric))
-- Indexes:
--   idx_work_order_invoices_checkout_session: CREATE UNIQUE INDEX idx_work_order_invoices_checkout_session ON public.work_order_invoices USING btree (stripe_checkout_session_id) WHERE (stripe_checkout_session_id IS NOT NULL)
--   idx_work_order_invoices_org_id: CREATE INDEX idx_work_order_invoices_org_id ON public.work_order_invoices USING btree (org_id, created_at DESC)
--   idx_work_order_invoices_status: CREATE INDEX idx_work_order_invoices_status ON public.work_order_invoices USING btree (org_id, status) WHERE (status <> 'paid'::text)
--   idx_work_order_invoices_vendor_id: CREATE INDEX idx_work_order_invoices_vendor_id ON public.work_order_invoices USING btree (vendor_id)
--   work_order_invoices_pkey: CREATE UNIQUE INDEX work_order_invoices_pkey ON public.work_order_invoices USING btree (id)
--   work_order_invoices_work_order_id_key: CREATE UNIQUE INDEX work_order_invoices_work_order_id_key ON public.work_order_invoices USING btree (work_order_id)
-- RLS: ENABLED
-- Policies:
--   work_order_invoices_manage  (ALL)  roles={public}
--   work_order_invoices_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.work_order_line_items
-- -----------------------------------------------------------------------------
CREATE TABLE public.work_order_line_items (
  id                  uuid  NOT NULL  DEFAULT gen_random_uuid(),
  work_order_id       uuid  NOT NULL,
  org_id              uuid  NOT NULL,
  line_type           line_item_type  NOT NULL  DEFAULT 'material'::line_item_type,
  description         text  NOT NULL,
  quantity            numeric(8,2)  NOT NULL  DEFAULT 1,
  unit                text,
  unit_cost           numeric(10,2)  NOT NULL,
  line_total          numeric(10,2)  DEFAULT (quantity * unit_cost),
  sort_order          smallint  NOT NULL  DEFAULT 0,
  created_at          timestamp with time zone  NOT NULL  DEFAULT now(),
  vendor_submitted    boolean  NOT NULL  DEFAULT false
);

-- Primary Key:
--   work_order_line_items_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   work_order_line_items_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   work_order_line_items_work_order_id_fkey: FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
-- Check Constraints:
--   work_order_line_items_quantity_check: CHECK ((quantity > (0)::numeric))
--   work_order_line_items_unit_cost_check: CHECK ((unit_cost >= (0)::numeric))
-- Indexes:
--   idx_wo_line_items_org_id: CREATE INDEX idx_wo_line_items_org_id ON public.work_order_line_items USING btree (org_id)
--   idx_wo_line_items_work_order_id: CREATE INDEX idx_wo_line_items_work_order_id ON public.work_order_line_items USING btree (work_order_id)
--   idx_work_order_line_items_vendor_submitted: CREATE INDEX idx_work_order_line_items_vendor_submitted ON public.work_order_line_items USING btree (work_order_id) WHERE (vendor_submitted = true)
--   work_order_line_items_pkey: CREATE UNIQUE INDEX work_order_line_items_pkey ON public.work_order_line_items USING btree (id)
-- RLS: ENABLED
-- Policies:
--   Managers and above delete line items  (DELETE)  roles={public}
--   Managers and above insert line items  (INSERT)  roles={public}
--   Members view org line items  (SELECT)  roles={public}
--   work_order_line_items_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.work_order_photos
-- -----------------------------------------------------------------------------
CREATE TABLE public.work_order_photos (
  id              uuid  NOT NULL  DEFAULT gen_random_uuid(),
  work_order_id   uuid  NOT NULL,
  storage_path    text  NOT NULL,
  uploaded_by     text,
  created_at      timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   work_order_photos_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   work_order_photos_work_order_id_fkey: FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
-- Indexes:
--   idx_wo_photos_work_order_id: CREATE INDEX idx_wo_photos_work_order_id ON public.work_order_photos USING btree (work_order_id)
--   wo_photos_storage_path_unique: CREATE UNIQUE INDEX wo_photos_storage_path_unique ON public.work_order_photos USING btree (storage_path)
--   work_order_photos_pkey: CREATE UNIQUE INDEX work_order_photos_pkey ON public.work_order_photos USING btree (id)
-- RLS: ENABLED
-- Policies:
--   work_order_photos_delete  (DELETE)  roles={public}
--   work_order_photos_insert  (INSERT)  roles={public}
--   work_order_photos_select  (SELECT)  roles={public}
--   work_order_photos_update  (UPDATE)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.work_order_updates
-- -----------------------------------------------------------------------------
CREATE TABLE public.work_order_updates (
  id                          uuid  NOT NULL  DEFAULT gen_random_uuid(),
  work_order_id               uuid  NOT NULL,
  org_id                      uuid  NOT NULL,
  updated_by_user_id          uuid,
  updated_via_vendor_portal   boolean  NOT NULL  DEFAULT false,
  status_from                 wo_status,
  status_to                   wo_status,
  notes                       text,
  created_at                  timestamp with time zone  NOT NULL  DEFAULT now()
);

-- Primary Key:
--   work_order_updates_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   work_order_updates_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   work_order_updates_updated_by_user_id_fkey: FOREIGN KEY (updated_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL
--   work_order_updates_work_order_id_fkey: FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
-- Indexes:
--   idx_wo_updates_work_order_id: CREATE INDEX idx_wo_updates_work_order_id ON public.work_order_updates USING btree (work_order_id)
--   idx_work_order_updates_org_id: CREATE INDEX idx_work_order_updates_org_id ON public.work_order_updates USING btree (org_id)
--   idx_work_order_updates_updated_by_user_id: CREATE INDEX idx_work_order_updates_updated_by_user_id ON public.work_order_updates USING btree (updated_by_user_id)
--   work_order_updates_pkey: CREATE UNIQUE INDEX work_order_updates_pkey ON public.work_order_updates USING btree (id)
-- RLS: ENABLED
-- Policies:
--   wo_updates_insert  (INSERT)  roles={public}
--   wo_updates_select  (SELECT)  roles={public}

-- -----------------------------------------------------------------------------
-- TABLE: public.work_orders
-- -----------------------------------------------------------------------------
CREATE TABLE public.work_orders (
  id                              uuid  NOT NULL  DEFAULT gen_random_uuid(),
  property_id                     uuid  NOT NULL,
  org_id                          uuid  NOT NULL,
  vendor_id                       uuid,
  assigned_crew_id                uuid,
  title                           text  NOT NULL,
  description                     text,
  priority                        priority_level  NOT NULL  DEFAULT 'medium'::priority_level,
  status                          wo_status  NOT NULL  DEFAULT 'pending'::wo_status,
  source                          wo_source  NOT NULL  DEFAULT 'manual'::wo_source,
  source_schedule_id              uuid,
  scheduled_date                  date,
  completed_date                  date,
  estimated_cost                  numeric(10,2),
  actual_cost                     numeric(10,2),
  portal_enabled                  boolean  NOT NULL  DEFAULT false,
  completion_token                uuid,
  completion_token_expires_at     timestamp with time zone,
  completion_notes                text,
  invoice_reference               text,
  created_at                      timestamp with time zone  NOT NULL  DEFAULT now(),
  updated_at                      timestamp with time zone  NOT NULL  DEFAULT now(),
  wo_number                       text,
  category                        wo_category,
  nte_amount                      numeric(10,2),
  access_notes                    text,
  vendor_acknowledged_at          timestamp with time zone,
  vendor_acknowledged_by          uuid,
  completion_verified_at          timestamp with time zone,
  completion_verified_by          uuid,
  vendor_rating                   smallint,
  vendor_rating_notes             text,
  assigned_crew_member_id         uuid,
  asset_id                        uuid,
  source_turnover_id              uuid,
  public_token                    text,
  public_token_expires_at         timestamp with time zone,
  public_viewed_at                timestamp with time zone,
  public_signed_off_at            timestamp with time zone,
  sign_off_notes                  text,
  vendor_dispatch_email           text,
  lockbox_code                    text,
  parking_notes                   text,
  scheduled_time                  time without time zone
);

-- Primary Key:
--   work_orders_pkey: PRIMARY KEY (id)
-- Foreign Keys:
--   work_orders_asset_id_fkey: FOREIGN KEY (asset_id) REFERENCES property_assets(id) ON DELETE SET NULL
--   work_orders_assigned_crew_id_fkey: FOREIGN KEY (assigned_crew_id) REFERENCES crew_members(id) ON DELETE SET NULL
--   work_orders_assigned_crew_member_id_fkey: FOREIGN KEY (assigned_crew_member_id) REFERENCES crew_members(id) ON DELETE SET NULL
--   work_orders_completion_verified_by_fkey: FOREIGN KEY (completion_verified_by) REFERENCES auth.users(id) ON DELETE SET NULL
--   work_orders_org_id_fkey: FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
--   work_orders_property_id_fkey: FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
--   work_orders_source_turnover_id_fkey: FOREIGN KEY (source_turnover_id) REFERENCES turnovers(id) ON DELETE SET NULL
--   work_orders_vendor_acknowledged_by_fkey: FOREIGN KEY (vendor_acknowledged_by) REFERENCES auth.users(id) ON DELETE SET NULL
--   work_orders_vendor_id_fkey: FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL
-- Check Constraints:
--   work_orders_vendor_rating_check: CHECK (((vendor_rating >= 1) AND (vendor_rating <= 5)))
-- Indexes:
--   idx_work_orders_asset_id: CREATE INDEX idx_work_orders_asset_id ON public.work_orders USING btree (asset_id)
--   idx_work_orders_assigned_crew_id: CREATE INDEX idx_work_orders_assigned_crew_id ON public.work_orders USING btree (assigned_crew_id)
--   idx_work_orders_assigned_crew_member_id: CREATE INDEX idx_work_orders_assigned_crew_member_id ON public.work_orders USING btree (assigned_crew_member_id)
--   idx_work_orders_completion_token: CREATE INDEX idx_work_orders_completion_token ON public.work_orders USING btree (completion_token)
--   idx_work_orders_completion_verified_by: CREATE INDEX idx_work_orders_completion_verified_by ON public.work_orders USING btree (completion_verified_by)
--   idx_work_orders_org_id: CREATE INDEX idx_work_orders_org_id ON public.work_orders USING btree (org_id)
--   idx_work_orders_org_status: CREATE INDEX idx_work_orders_org_status ON public.work_orders USING btree (org_id, status)
--   idx_work_orders_pending_signoff: CREATE INDEX idx_work_orders_pending_signoff ON public.work_orders USING btree (public_token_expires_at) WHERE ((public_signed_off_at IS NULL) AND (public_token IS NOT NULL))
--   idx_work_orders_property_id: CREATE INDEX idx_work_orders_property_id ON public.work_orders USING btree (property_id)
--   idx_work_orders_public_token: CREATE UNIQUE INDEX idx_work_orders_public_token ON public.work_orders USING btree (public_token) WHERE (public_token IS NOT NULL)
--   idx_work_orders_scheduled_date: CREATE INDEX idx_work_orders_scheduled_date ON public.work_orders USING btree (scheduled_date)
--   idx_work_orders_status: CREATE INDEX idx_work_orders_status ON public.work_orders USING btree (status)
--   idx_work_orders_vendor_acknowledged_by: CREATE INDEX idx_work_orders_vendor_acknowledged_by ON public.work_orders USING btree (vendor_acknowledged_by)
--   idx_work_orders_vendor_id: CREATE INDEX idx_work_orders_vendor_id ON public.work_orders USING btree (vendor_id)
--   wo_crew_flag_source_unique: CREATE UNIQUE INDEX wo_crew_flag_source_unique ON public.work_orders USING btree (source_turnover_id) WHERE ((source = 'crew_flag'::wo_source) AND (source_turnover_id IS NOT NULL))
--   wo_maintenance_schedule_date_unique: CREATE UNIQUE INDEX wo_maintenance_schedule_date_unique ON public.work_orders USING btree (source_schedule_id, scheduled_date) WHERE ((source = 'maintenance_schedule'::wo_source) AND (source_schedule_id IS NOT NULL))
--   work_orders_completion_token_unique: CREATE UNIQUE INDEX work_orders_completion_token_unique ON public.work_orders USING btree (completion_token) WHERE (completion_token IS NOT NULL)
--   work_orders_org_wo_number_unique: CREATE UNIQUE INDEX work_orders_org_wo_number_unique ON public.work_orders USING btree (org_id, wo_number) WHERE (wo_number IS NOT NULL)
--   work_orders_pkey: CREATE UNIQUE INDEX work_orders_pkey ON public.work_orders USING btree (id)
-- RLS: ENABLED
-- Policies:
--   wo_crew_member_read  (SELECT)  roles={public}
--   work_orders_delete  (DELETE)  roles={public}
--   work_orders_insert  (INSERT)  roles={public}
--   work_orders_select  (SELECT)  roles={public}
--   work_orders_update  (UPDATE)  roles={public}
-- NOTE: assigned_crew_id (deprecated per CLAUDE.md) still exists as a live column with its own FK/index alongside assigned_crew_member_id — both present in the live schema.

-- =============================================================================
-- 4. FUNCTIONS (public schema) — signatures only. Full bodies live in the
--    migration noted after each entry; read that file for the implementation.
-- =============================================================================

-- assign_wo_number() -> trigger [plpgsql]
--   see: 20260608231111_security_idempotency_hardening.sql
-- claim_pending_integration_link(p_pending_link_token text, p_user_id uuid) -> TABLE(provider_id text, external_user_id text, org_id uuid) [plpgsql, SECURITY DEFINER]
--   see: 20260707152648_marketplace_pending_integration_links.sql
-- cleanup_expired_oauth_states() -> void [sql, SECURITY DEFINER]
--   see: 20260531181701_integration_framework.sql
-- cleanup_expired_pending_integration_links() -> void [plpgsql, SECURITY DEFINER]
--   see: 20260707152648_marketplace_pending_integration_links.sql
-- cleanup_webhook_dedup() -> void [sql, SECURITY DEFINER]
--   see: 20260707141404_rename_webhook_dedup_table.sql
-- create_organization_with_owner(p_user_id uuid, p_name text, p_slug text, p_billing_email text, p_max_properties integer, p_trial_ends_at timestamptz) -> TABLE(org_id uuid, created boolean) [plpgsql, SECURITY DEFINER]
--   see: 20260624140430_create_organization_with_owner_function.sql
-- create_pending_integration_link(p_pending_link_token text, p_provider_id text, p_external_user_id text, p_access_token text, p_refresh_token text, p_scope text, p_metadata jsonb) -> uuid [plpgsql, SECURITY DEFINER]
--   see: 20260707152648_marketplace_pending_integration_links.sql
-- get_asset_repair_summary() -> TABLE(asset_id uuid, total_repairs bigint, total_repair_cost numeric, last_serviced_at date) [sql, SECURITY DEFINER]
--   see: 20260609000908_algorithm_audit_db_functions.sql
-- get_crew_member_id() -> uuid [sql, SECURITY DEFINER]
--   see: 20260608231111_security_idempotency_hardening.sql
-- get_crew_turnover_ids() -> SETOF uuid [sql, SECURITY DEFINER]
--   see: 20260616220714_fix_turnovers_rls_recursion_and_org_id.sql
-- get_repeat_issues(since_date timestamptz) -> TABLE(org_id uuid, property_id uuid, category text, wo_count bigint) [sql, SECURITY DEFINER]
--   see: 20260609000908_algorithm_audit_db_functions.sql
-- get_system_health() -> jsonb [plpgsql, SECURITY DEFINER]
--   see: 20260622121948_get_system_health_rpc.sql
-- get_user_org_ids() -> SETOF uuid [sql, SECURITY DEFINER]  — canonical RLS helper, referenced by policies across nearly every table
--   see: 20260608231111_security_idempotency_hardening.sql
-- handle_new_user() -> trigger [plpgsql, SECURITY DEFINER]
--   see: 20260608231111_security_idempotency_hardening.sql
-- is_org_member(p_org_id uuid, p_roles member_role[]) -> boolean [sql, SECURITY DEFINER]  — canonical RLS helper; 'owner' role always passes regardless of p_roles
--   see: 20260605221102_fix_owner_role_rls_permissions.sql
-- is_platform_staff() -> boolean [sql, SECURITY DEFINER]
--   see: 20260630100200_support_staff_backfill.sql (search_path pinned later in 20260707141424_security_definer_hardening.sql)
-- match_kb_chunks(query_embedding vector, match_count integer, min_similarity double precision) -> TABLE(id uuid, title text, content text, source text, similarity double precision) [sql, SECURITY DEFINER]
--   see: 20260620233632_support_bot_scaffold.sql / 20260629212812_support_bot_phase2_embeddings.sql (search_path pinned + extensions-schema arg type later in 20260707141424_security_definer_hardening.sql, 20260707144927_relocate_vector_extension.sql)
-- next_wo_number(p_org_id uuid) -> text [plpgsql, SECURITY DEFINER]
--   see: 20260608231111_security_idempotency_hardening.sql
-- next_work_order_invoice_seq() -> bigint [sql, SECURITY DEFINER]
--   see: 20260704203345_claude_61_4_invoice_seq.sql
-- populate_checklist_item_turnover_id() -> trigger [plpgsql, SECURITY DEFINER]
--   see: 20260611071742_checklist_instance_items_turnover_id_denorm.sql
-- populate_turnover_assignment_denorm() -> trigger [plpgsql, SECURITY DEFINER]
--   see: 20260611063911_turnover_assignments_user_id_denorm.sql
-- prevent_non_deletable_checklist_mutation() -> trigger [plpgsql]
-- prevent_non_deletable_checklist_update() -> trigger [plpgsql]
--   see (both): 20260628195657_non_deletable_enforcement_inventory_order_aggregation.sql
-- purge_expired_audit_events() -> jsonb [plpgsql, SECURITY DEFINER]
--   see: 20260618192912_audit_retention.sql
-- read_integration_refresh_token(p_user_id uuid, p_provider_id text) -> text [plpgsql, SECURITY DEFINER]
-- store_integration_refresh_token(p_user_id uuid, p_provider_id text, p_refresh_token text, p_expires_at timestamptz) -> uuid [plpgsql, SECURITY DEFINER]
--   see (both): 20260610224105_integration_refresh_token_functions.sql
-- read_integration_token(p_user_id uuid, p_provider_id text) -> text [plpgsql, SECURITY DEFINER]
-- revoke_integration_token(p_user_id uuid, p_provider_id text) -> void [plpgsql, SECURITY DEFINER]
--   see: 20260531181701_integration_framework.sql
-- replace_master_checklist_items(p_org_id uuid, p_items jsonb) -> void [plpgsql, SECURITY DEFINER]
--   see: 20260704182905_claude_61_0_security_hardening.sql
-- set_comm_log_updated_at() -> trigger [plpgsql]
--   see: 20260608231111_security_idempotency_hardening.sql
-- set_updated_at() -> trigger [plpgsql]  — generic updated_at trigger, reused across most tables (see Triggers section)
--   see: 20260609112414_fix_updated_at_trigger.sql
-- store_integration_token(p_user_id uuid, p_provider_id text, p_access_token text, p_external_user_id text, p_scope text, p_metadata jsonb) -> uuid [plpgsql, SECURITY DEFINER]
--   see: 20260707144918_deterministic_org_resolution.sql (deterministic org_id resolution; originally defined in 20260531181701_integration_framework.sql)
-- sync_turnover_assignment_property_id() -> trigger [plpgsql, SECURITY DEFINER]
-- sync_turnover_assignment_user_id() -> trigger [plpgsql, SECURITY DEFINER]
--   see (both): 20260611063911_turnover_assignments_user_id_denorm.sql
-- sync_wo_actual_cost() -> trigger [plpgsql]
--   see: 20260608231111_security_idempotency_hardening.sql

-- =============================================================================
-- 5. TRIGGERS (public schema)
-- =============================================================================

-- Most tables with an updated_at column get the generic BEFORE UPDATE trigger:
--   <table>_updated_at  BEFORE UPDATE  ->  set_updated_at()
-- on: bookings, checklist_instance_items, checklist_instances, checklist_templates,
--     crew_members, ical_feeds, inventory_items, maintenance_schedules,
--     org_master_checklist_items, org_master_maintenance_schedules, organizations,
--     owner_transactions, profiles, properties, purchase_orders, turnovers,
--     vendors, work_orders
--
-- Non-generic triggers:
-- checklist_instance_items:
--   trg_checklist_items_non_deletable_delete  BEFORE DELETE  -> prevent_non_deletable_checklist_mutation()
--   trg_checklist_items_non_deletable_update  BEFORE UPDATE  -> prevent_non_deletable_checklist_update()
--   trg_populate_checklist_item_turnover_id   BEFORE INSERT  -> populate_checklist_item_turnover_id()
-- crew_members:
--   trg_sync_turnover_assignment_user_id      AFTER UPDATE   -> sync_turnover_assignment_user_id()
-- turnover_assignments:
--   trg_populate_turnover_assignment_denorm   BEFORE INSERT  -> populate_turnover_assignment_denorm()
-- turnovers:
--   trg_sync_turnover_assignment_property_id  AFTER UPDATE   -> sync_turnover_assignment_property_id()
-- work_order_line_items:
--   sync_wo_cost_on_line_items   AFTER INSERT OR UPDATE OR DELETE  -> sync_wo_actual_cost()
-- work_orders:
--   work_orders_assign_number    BEFORE INSERT  -> assign_wo_number()

-- =============================================================================
-- 6. REALTIME PUBLICATION (supabase_realtime)
-- =============================================================================

-- Tables currently delivering postgres_changes events to clients:
--   messages, property_assets, support_conversations, support_messages, system_job_runs
--
-- Notably NOT in this list despite being read by client code: checklist_instances,
-- checklist_instance_items, turnovers, turnover_assignments, inventory_items,
-- work_orders — the crew PWA and PM dashboard read these via direct Supabase
-- queries (PM dashboard) or the Dexie sync layer (crew PWA), not postgres_changes,
-- so their absence here is expected, not a gap. Before adding a new table here,
-- check whether it actually needs push-based delivery or whether the existing
-- poll/refetch pattern already used by its consumer is sufficient.
