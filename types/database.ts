/**
 * FieldStay — Database Types
 *
 * Hand-written to match the live Supabase schema.
 * After connecting Supabase CLI, replace with:
 *   npx supabase gen types typescript --linked > types/database.ts
 * which generates these automatically from your live schema.
 *
 * Last updated: integration framework added (integration_providers,
 * integration_connections, oauth_states).
 */

/** A Postgres `json`/`jsonb` value. Defined by the generated schema file. */
import type { Json } from './database.generated'
export type { Json } from './database.generated'

// ─────────────────────────────────────────────────────────────
// Scalar union types — mirror Postgres enums and CHECK constraints
// ─────────────────────────────────────────────────────────────

export type OrgPlan             = 'hosts' | 'starter' | 'growth' | 'pro' | 'portfolio' | 'enterprise' | 'platform'
export type OrgPlanStatus       = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'paused'
export type MemberRole          = 'owner' | 'admin' | 'manager' | 'crew' | 'viewer'
export type PropertyType        = 'house' | 'condo' | 'cabin' | 'cottage' | 'townhouse' | 'other'
export type IcalSource          = 'airbnb' | 'vrbo' | 'booking_com' | 'direct' | 'other'
export type SyncStatus          = 'pending' | 'success' | 'error'
export type BookingStatus       = 'confirmed' | 'cancelled' | 'blocked' | 'tentative'
export type BookingSource       = 'airbnb' | 'vrbo' | 'booking_com' | 'direct' | 'manual' | 'ownerrez' | 'other'
export type TurnoverStatus      = 'pending_assignment' | 'assigned' | 'in_progress' | 'completed' | 'flagged' | 'cancelled'
export type PriorityLevel       = 'low' | 'medium' | 'high' | 'urgent'
export type ContactPref         = 'email' | 'sms' | 'both'
export type ChecklistStatus     = 'not_started' | 'in_progress' | 'completed'
export type InventoryCategory   = 'paper_goods' | 'cleaning' | 'kitchen' | 'bath' | 'laundry' | 'bedroom' | 'bedroom_linens' | 'outdoor' | 'maintenance_safety' | 'guest_experience' | 'technology' | 'other'
// Declared HERE, not re-exported from lib/inventory/par-engine.ts, even though
// that module is the par engine's source of truth for everything else.
// scripts/check-type-drift.mjs diffs each Postgres enum against a TS union it
// parses out of THIS file with /^export type (\w+)\s*=/ — a brace re-export
// (`export type { ParMode }`) matches nothing, so the gate would report a
// parse miss rather than a real comparison. par-engine.ts imports these back.
export type ParMode             = 'static' | 'smart'
export type ParSmartGroup       = 'bathroom_essential' | 'bedroom_essential' | 'guest_consumable'
export type PoStatus            = 'draft' | 'sent' | 'acknowledged' | 'ordered' | 'received' | 'cancelled'
export type VendorSpecialty     = 'plumbing' | 'electrical' | 'hvac' | 'landscaping' | 'cleaning' | 'pest_control' | 'pool' | 'roofing' | 'general' | 'other'
export type WoStatus            = 'pending' | 'quote_requested' | 'assigned' | 'in_progress' | 'completed' | 'cancelled'
export type WoSource            = 'manual' | 'maintenance_schedule' | 'crew_flag' | 'guest_report' | 'vacancy_gap_suggestion' | 'inspection'
// Inspections (docs/INSPECTIONS_SPEC.md phase 1).
export type InspectionResult       = 'pass' | 'fail' | 'na'
export type InspectionResponseType = 'yes_no' | 'count' | 'date' | 'text' | 'photo'
// 'notify' is neither a work order nor a purchase order: a lapsed permit or
// unpaid HOA dues is a notification, not a dispatch. See §5 of the spec.
export type InspectionRemediation  = 'none' | 'work_order' | 'purchase_order' | 'notify'
// What the inspector picks on a fail — MULTI-SELECT, so 'replace' + 'service'
// expresses the purchase and the install as one decision.
export type InspectionAction       = 'repair' | 'service' | 'replace'
// §6's repeat visit. The inspector is ASKED rather than a key deciding, because
// once the action model exists one form item no longer means one fault:
// "Refrigeration" failing for a water filter and later for a compressor is the
// same form_item_id and two unrelated problems.
export type InspectionRepeatAnswer = 'same' | 'new'
// §7: what a maintenance_schedules row produces when it comes due.
export type ScheduleCreates        = 'work_order' | 'inspection'
export type WoCategory          =
  | 'hvac' | 'plumbing' | 'electrical' | 'appliance' | 'cleaning'
  | 'landscaping' | 'roofing' | 'flooring' | 'windows_doors'
  | 'pest_control' | 'pool' | 'structural' | 'general' | 'other'
export type LineItemType        =
  | 'labor' | 'material' | 'equipment' | 'subcontractor' | 'other'
export type ScheduleType        = 'routine' | 'seasonal'
export type ScheduleFrequency   = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'semi_annual' | 'annual'
export type MaintenanceCatalogCategory = 'water_features' | 'heating_fuel' | 'outdoor_grounds' | 'systems' | 'amenities'
export type TxnType             = 'revenue' | 'expense'
export type TxnCategory         = 'booking_revenue' | 'cleaning_fee' | 'maintenance' | 'restock' | 'utility' | 'insurance' | 'supplies' | 'other'
export type QuoteRequestStatus  = 'pending' | 'submitted' | 'approved' | 'declined' | 'expired'
export type CrewRole            = 'cleaning' | 'landscaping' | 'maintenance' | 'general'
export type AutoAssignMode       = 'suggest' | 'autopilot' | 'disabled'
export type VendorAutoAssignMode = 'suggest' | 'disabled'
export type SuggestionStatus     = 'pending' | 'accepted' | 'overridden' | 'dismissed'

// Asset Health
export type AssetType =
  | 'hvac' | 'water_heater' | 'roof' | 'refrigerator' | 'washer'
  | 'dryer' | 'dishwasher' | 'microwave' | 'oven_range' | 'pool_pump'
  | 'hot_tub' | 'garage_door' | 'smart_lock' | 'deck_structure'
  | 'electrical_panel' | 'plumbing_system' | 'septic_system' | 'well_pump'
  | 'generator' | 'solar_system' | 'other'
  | 'water_shutoff_valve' | 'solar_inverter' | 'whole_home_water_filter'
  | 'heated_tile_system' | 'range_hood_vent' | 'coffee_station'
  | 'toaster_oven' | 'wifi_router' | 'fire_extinguisher' | 'thermostat'
  | 'ice_maker' | 'garbage_disposal' | 'trash_compactor'
export type MacrsClass        = '5_year' | '15_year' | '27_5_year' | '39_year' | 'section_179'
export type ComplianceDocType = 'coi' | 'workers_comp' | 'business_license' | 'contractor_license' | 'bonding' | 'other'
export type ComplianceStatus  = 'compliant' | 'expiring_soon' | 'grace_period' | 'hard_blocked' | 'no_documents'

// Communication logs
export type CommRecipientType   = 'vendor' | 'crew'
export type CommChannel         = 'email' | 'sms' | 'phone' | 'in_person' | 'note'
export type CommSource          = 'manual' | 'system'

// Integration framework
export type IntegrationAuthType = 'oauth2' | 'api_key'
export type IntegrationStatus   = 'active' | 'revoked' | 'error' | 'disconnected'

// Support bot
export type SupportCategory    = 'faq' | 'technical' | 'account_specific'
// 'human' = a platform staff member replying from the support inbox
// (app/api/support-inbox/reply/route.ts) — distinct from the bot 'assistant'.
export type SupportMessageRole = 'user' | 'assistant' | 'human'

// ─────────────────────────────────────────────────────────────
// Row interfaces — one per Supabase table
// ─────────────────────────────────────────────────────────────

export interface Profile {
  id:                     string
  full_name:              string | null
  phone:                  string | null
  avatar_url:             string | null
  email_unsubscribed_at:  string | null
  // NOT NULL with a DEFAULT in the DB (20260801100000), so every row has one.
  unsubscribe_token:      string
  created_at:             string
  updated_at:             string
}

export interface Organization {
  id:                           string
  name:                         string
  slug:                         string
  billing_email:                string | null
  stripe_customer_id:           string | null
  stripe_subscription_id:       string | null
  /**
   * `created` of the most recent Stripe subscription event applied to this
   * row. Drives update_organization_subscription_from_stripe's stale-delivery
   * guard — Stripe retries for ~3 days and does not guarantee order, so an
   * older event must not overwrite a newer one.
   */
  stripe_event_at:              string | null
  plan:                         OrgPlan
  plan_status:                  OrgPlanStatus
  trial_ends_at:                string | null
  max_properties:               number
  onboarding_steps_completed:   Record<string, boolean>
  bedroom_room_template_id:        string | null
  bathroom_room_template_id:       string | null
  default_room_templates_seeded_at: string | null
  preferred_retailer:           string | null
  kroger_location_id:           string | null
  kroger_location_name:         string | null
  auto_assign_enabled:          boolean
  auto_assign_mode:             AutoAssignMode
  /**
   * The org-wide SAFETY inspection template (20260824091200). Both null until
   * the onboarding step is answered, and both-or-neither is a CHECK — a
   * half-answered template would fan out schedules with no due date.
   *
   * A month rather than a date because a template has no due date: it is the
   * rule that produces `next_due_date` for each property's schedule. Not the
   * dropped `maintenance_schedules.month_due`, which sat on the schedule
   * ALONGSIDE next_due_date and could disagree with it.
   */
  inspection_safety_frequency:   ScheduleFrequency | null
  inspection_safety_start_month: number | null
  vendor_auto_assign_mode:      VendorAutoAssignMode
  comms_log_retention_days:     number
  guest_pii_retention_days:     number
  slack_webhook_url:            string | null
  /**
   * Roadshow demo tenant marker (20260726160000_demo_org_support.sql).
   * NOT an RLS bypass — the demo org is an ordinary tenant. Gates
   * guest/vendor-facing side effects into demo_activity_log and scopes the
   * one-tap reset. NOT NULL DEFAULT false, so non-null here.
   */
  is_demo:                      boolean
  /**
   * Annual inflation assumption for Capital Planning's What-If projections
   * (20260814142509). NOT NULL DEFAULT 4.0, CHECK-bounded 0-25, so non-null
   * here.
   */
  capex_inflation_rate_pct:     number
  created_at:                   string
  updated_at:                   string
}

export interface OrganizationMember {
  id:                 string
  org_id:             string
  user_id:            string | null
  role:               MemberRole
  invited_email:      string | null
  invite_token:       string | null
  invite_accepted_at: string | null
  created_at:         string
}

/** properties.sponsor_assignment_mode — see the field's note on Property. */
export type SponsorAssignmentMode = 'auto' | 'manual'

export interface Property {
  id:                      string
  org_id:                  string
  name:                    string
  address:                 string | null
  city:                    string | null
  state:                   string | null
  zip:                     string | null
  access_instructions:     string | null
  property_type:           PropertyType
  bedrooms:                number
  bathrooms:               number | null
  max_guests:              number
  avg_stay_length:         number
  avg_turnovers_per_month: number
  wifi_name:               string | null
  wifi_password:           string | null
  door_code_secret_id:     string | null
  checkout_time:           string
  checkin_time:            string
  timezone:                string
  internal_notes:          string | null
  setup_steps_completed:   Record<string, boolean>
  is_active:               boolean
  /**
   * Whether this property's guidebook sponsors are chosen automatically (by
   * proximity) or were picked by a manager.
   *
   * 'auto' is the default and covers every pre-existing row — the migration
   * backfills nothing. It flips to 'manual' the first time a manager edits
   * this property's assignments, INCLUDING when they clear them all, which is
   * the case zero assignment rows cannot express on its own: without this
   * column, a deliberately emptied property is indistinguishable from an
   * unconfigured one and the automatic resolver reinstates everything the
   * manager just removed.
   */
  sponsor_assignment_mode: SponsorAssignmentMode
  avg_nightly_rate:        number | null
  cleaning_cost:           number | null
  same_day_premium_pct:    number | null
  cleaning_cost_visible_to_owner: boolean
  square_footage:          number | null
  lat:                     number | null
  lng:                     number | null
  house_manual:            string | null
  checkout_instructions:   string | null
  amenities:               Record<string, boolean> | null
  smoking_allowed:         boolean | null
  pets_allowed:            boolean | null
  max_pets:                number | null
  events_allowed:          boolean | null
  min_renter_age:          number | null
  /**
   * Monitored alarm / security system. NULL = NEVER ASKED, which is the state
   * the Safety form's capture item renders on — a NOT NULL DEFAULT false would
   * have answered the question for every existing property and the item would
   * never have appeared. Editable by the PM, which is what lets an alarm
   * installed after the first walk re-enable the annual condition check.
   */
  has_security_system:     boolean | null
  external_id:             string | null
  external_source:         string | null
  /**
   * When the PMS first 404'd this `external_id`. Pauses per-property provider
   * polling; cleared automatically the next time a sync lists the property.
   * Deliberately NOT the same thing as `is_active = false` — see
   * 20260823170441.
   */
  external_missing_since:  string | null
  created_at:              string
  updated_at:              string
}

export interface PropertyOwner {
  id:                 string
  org_id:             string
  property_id:        string
  name:               string
  email:              string | null
  phone:              string | null
  revenue_share_pct:  number | null
  notes:              string | null
  share_capital_plan: boolean
  created_at:         string
  updated_at:         string
}

export interface OwnerPortalToken {
  id:                string
  property_owner_id: string
  token:             string
  expires_at:        string | null
  last_accessed_at:  string | null
  property_ids:      string[] | null
  is_multi:          boolean
  revoked_at:        string | null
  created_at:        string
}

export interface IcalFeed {
  id:               string
  property_id:      string
  org_id:           string
  name:             string
  url:              string
  source:           IcalSource
  last_synced_at:   string | null
  last_sync_status: SyncStatus
  last_sync_error:  string | null
  is_active:        boolean
  created_at:       string
  updated_at:       string
}

export interface Booking {
  id:                   string
  property_id:          string
  org_id:               string
  ical_feed_id:         string | null
  ical_uid:             string | null
  external_id:          string | null
  external_source:      string | null
  guest_name:           string | null
  guest_email:          string | null
  checkin_date:         string
  checkout_date:        string
  checkin_time:         string | null
  checkout_time:        string | null
  source:               BookingSource
  status:               BookingStatus
  notes:                string | null
  raw_ical_data:        Record<string, unknown> | null
  has_overlap_conflict: boolean
  is_block:             boolean
  stay_type:            'guest_stay' | 'owner_stay'
  guidebook_token:      string | null
  guidebook_pre_arrival_email_sent_at: string | null
  actual_total_amount:  number | null
  door_code_secret_id:  string | null
  door_code_lock:       string | null
  door_code_synced_at:  string | null
  guest_pii_anonymized_at: string | null
  created_at:           string
  updated_at:           string
}

export interface CrewMember {
  id:                 string
  org_id:             string
  user_id:            string | null
  name:               string
  email:              string | null
  phone:              string | null
  preferred_contact:  ContactPref
  sms_carrier:        string | null
  specialty:          string
  role:               CrewRole
  is_active:          boolean
  /**
   * May turnover auto-assignment/suggestion pick this person?
   * NOT NULL DEFAULT true (20260827034958) — opt-out, so existing and
   * provider-synced crew stay eligible without anyone touching them.
   * Governs only what the engine PROPOSES; manual assignment is unaffected.
   */
  auto_assign_eligible: boolean
  notes:              string | null
  home_zip:           string | null
  home_lat:           number | null
  home_lng:           number | null
  reliability_score:  number | null
  capacity_score:     number | null
  invite_token:       string | null
  invite_sent_at:     string | null
  invite_accepted_at: string | null
  external_id:        string | null
  external_source:    string | null
  created_at:         string
  updated_at:         string
}

export interface CrewAvailability {
  id:             string
  org_id:         string
  crew_member_id: string
  available_date: string
  is_available:   boolean
  notes:          string | null
  created_at:     string
}

export interface CrewFeedback {
  id:             string
  org_id:         string
  crew_member_id: string
  property_id:    string | null
  feedback_text:  string
  // Renamed from created_at → submitted_at on prod out-of-band, then
  // replicated to e2e by 20260724160000_capture_prod_drift_functions_columns_seed.sql.
  // types/database.ts and app/(dashboard)/support-inbox/{page,support-inbox-client}.tsx
  // still referenced the old name until the drift check caught it — see
  // 20260725200500_db_type_shape_report.sql / scripts/check-type-drift.mjs.
  submitted_at:   string
}

/**
 * Sync incident reporting: a device-reported incident proving work was
 * captured but dead-lettered or stalled before reaching the server — a
 * monitoring/support signal for crew sync reliability, not part of any
 * customer-facing promise. Service-role insert only
 * (app/api/crew/sync-incidents) — org members may SELECT but never write,
 * since a client must not be able to manufacture evidence.
 */
export interface CrewSyncIncident {
  id:                 string
  org_id:             string
  crew_member_id:     string | null
  user_id:            string | null
  client_incident_id: string
  device_label:       string | null
  surface:            'crew' | 'vendor' | 'dashboard'
  kind:               'dead_letter' | 'stalled'
  table_name:         string
  entity_id:          string | null
  reason:             'http_4xx' | 'http_5xx' | 'constraint_violation' | 'max_retries' | 'stalled_threshold' | null
  occurred_at:        string
  mutation_queued_at: string | null
  reported_at:        string
  created_at:         string
}

export interface CrewAvailabilityEntry {
  available_date: string
  is_available:   boolean
  notes:          string | null
}

export interface AssignmentOutcome {
  id:                 string
  org_id:             string
  turnover_id:        string
  crew_member_id:     string
  property_id:        string | null
  suggested_score:    number | null
  score_breakdown:    Record<string, unknown> | null
  was_suggestion:     boolean
  was_accepted:       boolean | null
  override_reason:    string | null
  started_at:         string | null
  completed_at:       string | null
  duration_minutes:   number | null
  pm_rating:          number | null
  property_bedrooms:  number | null
  was_late:           boolean | null
  was_missed:         boolean
  scored_at:          string | null
  created_at:         string
}

export interface Vendor {
  id:                   string
  org_id:               string
  name:                 string
  contact_name:         string | null
  email:                string | null
  phone:                string | null
  specialty:            VendorSpecialty
  portal_enabled:       boolean
  notes:                string | null
  is_active:            boolean
  avg_rating:           number | null
  rating_count:         number
  on_time_pct:          number | null
  on_time_sample_size:  number
  address:              string | null
  city:                 string | null
  state:                string | null
  service_zip:          string | null
  service_radius_miles: number | null
  lat:                  number | null
  lng:                  number | null
  created_at:           string
  updated_at:           string
  stripe_connect_token:           string
  stripe_connect_account_id:      string | null
  stripe_connect_account_pending_at: string | null   // 20260820180000 — GitHub #573
  stripe_connect_charges_enabled: boolean
  stripe_connect_onboarded_at:    string | null
  stripe_connect_invite_sent_at:  string | null
  stripe_connect_invite_claimed_at: string | null
  /**
   * Durable reference for one invite delivery, used as the Resend
   * Idempotency-Key so a retry after a failed sent-status write cannot deliver
   * a second email. See lib/stripe/vendor-connect-invite.ts (GitHub #574).
   */
  stripe_connect_invite_delivery_ref: string | null
  // 20260730500000_vendor_stripe_connect_token_expiry.sql. NULL = the current
  // token has never been emailed → not usable (treated as expired).
  stripe_connect_token_expires_at:  string | null
}

export interface ChecklistTemplate {
  id:          string
  org_id:      string
  property_id: string | null
  name:        string
  description: string | null
  is_default:  boolean
  created_at:  string
  updated_at:  string
}

export interface ChecklistTemplateSection {
  id:                     string
  template_id:            string
  name:                   string
  sort_order:             number
  // Added by 20260604223345_add_checklist_template_broadcasting.sql — was
  // missing from this interface even though the column has existed on the
  // live table since then; read/written by lib/inngest/functions/checklist-broadcast.ts.
  requires_section_photo: boolean
  // Added by 20260717120000_room_templates.sql. NULL means a fully custom
  // section (every section before this migration, and any hand-added one
  // afterward) — non-null means this section's items were populated from
  // that room_templates row and can be bulk-refreshed from it.
  room_template_id:       string | null
  room_synced_at:         string | null
  created_at:             string
}

export interface ChecklistTemplateItem {
  id:             string
  section_id:     string
  template_id:    string
  task:           string
  requires_photo: boolean
  notes:          string | null
  sort_order:     number
  created_at:     string
}

// Reusable, org-scoped room modules ("Standard Bedroom") a property's
// checklist_template_sections can be populated from. See
// FUTURE_ADDITIONS.md #2 and 20260717120000_room_templates.sql.
export interface RoomTemplate {
  id:           string
  org_id:       string
  name:         string
  auto_include: boolean
  is_system:    boolean
  created_at:   string
  updated_at:   string
}

// Org-scoped editable copy of inventory_catalog, seeded on first touch
// (application code, Pass 2). See 20260721140000_templates_hub_schema_pass1.sql.
export interface OrgInventoryCatalogItem {
  id:                        string
  org_id:                    string
  platform_catalog_item_id:  string | null
  name:                      string
  category:                  InventoryCategory
  default_unit:              string
  default_par_level:         number
  par_mode:                  ParMode
  smart_group:               ParSmartGroup | null
  base_qty:                  number
  description:               string | null
  is_active:                 boolean
  /** False for equipment/linens — see lib/inventory/stock-status.ts. */
  is_consumable:             boolean
  created_at:                string
  updated_at:                string
}

// Org-scoped editable copy of maintenance_catalog_items, seeded on first
// touch (application code, Pass 4). See 20260721140000_templates_hub_schema_pass1.sql.
export interface OrgMaintenanceCatalogItem {
  id:                        string
  org_id:                    string
  platform_catalog_item_id:  string | null
  name:                      string
  category:                  string
  suggested_recurrence:      string | null
  asset_category:            string | null
  description:               string | null
  sort_order:                number
  is_active:                 boolean
  created_at:                string
  updated_at:                string
}

export interface RoomTemplateItem {
  id:               string
  room_template_id: string
  task:             string
  requires_photo:   boolean
  notes:            string | null
  sort_order:       number
  created_at:       string
}

export interface PlatformStaff {
  user_id:    string
  role:       'support' | 'admin'
  created_at: string
}

export interface PlatformSeedRoomTemplate {
  id:           string
  name:         string
  auto_include: boolean
  sort_order:   number
  created_at:   string
  updated_at:   string
}

export interface PlatformSeedRoomTemplateItem {
  id:                              string
  platform_seed_room_template_id: string
  task:                            string
  requires_photo:                  boolean
  notes:                           string | null
  sort_order:                      number
  created_at:                      string
}

export interface Turnover {
  id:                    string
  property_id:           string
  org_id:                string
  booking_id:            string | null
  prev_booking_id:       string | null
  checkout_datetime:     string
  checkin_datetime:      string
  window_minutes:        number | null
  status:                TurnoverStatus
  priority:              PriorityLevel
  checklist_template_id: string | null
  notes:                 string | null
  completion_notes:      string | null
  started_at:            string | null
  completed_at:          string | null
  // integer NULL in the live schema (migration
  // 20260731000000_turnover_crew_duration_minutes).
  //
  // Actual crew work-time metric: MAX - MIN across every completion-type
  // timestamp (checklist item completions + inventory's completion signal)
  // — distinct from started_at/completed_at above, which just reflect the
  // Start Turnover / status="completed" button presses. Computed once by
  // turnover-events.ts's record-crew-duration step; null until the
  // turnover completes and a plausible duration is found.
  crew_duration_minutes: number | null
  // Inventory has no per-turnover scoping of its own (inventory_items is
  // persistent, property-level state edited across many turnovers), so
  // "inventory started/confirmed for THIS turnover" lives here instead —
  // mirrors checklist_instances.started_at/completed_at/completed_by_crew_id.
  inventory_started_at:            string | null
  inventory_confirmed_complete_at: string | null
  inventory_confirmed_by_crew_id:  string | null
  auto_generated:        boolean
  is_same_day_turnover:  boolean
  suggested_crew_ids:    string[] | null
  suggestion_reasoning:  string | null
  suggestion_status:     SuggestionStatus | null
  is_archived:           boolean
  // Booking date-change reconciliation (pending new window until PM acks)
  dates_changed_at:              string | null
  dates_change_acknowledged_at:  string | null
  pending_checkin_datetime:      string | null
  pending_checkout_datetime:     string | null
  created_at:            string
  updated_at:            string
  turnover_assignments:  TurnoverAssignment[]
}

export interface TurnoverAssignment {
  id:                string
  org_id:            string | null
  turnover_id:       string
  crew_member_id:    string
  user_id:           string | null
  property_id:       string | null
  assigned_at:       string
  notified_at:       string | null
  notification_type: ContactPref | null
  created_at:        string
  crew_members:      AssignedCrewMember[]
}

export type AssignedCrewMember = {
  id:    string
  name:  string
  phone: string | null
  email: string | null
}

export interface ChecklistInstance {
  id:                  string
  turnover_id:         string
  org_id:              string
  template_id:         string | null
  template_snapshot:   Record<string, unknown>
  status:              ChecklistStatus
  section_photo_path:  string | null
  started_at:          string | null
  completed_at:        string | null
  completed_by_crew_id: string | null
  created_at:          string
  updated_at:          string
}

export interface ChecklistInstanceItem {
  id:                    string
  instance_id:           string
  turnover_id:           string | null
  section_name:          string
  task:                  string
  requires_photo:        boolean
  notes:                 string | null
  sort_order:            number
  is_completed:          boolean
  completed_at:          string | null
  completed_by_crew_id:  string | null
  photo_storage_path:    string | null
  crew_notes:            string | null
  photo_reason:          string | null
  is_section_final_item: boolean
  is_mandatory:          boolean
  non_deletable:         boolean
  asset_discovery_type:  string | null
  created_at:            string
  updated_at:            string
}

export interface ChecklistItemSignal {
  id:                     string
  org_id:                 string
  property_id:            string
  section_name:           string
  task:                   string
  alpha:                  number
  beta:                   number
  flag_probability:       number  // generated, read-only
  dynamic_photo_required: boolean // generated, read-only
  reason:                 string | null
  total_completions:      number
  total_flags:            number
  computed_at:            string
}

export interface InventoryCatalogItem {
  id:                string
  name:              string
  category:          InventoryCategory
  default_unit:      string
  default_par_level: number
  par_mode:          ParMode
  smart_group:       ParSmartGroup | null
  base_qty:          number
  description:       string | null
  is_active:         boolean
  /** False for equipment/linens — see lib/inventory/stock-status.ts. */
  is_consumable:     boolean
  created_at:        string
}

/**
 * Rolling consumption aggregate, one row per (property, item).
 *
 * Service-role write only — populated by the dynamic PAR engine's Inngest
 * steps; org members hold a SELECT policy so the par-levels UI can explain
 * why a smart par resolved the way it did. No primary `id`: the PK is the
 * composite (property_id, inventory_item_id).
 */
// PK is inventory_item_id alone. There is deliberately NO property_id: an
// inventory_item is already property-level, so the column was derivable, and
// a PK of (property_id, inventory_item_id) made PostgREST read this table as
// a many-to-many junction between properties and inventory_items — which broke
// every pre-existing embed between them with PGRST201. See
// 20260811020000_fix_par_stats_junction_ambiguity.sql.
export interface InventoryConsumptionStats {
  inventory_item_id:        string
  org_id:                   string
  avg_rate_per_guest_night: number
  sample_count:             number
  last_sample_at:           string | null
  updated_at:               string
}

export interface InventoryItem {
  id:                      string
  property_id:             string
  org_id:                  string
  catalog_item_id:         string | null
  source_template_id:      string | null
  name:                    string
  category:                InventoryCategory
  unit:                    string
  par_level:               number
  par_mode:                ParMode
  smart_group:             ParSmartGroup | null
  base_qty:                number
  auto_adjust:             boolean
  par_resolved_at:         string | null
  current_quantity:        number
  low_stock_threshold_pct: number
  is_active:               boolean
  /**
   * False for equipment/linens — par is a complete set, not a reorder point,
   * so at-par is green rather than yellow. See lib/inventory/stock-status.ts.
   * Denormalised from the catalog because catalog_item_id is nullable.
   */
  is_consumable:           boolean
  preferred_brand:         string | null
  notes:                   string | null
  first_count_recorded_at: string | null
  created_at:              string
  updated_at:              string
}

export interface InventoryCount {
  id:                   string
  property_id:          string
  org_id:               string
  submitted_by_crew_id: string | null
  submitted_at:         string
  notes:                string | null
  created_at:           string
}

export interface InventoryCountItem {
  id:                string
  count_id:          string
  inventory_item_id: string
  quantity_counted:  number
  created_at:        string
}

export interface PurchaseOrder {
  id:                   string
  property_id:          string
  org_id:               string
  status:               PoStatus
  /** The inspection whose failed purchasable items became this PO. One per inspection. */
  source_inspection_id: string | null
  source_count_id:      string | null
  generated_at:         string
  sent_at:              string | null
  acknowledged_at:      string | null
  notes:                string | null
  total_estimated_cost: number | null
  order_email_sent:     boolean
  is_same_day_flip:     boolean
  created_at:           string
  updated_at:           string
}

export interface PurchaseOrderItem {
  id:                  string
  purchase_order_id:   string
  inventory_item_id:   string | null
  item_name:           string
  current_quantity:    number
  par_level:           number
  quantity_to_buy:     number
  estimated_unit_cost: number | null
  unit:                string | null
  notes:               string | null
  created_at:          string
}

export interface WorkOrderLineItem {
  id:               string
  work_order_id:    string
  org_id:           string
  line_type:        LineItemType
  description:      string
  quantity:         number
  unit:             string | null
  unit_cost:        number
  line_total:       number
  sort_order:       number
  created_at:       string
  vendor_submitted: boolean
}

export type InvoiceStatus =
  | 'pending_payment'
  | 'paid'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded'

export interface WorkOrderInvoice {
  id:                         string
  org_id:                     string
  work_order_id:              string
  vendor_id:                  string
  property_id:                string
  invoice_number:             string
  status:                     InvoiceStatus
  subtotal:                   number
  total:                      number
  platform_fee_amount:        number
  stripe_checkout_session_id: string | null
  stripe_payment_intent_id:   string | null
  paid_at:                    string | null
  // Running total Stripe has refunded on this invoice's payment intent, in
  // dollars — cumulative, not incremental. See the webhook handler for why:
  // charge.refunded reports the running total on every delivery.
  amount_refunded:            number
  refunded_at:                string | null
  submitted_at:               string
  created_at:                 string
}

export interface WorkOrder {
  id:                          string
  property_id:                 string
  org_id:                      string
  vendor_id:                   string | null
  assigned_crew_member_id:     string | null
  reported_by_crew_member_id:  string | null
  wo_number:                   string | null
  title:                       string
  description:                 string | null
  category:                    WoCategory | null
  priority:                    PriorityLevel
  status:                      WoStatus
  source:                      WoSource
  source_schedule_id:          string | null
  /**
   * The failed inspection answer this work order came from (20260823150044).
   * Partial-unique, which is what makes the remediation retry idempotent —
   * and what does NOT stop a repeat visit creating a second one. See §6.
   */
  source_inspection_item_id: string | null
  /**
   * The inspection whose `needs_cleaning` findings rolled up into this ONE
   * cleaning work order (20260824003238). Partial-unique. Deliberately NOT
   * `source_inspection_item_id`: the roll-up covers many findings, and squatting
   * on one of their ids would make `createWorkOrders` treat that finding as
   * already handled and suppress its own repair work order.
   */
  source_inspection_id:        string | null
  source_turnover_id:          string | null
  asset_id:                    string | null
  scheduled_date:              string | null
  scheduled_time:              string | null
  completed_date:              string | null
  estimated_cost:              number | null
  nte_amount:                  number | null
  actual_cost:                 number | null
  access_notes:                string | null
  portal_enabled:              boolean
  completion_token:            string | null
  completion_token_expires_at: string | null
  completion_notes:            string | null
  completed_by_name:           string | null
  invoice_reference:           string | null
  // Quote fields live on the quote_requests table — work_orders itself has
  // no quote_token/quoted_amount columns (removed 2026-07-25 drift fix).
  vendor_acknowledged_at:      string | null
  vendor_acknowledged_by:      string | null
  completion_verified_at:      string | null
  completion_verified_by:      string | null
  // Public dispatch fields (added 2026-06-14)
  public_token:                string | null
  public_token_expires_at:     string | null
  public_viewed_at:            string | null
  public_signed_off_at:        string | null
  sign_off_notes:              string | null
  vendor_dispatch_email:       string | null
  lockbox_code:                string | null
  parking_notes:               string | null
  vendor_rating:               number | null
  vendor_rating_notes:         string | null
  suggested_vendor_ids:        string[] | null
  /**
   * The crew-side twin of `suggested_vendor_ids` (20260824003238), sharing
   * `suggestion_reasoning` and `suggestion_status`. MUTUALLY EXCLUSIVE with the
   * vendor array — enforced by `work_orders_one_suggestion_kind`, because one
   * `suggestion_status` cannot describe two live suggestions.
   */
  suggested_crew_member_ids:   string[] | null
  suggestion_reasoning:        string | null
  suggestion_status:           SuggestionStatus | null
  client_report_id:            string | null
  created_at:                  string
  updated_at:                  string
}

export interface VendorAssignmentOutcome {
  id:              string
  org_id:          string
  work_order_id:   string
  vendor_id:       string
  property_id:     string | null
  suggested_score: number | null
  score_breakdown: Record<string, unknown> | null
  was_suggestion:  boolean
  was_accepted:    boolean | null
  override_reason: string | null
  created_at:      string
}

// ─── Work Order Public Dispatch ───────────────────────────────────────────

export type WorkOrderPublicStatus =
  | 'draft'
  | 'sent'        // dispatched to vendor via email
  | 'viewed'      // vendor opened the magic link
  | 'signed_off'  // vendor submitted sign-off
  | 'cancelled'

export interface WorkOrderPublicView {
  // Core identity
  id:              string
  wo_number:       string
  public_token:    string
  status:          WorkOrderPublicStatus

  // Property
  property_id:     string
  property_name:   string
  property_address: string

  // Job details
  title:           string
  description:     string | null
  scope_of_work:   string | null
  category:        string | null

  // Authorization
  nte_amount:      number | null

  // Access
  access_notes:    string | null
  lockbox_code:    string | null
  parking_notes:   string | null

  // Asset (optional)
  asset_id:        string | null
  asset_name:      string | null

  // Dispatcher (PM contact)
  dispatched_by:   string
  dispatcher_name: string
  dispatcher_org:  string
  dispatcher_phone: string | null

  // Vendor
  vendor_id:            string | null
  vendor_name:          string | null
  vendor_dispatch_email: string | null

  // Lifecycle timestamps
  created_at:           string
  dispatched_at:        string | null
  public_token_expires_at: string | null
  public_viewed_at:     string | null
  public_signed_off_at: string | null
  sign_off_notes:       string | null
}

export interface WorkOrderDispatchInput {
  workOrderId:     string
  vendorEmail:     string
  vendorName:      string
}

export interface WorkOrderUpdate {
  id:                        string
  work_order_id:             string
  org_id:                    string
  updated_by_user_id:        string | null
  updated_via_vendor_portal: boolean
  status_from:               WoStatus | null
  status_to:                 WoStatus | null
  notes:                     string | null
  created_at:                string
}

export interface WorkOrderPhoto {
  id:            string
  work_order_id: string
  storage_path:  string
  uploaded_by:   string | null
  created_at:    string
}

export interface MaintenanceSchedule {
  id:                        string
  property_id:               string
  org_id:                    string
  assigned_vendor_id:        string | null
  vendor_specialty_hint:     VendorSpecialty | null
  name:                      string
  description:               string | null
  schedule_type:             ScheduleType
  frequency:                 ScheduleFrequency | null
  day_of_month_due:          number | null
  estimated_cost:            number | null
  instructions:              string | null
  auto_create_wo:            boolean
  last_completed_date:       string | null
  next_due_date:             string | null
  /**
   * First-of-month of the digest that last reported this schedule as overdue.
   * NULL = never reported.
   *
   * A MONTH, not the occurrence's due date, and that is what makes a schedule
   * still outstanding reappear in next month's digest — the month changes, so
   * the comparison stops matching. Renamed from `overdue_notified_for` when the
   * cadence moved from per-occurrence to monthly (20260825030000).
   */
  overdue_notified_month:    string | null
  active_from_month:         number | null
  active_to_month:           number | null
  asset_category:            string | null
  is_from_standard_template: boolean
  source_template_item_id:   string | null
  source_catalog_item_id:    string | null

  /**
   * §7's discriminator (20260823211930). A `work_order` schedule creates one
   * when it comes due; an `inspection` schedule NOTIFIES, and the row is
   * created when the walk begins — `inspections.started_at` has to be a real
   * start time, not the moment a cron ran.
   *
   * There is deliberately no `anchor_months`: the recurrence anchor is
   * emergent from (next_due_date, frequency), which is what calcNextDueDate
   * already steps forward.
   */
  creates:                   ScheduleCreates
  /** Required when `creates = 'inspection'` — enforced by a CHECK. */
  inspection_form_id:        string | null
  /** An ORG MEMBER, unlike assigned_crew_member_id elsewhere. */
  assigned_to_user_id:       string | null

  is_active:                 boolean
  created_at:                string
  updated_at:                string
}

export interface MaintenanceScheduleTemplate {
  id:          string
  org_id:      string
  name:        string
  description: string | null
  is_system:   boolean
  created_at:  string
}

export interface MaintenanceScheduleTemplateItem {
  id:                    string
  template_id:           string
  name:                  string
  description:           string | null
  schedule_frequency:    ScheduleFrequency
  vendor_specialty_hint: VendorSpecialty | null
  estimated_cost:        number | null
  is_optional_flag:      string | null
  sort_order:            number
  asset_category:        string | null
  active_from_month:     number | null
  active_to_month:       number | null
  created_at:            string
}

export interface MaintenanceCatalogItem {
  id:                   string
  name:                 string
  category:             MaintenanceCatalogCategory
  suggested_recurrence: ScheduleFrequency | null
  asset_category:       string | null
  description:          string | null
  sort_order:           number
  is_active:            boolean
  created_at:           string
}

export interface MaintenanceCompletion {
  id:                      string
  maintenance_schedule_id: string
  property_id:             string
  org_id:                  string
  asset_category:          string | null
  completed_at:            string
  completed_by:            string | null
  notes:                   string | null
  work_order_id:           string | null
  next_due_date_set:       string | null
  created_at:              string
}

export const RECURRENCE_LABELS: Record<ScheduleFrequency, string> = {
  weekly:      'Weekly',
  biweekly:    'Bi-Weekly',
  monthly:     'Monthly',
  quarterly:   'Quarterly',
  semi_annual: 'Semi-Annual',
  annual:      'Annual',
}

export const MONTH_NAMES = [
  '', // index 0 unused — months are 1-indexed
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

export const CATALOG_CATEGORY_LABELS: Record<MaintenanceCatalogCategory, string> = {
  water_features:  'Water Features',
  heating_fuel:    'Heating & Fuel',
  outdoor_grounds: 'Outdoor & Grounds',
  systems:         'Systems',
  amenities:       'Amenities',
}

export interface OwnerTransaction {
  id:                   string
  property_id:          string
  org_id:               string
  transaction_type:     TxnType
  category:             TxnCategory
  amount:               number
  description:          string
  transaction_date:     string
  source:               string | null
  source_reference_id:  string | null
  visible_to_owner:     boolean
  work_order_id:        string | null
  purchase_order_id:    string | null
  booking_id:           string | null
  notes:                string | null
  created_at:           string
  updated_at:           string
}

export interface OrgMilestone {
  id:             string
  org_id:         string
  milestone:      string
  achieved_at:    string
  prompted_at:    string | null
  review_clicked: boolean
  dismissed:      boolean
  value:          Record<string, unknown> | null
}

export interface AuditEvent {
  id:          string
  org_id:      string | null
  actor_id:    string | null
  action:      string
  target_type: string | null
  target_id:   string | null
  metadata:    Record<string, unknown> | null
  ip_address:  string | null
  created_at:  string
}

export interface OrgInvite {
  id:          string
  org_id:      string
  invited_by:  string
  email:       string
  role:        string
  token:       string
  expires_at:  string
  accepted_at: string | null
  created_at:  string
}

export interface StripeProcessedEvent {
  stripe_event_id: string
  processed_at:    string
}

// ── Hospitable reservation conversation messages ────────────────────────────
export interface ReservationMessage {
  id:                      string
  org_id:                  string
  booking_id:              string | null
  external_reservation_id: string | null   // NULL for a pre-booking inquiry — 20260820163000
  external_source:         string
  conversation_id:         string | null
  platform:                string | null
  sender_type:             'host' | 'guest'
  sender_name:             string | null
  content_type:            string | null
  body:                    string | null   // NULL for an attachment-only message — 20260820061500
  attachments:             Record<string, unknown>[] | null
  source:                  string | null
  message_created_at:      string
  dedup_key:               string
  created_at:              string
}

// ── RepuGuard ────────────────────────────────────────────────────────────────
export interface Review {
  id:              string
  org_id:          string
  property_id:     string | null
  external_id:     string
  external_source: string
  guest_name:      string | null
  rating:          number
  review_text:     string
  review_date:     string | null
  response_status: string
  external_url:    string | null
  created_at:      string
  updated_at:      string
}

export interface ReviewResponse {
  id:                  string
  review_id:           string
  org_id:              string
  generated_response:  string | null
  edited_response:     string | null
  word_count:          number | null
  tone_used:           string | null
  flags:               string[]
  flag_reason:         string | null
  generated_at:        string | null
  regeneration_count:  number
  created_at:          string
  updated_at:          string
}

export interface QuoteRequest {
  id:                     string
  work_order_id:          string
  org_id:                 string
  vendor_id:              string
  status:                 QuoteRequestStatus
  quote_token:            string
  quote_token_expires_at: string
  quoted_amount:          number | null
  quote_notes:            string | null
  sent_at:                string
  submitted_at:           string | null
  created_at:             string
}

/**
 * A single priced line on a vendor's quote. Same shape as WorkOrderLineItem —
 * deliberately, because approve_quote_request() copies these rows straight into
 * work_order_line_items so the agreed scope becomes the work order's starting
 * line items.
 *
 * `line_total` is GENERATED ALWAYS AS (quantity * unit_cost) in the database.
 * Never name it in an insert or update payload: Postgres rejects the WHOLE
 * statement with 428C9, not just that column.
 */
export interface QuoteRequestLineItem {
  id:               string
  quote_request_id: string
  org_id:           string
  line_type:        LineItemType
  description:      string
  quantity:         number
  unit:             string | null
  unit_cost:        number
  line_total:       number
  sort_order:       number
  created_at:       string
}

export interface CommunicationLog {
  id:                string
  org_id:            string
  recipient_type:    CommRecipientType
  vendor_id:         string | null
  crew_member_id:    string | null
  channel:           CommChannel
  subject:           string | null
  body:              string | null
  property_id:       string | null
  work_order_id:     string | null
  source:            CommSource
  logged_by_user_id: string | null
  communicated_at:   string
  created_at:        string
  deleted_at:        string | null
  dedup_key:         string | null
}

export interface Message {
  id:            string
  org_id:        string
  sender_id:     string
  recipient_id:  string
  content:       string
  read_at:       string | null
  turnover_id:   string | null
  work_order_id: string | null
  group_id:      string | null
  group_label:   string | null
  created_at:    string
}

// ── Inventory template ───────────────────────────────────────────────────────
export interface InventoryTemplate {
  id:                          string
  org_id:                      string
  name:                        string
  description:                 string | null
  // NULL for an org's own custom templates. Set when the template originated
  // from a platform admin broadcast (20260727120000_platform_inventory_
  // templates.sql) — lets the broadcast Inngest function find every org
  // that already has a given platform template when pushing an update.
  source_platform_template_id: string | null
  created_at:                  string
}

// ── Platform-managed, broadcastable inventory template ──────────────────────
// e.g. "Standard FieldStay Inventory Template" (HD Supply purchasable items).
// See 20260727120000_platform_inventory_templates.sql.
export interface PlatformInventoryTemplate {
  id:          string
  name:        string
  description: string | null
  /** At most one row may be true — enforced by the partial unique index
   *  platform_inventory_templates_one_default, not by application code.
   *  Zero defaults is valid and means nothing is auto-applied. Repoint it
   *  through the set_default_platform_inventory_template RPC, never a direct
   *  UPDATE: see 20260811080000 for why a single-statement flip is
   *  scan-order dependent. */
  is_default:  boolean
  created_at:  string
  updated_at:  string
}

export interface PlatformInventoryTemplateItem {
  id:                             string
  platform_inventory_template_id: string
  catalog_item_id:                string
  par_level:                      number
  par_mode:                       ParMode
  smart_group:                    ParSmartGroup | null
  base_qty:                       number
  preferred_brand:                string | null
  sort_order:                     number
  created_at:                     string
}

// ── Inventory template item ──────────────────────────────────────────────────
export interface InventoryTemplateItem {
  id:              string
  template_id:     string
  catalog_item_id: string | null
  name:            string
  // category/unit are nullable at the DB level, but every write path
  // (app/(dashboard)/templates/inventory/actions.ts) always copies both
  // from the source catalog row, so a null in practice means a bug, not an
  // expected state.
  category:        InventoryCategory | null
  unit:            string | null
  par_level:       number
  par_mode:        ParMode
  smart_group:     ParSmartGroup | null
  base_qty:        number
  // Legacy column from the original 20260604223335_add_inventory_templates.sql
  // schema, superseded by par_level (added later) — never read or written
  // by current app code (see actions.ts's "par_qty (unused, see Pass 1/3
  // self-audit)" comment). No created_at column exists on this table.
  par_qty:         number
  sort_order:      number
  notes:           string | null
  preferred_brand: string | null
}

// Two disjoint subscriber shapes share this table: crew (crew_member_id set,
// user_id null — app/api/crew/push-subscribe/route.ts) and PM dashboard
// users (user_id set, crew_member_id null — app/api/dashboard/push-subscribe/route.ts).
export interface PushSubscription {
  id:             string
  crew_member_id: string | null
  user_id:        string | null
  org_id:         string
  endpoint:       string
  p256dh:         string
  auth:           string
  created_at:     string
}

// ─────────────────────────────────────────────────────────────
// Integration framework
//
// These three tables are SERVER-SIDE ONLY:
//   - integration_connections and oauth_states must NEVER be
//     synced to the client: keep them out of lib/dexie/schema.ts and
//     out of any crew/vendor pull in lib/dexie/sync/
//   - Token read/write/revoke functions are service_role only
// ─────────────────────────────────────────────────────────────

export interface IntegrationProvider {
  /** Stable slug identifier: 'ownerrez' | 'hostaway' | 'guesty' */
  id:           string
  display_name: string
  auth_type:    IntegrationAuthType
  is_active:    boolean
  created_at:   string
}

export interface IntegrationConnection {
  id:               string
  user_id:          string            // FK → auth.users.id
  org_id:           string | null     // FK → organizations.id — backfilled from organization_members
  provider_id:      string            // FK → integration_providers.id
  external_user_id: string | null     // Provider's own user/account identifier
  /** FK → vault.secrets.id — null when revoked (secret physically destroyed) */
  vault_secret_id:  string | null
  scope:            string | null
  status:           IntegrationStatus
  /** Non-sensitive provider metadata (display info, plan details, etc.) */
  metadata:         Record<string, unknown>
  connected_at:     string
  last_used_at:     string | null
  created_at:       string
  updated_at:       string
  /** FK → vault.secrets.id for the refresh token. NULL for non-expiring providers (e.g. OwnerRez). */
  refresh_token_vault_secret_id: string | null
  /** When the access token expires. NULL for non-expiring tokens. */
  expires_at:       string | null
  /** Set when a reconnect-required email was sent after a proactive refresh failure. Cleared on next successful token store. */
  reconnect_email_sent_at: string | null
  /**
   * Path segment of the per-connection inbound webhook URL
   * (/api/webhooks/<provider>/<token>). NULL for providers that use one shared
   * webhook endpoint. Currently Hostex only — see the migration's comment for
   * why a per-connection URL is the only sound tenant resolution there.
   */
  webhook_token: string | null
  /**
   * SHA-256 of the provider's per-connection webhook secret, captured on the
   * first inbound delivery (trust-on-first-use). NULL until then. Never the
   * plaintext secret — verification only ever compares.
   */
  webhook_secret_hash: string | null
}

export interface OAuthState {
  /** Random 64-char hex string used as CSRF protection token */
  state:       string
  /** null if user arrived unauthenticated (e.g. from OwnerRez marketplace) */
  user_id:     string | null
  provider_id: string
  /** Path to redirect to after successful connection */
  return_to:   string | null
  created_at:  string
  /** Expires after 10 minutes to match OwnerRez temporary code lifetime */
  expires_at:  string
}

export interface ProcessedWebhook {
  webhook_id:   string
  processed_at: string
}

/**
 * Maps a provider-side entity id to the FieldStay org that owns it —
 * memoizes resolveHospitableOwner()'s resolution (webhook payload's own
 * user id, local-table match, or token probe) so it never repeats for the
 * same entity. Service-role only: RLS is enabled with no permissive
 * policies (deliberate deny-all for anon/authenticated).
 */
export interface IntegrationEntityOwner {
  id:           string
  provider_id:  string
  entity_kind:  'reservation' | 'property' | 'review'
  external_id:  string
  org_id:       string
  resolved_via: 'webhook_user_id' | 'local' | 'probe'
  created_at:   string
  updated_at:   string
}

/**
 * LEGACY marketplace-install holding area (exchanged tokens). No longer
 * written to as of 2026-07-22 — replaced by PendingOAuthAuthorization, which
 * holds the UNEXCHANGED code instead so the provider never registers a
 * connection pre-signup. Table kept through the deploy window; drop in a
 * follow-up migration.
 */
export interface PendingIntegrationLink {
  id:                            string
  pending_link_token:            string
  provider_id:                   string
  external_user_id:              string
  vault_secret_id:                string
  refresh_token_vault_secret_id: string | null
  scope:                         string | null
  metadata:                      Record<string, unknown>
  /** 30-minute TTL from creation */
  expires_at:                    string
  created_at:                    string
}

/**
 * Marketplace-install holding area for UNEXCHANGED OAuth authorization codes.
 * The code→token exchange is deferred to /connect/finish (post-auth) — see
 * supabase/migrations/20260722120000_defer_marketplace_code_exchange.sql.
 */
export interface PendingOAuthAuthorization {
  id:                   string
  pending_link_token:   string
  provider_id:          string
  code_vault_secret_id: string
  /** The redirect_uri the authorization request was issued against — replayed on the deferred exchange */
  redirect_uri:         string
  /** 30-minute TTL from creation */
  expires_at:           string
  created_at:           string
}

// ── Self-Funding Guidebook ────────────────────────────────────────────────────

export interface GuidebookConfiguration {
  id:                    string
  org_id:                string
  is_active:             boolean
  grace_period_ends_at:  string | null
  trial_ends_at:         string | null
  extension_messaging_enabled:   boolean
  extension_gap_threshold_days:  number
  extension_discount_pct:        number | null
  // TEXT column (DEFAULT 'email'), not a Postgres enum — narrow it with
  // asExtensionContactMethod() from components/guidebook/guest-guidebook-view
  // at the point of use rather than asserting the union here.
  extension_contact_method:      string | null
  extension_ownerrez_url:        string | null
  extension_message_days_before: number
  created_at:            string
  updated_at:            string
}

export type StayExtensionRequestStatus = 'pending' | 'accepted' | 'declined'

export interface StayExtensionRequest {
  id:                   string
  org_id:               string
  booking_id:           string
  property_id:          string
  gap_days:             number
  discount_pct:         number | null
  next_booking_checkin: string | null
  status:               StayExtensionRequestStatus
  sms_sent_at:          string | null
  pm_notified_at:       string | null
  created_at:           string
  updated_at:           string
}

export type GuidebookSlotType =
  | 'morning_brew'
  | 'dinner_pints'
  | 'rainy_day'
  | 'outdoor_adventure'
  | 'general'
  | 'other'

export type GuidebookSponsorStatus = 'pending' | 'active' | 'payment_failed' | 'cancelled'

export type GuidebookOfferType = 'percentage' | 'fixed_amount' | 'item' | 'custom' | 'none'

export interface GuidebookSponsor {
  id:                     string
  org_id:                 string
  slot_number:            number
  business_name:          string
  business_description:   string | null
  business_phone:         string | null
  business_website:       string | null
  custom_offer_text:      string | null
  offer_type:             GuidebookOfferType
  offer_value:            number | null
  offer_item:             string | null
  featured_item:          string | null
  address:                string | null
  lat:                    number | null
  lng:                    number | null
  slot_type:              GuidebookSlotType
  slot_context:           string | null
  media_kit_token:        string
  photo_storage_path:     string | null
  stripe_customer_id:     string | null
  stripe_subscription_id: string | null
  checkout_session_id:    string | null
  status:                 GuidebookSponsorStatus
  activated_at:           string | null
  deactivated_at:         string | null
  created_at:             string
  updated_at:             string
}

/**
 * Which PROPERTIES an org-level sponsor appears on.
 *
 * `org_id` and `slot_type` are denormalised and DERIVED BY A DATABASE TRIGGER
 * from the sponsor row — never supplied by the caller, and a value written here
 * is overwritten. org_id is what RLS filters on (joining through
 * guidebook_sponsors in a policy would be a correlated subquery on every guest
 * page load); slot_type is what the partial unique index on
 * (property_id, slot_type) needs in order to enforce one sponsor per named
 * category per property.
 */
export interface GuidebookSponsorAssignment {
  id:          string
  org_id:      string
  sponsor_id:  string
  property_id: string
  slot_type:   GuidebookSlotType
  created_at:  string
}

export interface GuidebookPropertyConfig {
  id:                        string
  org_id:                    string
  property_id:               string
  slug:                      string
  check_in_instructions:     string | null
  check_out_instructions:    string | null
  wifi_network:              string | null
  wifi_password:             string | null
  house_rules:               string | null
  is_published:              boolean
  hero_photo_storage_path:   string | null
  // PM-selected amenities (up to 3) to feature in guest SMS nudges, plus a
  // guest-facing note per amenity, semicolon-separated and positionally
  // matched to featured_amenities. Falls back to the property's first synced
  // amenities when null/empty — see lib/guidebook/featured-amenities.ts.
  featured_amenities:        string[] | null
  featured_amenity_notes:    string | null
  created_at:                string
  updated_at:                string
}

export interface GuidebookOfferRedemption {
  id:         string
  org_id:     string
  sponsor_id: string
  booking_id: string | null
  opened_at:  string
  /**
   * Times the pass was opened for this (sponsor, booking, UTC day). The row
   * itself is deduped by uniq_guidebook_offer_redemptions_sponsor_booking_day,
   * so COUNT(*) is redemptions and SUM(open_count) is engagement — two numbers
   * a sponsor wants separately. NOT NULL DEFAULT 1 (20260807170000).
   */
  open_count: number
}

export interface GuidebookGuestSmsOptin {
  id:                    string
  org_id:                string
  property_id:           string
  booking_id:            string
  phone_e164:            string
  is_active:             boolean
  door_code_sent_at:     string | null
  last_morning_sms_date: string | null
  last_evening_sms_date: string | null
  opted_in_at:           string
  opted_out_at:          string | null
  created_at:            string
  updated_at:            string
}

// ── Asset Health ─────────────────────────────────────────────────────────────

export interface PropertyAsset {
  id:                         string
  org_id:                     string
  property_id:                string
  name:                       string
  asset_type:                 AssetType
  make:                       string | null
  model:                      string | null
  serial_number:              string | null
  installation_date:          string | null
  manufacture_date:           string | null
  purchase_price:             number | null
  estimated_replacement_cost: number | null
  expected_lifespan_years:    number | null
  warranty_expiry_date:       string | null
  warranty_provider:          string | null
  warranty_notes:             string | null
  placed_in_service_date:     string | null
  // NULLABLE in the live schema (DEFAULT '5_year'); asset_depreciation_entries
  // .macrs_class is the NOT NULL one.
  macrs_class:                MacrsClass | null
  // Both NULLABLE in the live schema, with DEFAULTs ('macrs', 0).
  depreciation_method:        string | null
  salvage_value:              number | null
  health_score:               number | null
  health_score_updated_at:    string | null
  replacement_status:         'projected' | 'budgeted' | 'approved' | 'deferred'
  is_active:                  boolean
  replaced_by_asset_id:       string | null
  /**
   * When this asset was actually replaced — the ground truth the RUL curve
   * needs to learn age-at-failure. Set once, by replace_property_asset() only
   * (20260814142502). Null on every asset still in service.
   */
  replaced_at:                string | null
  /**
   * "Warn once" gate for the warranty-expiry cron, mirroring
   * vendor_compliance_documents.first_warned_at. Null until the first warning.
   */
  warranty_warned_at:         string | null
  notes:                      string | null
  photo_url:                  string | null
  is_na:                      boolean
  verified_at:                string | null
  scan_status:                AssetScanStatus | null
  created_at:                 string
  updated_at:                 string
}

export type AssetScanStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface AssetManual {
  id:          string
  org_id:      string
  asset_type:  AssetType
  make:        string
  model:       string
  // NULL means a lookup was attempted and found nothing — still recorded so
  // repeated asset saves with the same make/model don't re-trigger a lookup.
  source_url:  string | null
  found_via:   'search' | null
  verified_at: string | null
  created_at:  string
  updated_at:  string
}

export interface AssetTypeStandard {
  asset_type:                AssetType
  display_name:              string
  lifespan_min_years:        number
  lifespan_max_years:        number
  avg_replacement_cost_low:  number | null
  avg_replacement_cost_high: number | null
  macrs_class_default:       MacrsClass
  vendor_specialty_default:  string | null
  notes:                     string | null
  age_weight:                number  // default 60, range 30-70
  condition_weight:          number  // default 40, range 30-70
  weight_updated_at:         string | null
  /**
   * Learned Weibull shape parameter, fit per asset type from real
   * age-at-replacement data (20260814142439). NULL until a fit job has enough
   * samples — health-score.ts falls back to the shared WEIBULL_SHAPE constant.
   * CHECK-bounded 1.0-8.0 so a fit off a tiny or noisy sample cannot push the
   * curve somewhere pathological.
   */
  weibull_shape:             number | null
  weibull_shape_updated_at:  string | null
}

// ── Asset Depreciation ────────────────────────────────────────────────────────

export interface AssetDepreciationEntry {
  id:                            string
  org_id:                        string
  asset_id:                      string
  tax_year:                      number
  macrs_class:                   MacrsClass
  cost_basis:                    number
  prior_cumulative_depreciation: number
  current_year_depreciation:     number
  ending_adjusted_basis:         number
  depreciation_rate:             number | null
  notes:                         string | null
  generated_at:                  string
}

// ── Asset Health History & Repair-vs-Replace ──────────────────────────────────

export interface AssetHealthScoreHistory {
  id:              string
  org_id:          string
  asset_id:        string
  recorded_date:   string
  health_score:    number
  age_score:       number
  condition_score: number
  created_at:      string
}

export interface AssetCapexRecommendation {
  id:                        string
  org_id:                    string
  asset_id:                  string
  property_id:               string
  recommendation:            'monitor' | 'repair' | 'replace'
  repair_cost_trailing_12mo: number
  repair_cost_prior_12mo:    number
  repair_trend_pct:          number | null
  replacement_cost_estimate: number
  remaining_book_value:      number | null
  reasoning:                 string[]
  notified_at:               string | null
  computed_at:               string
  created_at:                string
  updated_at:                string
}

// ── Vendor Compliance ─────────────────────────────────────────────────────────

export interface VendorComplianceDocument {
  id:                 string
  org_id:             string
  vendor_id:          string
  document_type:      ComplianceDocType
  document_name:      string
  policy_number:      string | null
  issuer_name:        string | null
  effective_date:     string | null
  expiry_date:        string | null
  coverage_amount:    number | null
  document_url:       string | null
  is_verified:        boolean
  verification_notes: string | null
  first_warned_at:    string | null
  hard_blocked_at:    string | null
  is_active:          boolean
  created_at:         string
  updated_at:         string
}

export interface VendorComplianceStatus {
  vendor_id:            string
  org_id:               string
  vendor_name:          string
  lat:                  number | null
  lng:                  number | null
  service_zip:          string | null
  service_radius_miles: number | null
  active_doc_count:     number
  expired_doc_count:    number
  expiring_soon_count:  number
  days_past_expiry:     number | null
  compliance_status:    ComplianceStatus
}

// ── Support Bot ───────────────────────────────────────────────────────────────

export interface SupportKbChunk {
  id:         string
  title:      string
  content:    string
  embedding:  unknown | null
  source:     string | null
  created_at: string
  updated_at: string
}

export interface SupportConversation {
  id:                 string
  org_id:             string
  user_id:            string
  status:             string
  needs_human:        boolean
  escalation_reason:  string | null
  escalated_at:       string | null
  resolved_at:        string | null
  assigned_staff_id:  string | null
  staff_notified_at:  string | null
  created_at:         string
  last_message_at:    string
}

export interface SupportMessage {
  id:               string
  conversation_id:  string
  role:             SupportMessageRole
  content:          string
  category:         SupportCategory | null
  model_used:       string | null
  // Set only for role='human' (a platform staff reply via
  // app/api/support-inbox/reply/route.ts) — null for bot/guest messages.
  sent_by_user_id:  string | null
  created_at:       string
}

// ── In-app notifications (bell) ─────────────────────────────────────────────
export interface Notification {
  id:         string
  org_id:     string
  type:       string
  title:      string
  subtitle:   string | null
  href:       string
  severity:   'red' | 'amber' | 'green' | 'blue'
  dedupe_key: string | null
  read_at:    string | null
  created_at: string
}

// ── Daily wrap-up digest diff/stay-static tracking ──────────────────────────
export interface NotificationDigestState {
  org_id:     string
  category:   string
  snapshot:   Record<string, unknown>
  updated_at: string
}

// ── Roadshow demo activity log ──────────────────────────────────────────────
// Append-only record of side effects simulated for a demo org instead of
// dispatched to a real provider (20260726160000_demo_org_support.sql).
// Service-role writes only; org members have SELECT via RLS.
export type DemoSideEffectKind =
  | 'sms'
  | 'email'
  | 'stripe_payout_simulated'

export interface DemoActivityLog {
  id:           string
  org_id:       string
  kind:         DemoSideEffectKind
  payload:      Record<string, unknown>
  simulated_at: string
}

// ── Org-level SMS template overrides ────────────────────────────────────────
// Per-org customization of the default guest SMS copy in lib/sms/templates.ts.
// UNIQUE(org_id, key) — an org may override any subset of template keys;
// resetOrgSmsTemplate() deletes the row to fall back to the built-in default.
export interface OrgSmsTemplate {
  id:         string
  org_id:     string
  key:        string
  body:       string
  created_at: string
  updated_at: string
}

// ── Hospitable launch promo (two-tier price lock) ───────────────────────────
// See supabase/migrations/20260727150000_hospitable_launch_promo.sql. All
// writes go through the SECURITY DEFINER tag/claim functions (service_role
// only); org members can only SELECT their own org's row for the badge.
export interface HospitableLaunchPromo {
  org_id:                  string
  hospitable_tagged:       boolean
  hospitable_tagged_at:    string | null
  attribution_source:      string | null   // 'hospitable_marketplace_oneclick' | 'hospitable_landing_page' | 'manual_connect'
  converted_to_paid_at:    string | null
  price_lock_awarded:      boolean
  price_lock_active:       boolean
  price_lock_sequence:     number | null   // 1-100, tier-1 locks only; NULL for tier 2
  price_lock_years:        1 | 2 | null
  price_lock_tier:         string | null
  price_lock_amount_cents: number | null
  awarded_at:              string | null
  price_lock_expires_at:   string | null
  congrats_email_sent_at:  string | null
  created_at:              string
  updated_at:              string
}

// Singleton counter (id always 1) — service-role-only, mutated exclusively by
// claim_hospitable_promo_slot(). launch_at + second_tier_window_days gate
// tier 2; extend the window by updating second_tier_window_days in place.
export interface PromoHospitableLaunchCounter {
  id:                        number
  first_tier_awarded_count:  number
  first_tier_max:            number
  second_tier_awarded_count: number
  second_tier_max:           number
  launch_at:                 string
  second_tier_window_days:   number
}

// ─────────────────────────────────────────────────────────────
// Supabase Database interface — used by createClient()
//
// NOTE: Hand-written interfaces lack the index signatures required
// by postgrest-js v2's GenericSchema constraint. The <Database>
// type arg is omitted in lib/supabase/server.ts so .from() queries
// default to `any`. Replace with CLI-generated types once connected:
//   npx supabase gen types typescript --linked > types/database.ts
// ─────────────────────────────────────────────────────────────

/**
 * The schema type postgrest-js binds to. Re-exported from the GENERATED file,
 * which is the only version satisfying its GenericSchema constraint — the
 * hand-written interface that used to live here did not, which is why
 * lib/supabase/server.ts had to omit the <Database> generic and every query in
 * the app was typed `any`.
 *
 * The named interfaces above are NOT generated and stay hand-written on
 * purpose: they were diffed against the live schema when this landed and are
 * accurate. The only differences were two PostgREST embed aliases (which are
 * not columns) and the deliberately-omitted deprecated
 * work_orders.assigned_crew_id. They remain the app's import surface, and
 * scripts/check-type-drift.mjs keeps them honest against the live schema.
 */

/**
 * table name -> the hand-written Row interface that models it.
 *
 * PARSED BY scripts/check-type-drift.mjs. This is not decoration and it is not
 * used at runtime: the drift gate reads this map to know which interface to
 * diff against which live table, in BOTH directions — a table with no entry is
 * reported as unmodelled, and an entry naming a table that no longer exists is
 * reported as stale.
 *
 * It exists as its own declaration because the mapping used to be a side
 * effect of the hand-written `Database.public.Tables` block. When Database
 * moved to the generated file (2026-08-02) that block went with it, and the
 * drift gate — which greps for `Tables: { ... } Views:` — silently matched
 * nothing and reported all 92 tables as unmodelled. Pointing the gate at the
 * generated file instead would have been worse than useless: that file is
 * generated FROM the live schema, so diffing the two can never fail.
 *
 * The hand-written interfaces are what can drift, so they are what is checked.
 * Add an entry in the same commit that adds a table + its interface.
 */
export interface HandWrittenRowMap {
  profiles:                            Profile
  organizations:                       Organization
  organization_members:                OrganizationMember
  properties:                          Property
  property_owners:                     PropertyOwner
  owner_portal_tokens:                 OwnerPortalToken
  ical_feeds:                          IcalFeed
  bookings:                            Booking
  crew_members:                        CrewMember
  crew_availability:                   CrewAvailability
  vendors:                             Vendor
  checklist_templates:                 ChecklistTemplate
  checklist_template_sections:         ChecklistTemplateSection
  checklist_template_items:            ChecklistTemplateItem
  room_templates:                      RoomTemplate
  room_template_items:                 RoomTemplateItem
  org_inventory_catalog:               OrgInventoryCatalogItem
  org_maintenance_catalog_items:       OrgMaintenanceCatalogItem
  platform_staff:                      PlatformStaff
  platform_seed_room_templates:        PlatformSeedRoomTemplate
  platform_seed_room_template_items:   PlatformSeedRoomTemplateItem
  turnovers:                           Turnover
  turnover_assignments:                TurnoverAssignment
  checklist_instances:                 ChecklistInstance
  checklist_instance_items:            ChecklistInstanceItem
  inventory_catalog:                   InventoryCatalogItem
  inventory_items:                     InventoryItem
  inventory_consumption_stats:         InventoryConsumptionStats
  inventory_counts:                    InventoryCount
  inventory_count_items:               InventoryCountItem
  purchase_orders:                     PurchaseOrder
  purchase_order_items:                PurchaseOrderItem
  work_orders:                         WorkOrder
  work_order_line_items:               WorkOrderLineItem
  work_order_updates:                  WorkOrderUpdate
  work_order_photos:                   WorkOrderPhoto
  maintenance_schedules:               MaintenanceSchedule
  maintenance_schedule_templates:      MaintenanceScheduleTemplate
  maintenance_schedule_template_items: MaintenanceScheduleTemplateItem
  owner_transactions:                  OwnerTransaction
  org_milestones:                      OrgMilestone
  audit_events:                        AuditEvent
  stripe_processed_events:             StripeProcessedEvent
  org_invites:                         OrgInvite
  quote_requests:                      QuoteRequest
  quote_request_line_items:            QuoteRequestLineItem
  communication_logs:                  CommunicationLog
  messages:                            Message
  push_subscriptions:                  PushSubscription
  org_sms_templates:                   OrgSmsTemplate
  assignment_outcomes:                 AssignmentOutcome
  vendor_assignment_outcomes:          VendorAssignmentOutcome
  crew_feedback:                       CrewFeedback
  crew_sync_incidents:                 CrewSyncIncident
  checklist_item_signals:              ChecklistItemSignal
  inventory_templates:                 InventoryTemplate
  inventory_template_items:            InventoryTemplateItem
  platform_inventory_templates:        PlatformInventoryTemplate
  platform_inventory_template_items:   PlatformInventoryTemplateItem
  maintenance_catalog_items:           MaintenanceCatalogItem
  maintenance_completions:             MaintenanceCompletion
  work_order_invoices:                 WorkOrderInvoice
  reservation_messages:                ReservationMessage
  reviews:                             Review
  review_responses:                    ReviewResponse
  property_assets:                     PropertyAsset
  asset_type_standards:                AssetTypeStandard
  asset_depreciation_entries:          AssetDepreciationEntry
  asset_health_score_history:          AssetHealthScoreHistory
  asset_capex_recommendations:         AssetCapexRecommendation
  asset_manuals:                       AssetManual
  vendor_compliance_documents:         VendorComplianceDocument
  integration_providers:               IntegrationProvider
  integration_connections:             IntegrationConnection
  oauth_states:                        OAuthState
  processed_webhooks:                  ProcessedWebhook
  integration_entity_owners:           IntegrationEntityOwner
  pending_integration_links:           PendingIntegrationLink
  pending_oauth_authorizations:        PendingOAuthAuthorization
  support_kb_chunks:                   SupportKbChunk
  support_conversations:               SupportConversation
  support_messages:                    SupportMessage
  guidebook_configurations:            GuidebookConfiguration
  guidebook_sponsors:                  GuidebookSponsor
  guidebook_property_configs:          GuidebookPropertyConfig
  guidebook_guest_sms_optins:          GuidebookGuestSmsOptin
  guidebook_offer_redemptions:         GuidebookOfferRedemption
  stay_extension_requests:             StayExtensionRequest
  notifications:                       Notification
  notification_digest_state:           NotificationDigestState
  demo_activity_log:                   DemoActivityLog
  hospitable_launch_promo:             HospitableLaunchPromo
  promo_hospitable_launch_counter:     PromoHospitableLaunchCounter
  inspection_forms:                    InspectionForm
  inspection_form_sections:            InspectionFormSection
  inspection_form_items:               InspectionFormItem
  inspections:                         Inspection
  inspection_items:                    InspectionItem
}

/** Views modelled by hand, same contract as HandWrittenRowMap. */
export interface HandWrittenViewMap {
  vendor_compliance_status: VendorComplianceStatus
}

export type { Database } from './database.generated'

/**
 * Row / payload helpers from the generated schema, re-exported so callers get
 * them from the same place as everything else.
 *
 * Use `TablesInsert<'x'>` for an insert payload instead of hand-writing the
 * shape. A hand-written payload annotation silently WIDENS what the column
 * actually accepts — `category: string` where the column is the
 * inventory_category enum — and once widened, nothing checks the value again.
 * That is why several payload types in this repo did not match their table.
 */
export type { Tables, TablesInsert, TablesUpdate, Enums } from './database.generated'

/**
 * Runtime enum values, generated from the live schema. Use this to validate a
 * value that arrives as a plain `string` before writing it to an enum column,
 * rather than hand-listing the labels — a hand-written list is a second copy
 * of the schema that nothing keeps in sync.
 */
export { Constants } from './database.generated'


// ── Inspections & Audits ────────────────────────────────────────────────────
// docs/INSPECTIONS_SPEC.md. Phase 1 is schema + immutability; the seed, the
// tablet UI and remediation are phases 2–4.

/** PLATFORM-owned form definition. No org_id — orgs cannot edit these. */
export interface InspectionForm {
  id:          string
  key:         string          // 'safety' | 'indoor' | 'outdoor'
  name:        string
  description: string | null
  version:     number
  is_active:   boolean
  created_at:  string
  updated_at:  string
}

export interface InspectionFormSection {
  id:         string
  form_id:    string
  key:        string
  name:       string
  sort_order: number
  created_at: string
  /**
   * Render this section only where the property has an ACTIVE property_assets
   * row of this type — Outdoor's well section. Ledger-backed, so the skip is
   * not something the inspector asserts (§12.3).
   */
  shown_when_asset:          AssetType | null
}

/**
 * A property-level fact an inspection item can be gated on.
 *
 * A closed union rather than a free string, matching the DB CHECK: there is one
 * fact today, and a gate that can name anything is a gate nobody can audit on a
 * form whose entire value is being auditable.
 */
export type PropertyFactKey = 'has_security_system'

export interface InspectionFormItem {
  id:         string
  section_id: string
  /** STABLE across re-seeds ('safety.fire.smoke_present'); the row id is not. */
  key:        string
  prompt:     string
  sort_order: number

  response_type:  InspectionResponseType
  is_required:    boolean
  photo_required: boolean

  /** Shown only when the parent answers `show_when`. */
  parent_item_id: string | null
  show_when:      InspectionResult | null

  /** Render one row per unit counted at that item (N extinguishers → N groups). */
  repeat_source_item_id: string | null
  /**
   * THE GENERIC SWEEP: one row per ACTIVE property_assets row of any type no
   * named item claims. Carries no `asset_type` and no `concern_key` — the
   * subject is whatever the ledger holds, so a static key would merge a dead
   * refrigerator with a dead generator.
   */
  repeat_per_asset:      boolean
  /**
   * One row per ACTIVE property_assets row matching THIS item's `asset_type`
   * (20260823021731). A DB CHECK requires `asset_type`, and another forbids
   * setting this and `repeat_per_asset` together — they are different rules.
   *
   * ⚠️ Remediation must dedup a per_unit answer on (concern_key, asset_id),
   * never concern_key alone: two dryers with blocked vents are two jobs.
   */
  per_unit:              boolean

  na_reason_template: string | null
  /** Verify an N/A claim against the asset ledger rather than taking it on trust. */
  na_asset_type:      AssetType | null
  asset_type:         AssetType | null

  /**
   * Same physical concern ACROSS forms — and, for well short-cycling, across
   * items within one form. NARROWER than asset_type on purpose: a due HVAC
   * filter and a fouled condenser are one asset and two jobs.
   */
  concern_key: string | null

  /**
   * ASK-ONCE CAPTURE: renders only while this property fact is NULL, and its
   * answer sets the fact. Mutually exclusive with the gate below (DB CHECK) —
   * an item shown only when a fact is unknown AND only when it is true can
   * never render at all.
   */
  asks_property_fact:       PropertyFactKey | null
  /**
   * RECURRING CONDITION: renders only where the fact is TRUE. Deliberately does
   * not drop off — a monitoring contract lapses far more often than a panel is
   * removed, so the condition has to be re-asked even though the presence
   * question does not.
   */
  shown_when_property_fact: PropertyFactKey | null

  /**
   * What KIND of record a failure here can produce at all. 'notify' and 'none'
   * never dispatch anyone — a lapsed permit is not a work order.
   *
   * Distinct from `default_actions`, and neither derives from the other: dryer
   * vent (Service) and exit doors (Repair) are both 'work_order'.
   */
  remediation:        InspectionRemediation
  /**
   * Pre-ticked action chips on a FAIL — our judgment about what the item
   * usually means, so the common case is one tap. Not a constraint. An ARRAY
   * because a water heater at end of life defaults to Replace AND Service: the
   * purchase and the install. Empty for notify/none items (CHECK-enforced).
   */
  default_actions:    InspectionAction[]
  wo_category:        WoCategory | null
  wo_priority:        PriorityLevel | null
  po_catalog_item_id: string | null
  po_default_qty:     number | null

  created_at: string
}

/** ONE performance of a form, against one property. Never batched. */
export interface Inspection {
  id:          string
  org_id:      string
  property_id: string

  form_id:      string
  form_version: number
  /** The form AS IT WAS — a re-seed must not rewrite what a past report asked. */
  form_snapshot:   Json
  /** The letterhead AS IT WAS: property, management company, org owner, weather. */
  header_snapshot: Json | null

  assigned_to_user_id: string | null
  /**
   * Who PHYSICALLY walked the property, typed at sign-off. Free text because
   * whoever the PM hands the tablet to counts, account or not — distinct from
   * completed_by_user_id, and the two may legitimately disagree.
   */
  inspector_name: string | null

  scheduled_for:        string | null
  started_at:           string
  /**
   * Whether `started_at` is a server clock or a device clock corrected by the
   * skew measured at sync (20260823053931).
   *
   * An inspection can be STARTED offline, so the start time is not always the
   * server's. Recorded rather than hidden, the same way ConditionsSnapshot
   * carries `source: 'recorded' | 'reported'` — a duration that was
   * device-timed is a different claim from one that was not, and printing them
   * identically launders the weaker one.
   */
  started_at_source:    'server' | 'device'
  /** The raw device claim, uncorrected. NOT NULL whenever source is 'device'. */
  device_started_at:    string | null
  /** server_now − device_now, measured in the request that carried the start. */
  device_clock_offset_seconds: number | null
  completed_at:         string | null
  completed_by_user_id: string | null

  source_schedule_id:     string | null
  /** Corrections are a NEW inspection referencing the original, never an edit. */
  corrects_inspection_id: string | null

  created_at: string
  updated_at: string
}

/** ONE answer. Immutable once its inspection is completed — enforced by trigger. */
export interface InspectionItem {
  id:            string
  inspection_id: string
  org_id:        string

  form_item_id:    string
  prompt_snapshot: string

  /** The answer for a `yes_no` item. NULL for the four other response types. */
  result:  InspectionResult | null

  /**
   * The answer for a count / text / date item (20260823001839).
   *
   * Three columns rather than one reused `note`, because `note` is the FAILURE
   * DESCRIPTION and becomes the work order's title — a location answer stored
   * there would generate work orders called "Kitchen, under sink". And
   * `value_number` is structural, not decorative: it sizes the repeat group
   * hanging off a count item, so parsing it back out of prose would make the
   * number of questions asked depend on text parsing.
   */
  value_number: number | null
  value_text:   string | null
  /** ISO `YYYY-MM-DD` — a real `date` column, not a timestamp. */
  value_date:   string | null

  /** Empty on a pass; non-empty is what generates the WO/PO. */
  actions: InspectionAction[]
  /** Independent of `actions` — rolls up into ONE crew cleaning job at sign-off. */
  needs_cleaning: boolean

  note:       string | null
  photo_path: string | null
  /** The only way past a photo_required item; free text so it cannot be tapped through. */
  photo_unavailable_reason: string | null
  na_reason:  string | null

  asset_id:     string | null
  repeat_index: number | null

  /**
   * The repeat visit (§6, 20260823180719).
   *
   * When this finding failed and an open work order already existed for the
   * same concern, the inspector was shown it and asked. NULL means they were
   * never asked — no open predecessor, or the device had no cached work orders
   * — and remediation falls back to creating a work order.
   *
   * `repeat_of_work_order_id` is retained for BOTH answers: "new" records what
   * this finding was distinguished FROM. It can be NULL alongside a non-null
   * `repeat_answer` if that work order was later deleted (ON DELETE SET NULL),
   * which remediation treats as "the predecessor is gone".
   */
  repeat_answer:           InspectionRepeatAnswer | null
  repeat_of_work_order_id: string | null

  answered_at: string | null
  created_at:  string
  updated_at:  string
}
