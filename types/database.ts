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

// ─────────────────────────────────────────────────────────────
// Scalar union types — mirror Postgres enums and CHECK constraints
// ─────────────────────────────────────────────────────────────

export type OrgPlan             = 'starter' | 'growth' | 'pro' | 'portfolio' | 'enterprise'
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
export type PoStatus            = 'draft' | 'sent' | 'acknowledged' | 'ordered' | 'received' | 'cancelled'
export type VendorSpecialty     = 'plumbing' | 'electrical' | 'hvac' | 'landscaping' | 'cleaning' | 'pest_control' | 'pool' | 'roofing' | 'general' | 'other'
export type WoStatus            = 'pending' | 'quote_requested' | 'assigned' | 'in_progress' | 'completed' | 'cancelled'
export type WoSource            = 'manual' | 'maintenance_schedule' | 'crew_flag' | 'guest_report' | 'vacancy_gap_suggestion'
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
  vendor_auto_assign_mode:      VendorAutoAssignMode
  comms_log_retention_days:     number
  guest_pii_retention_days:     number
  slack_webhook_url:            string | null
  repuguard_status:             'inactive' | 'trial' | 'active' | 'cancelled'
  repuguard_trial_start:        string | null
  repuguard_trial_end:          string | null
  repuguard_stripe_subscription_id: string | null
  repuguard_founding_member:    boolean
  /**
   * Roadshow demo tenant marker (20260726160000_demo_org_support.sql).
   * NOT an RLS bypass — the demo org is an ordinary tenant. Gates
   * guest/vendor-facing side effects into demo_activity_log and scopes the
   * one-tap reset. NOT NULL DEFAULT false, so non-null here.
   */
  is_demo:                      boolean
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
  external_id:             string | null
  external_source:         string | null
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
  stripe_connect_charges_enabled: boolean
  stripe_connect_onboarded_at:    string | null
  stripe_connect_invite_sent_at:  string | null
  stripe_connect_invite_claimed_at: string | null
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
  description:               string | null
  is_active:                 boolean
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
  description:       string | null
  is_active:         boolean
  created_at:        string
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
  current_quantity:        number
  low_stock_threshold_pct: number
  is_active:               boolean
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

// Field names match the live schema (submitted_by, item_id, counted_qty) —
// not the never-applied crew_member_id/submitted_at/inventory_item_id/
// submitted_quantity names from the superseded schema_history_gaps
// migrations (20260609000003/20260609111810), whose CREATE TABLE IF NOT
// EXISTS no-op'd against the table 20260604223326_add_inventory_count_drafts.sql
// had already created. reviewed_at/reviewed_by were added for real by
// 20260725201500_add_reviewed_columns_to_inventory_count_drafts.sql, after
// the drift check caught app/(dashboard)/inventory/actions.ts writing to
// them against columns that didn't exist yet.
export interface InventoryCountDraft {
  id:           string
  org_id:       string
  property_id:  string
  submitted_by: string | null
  status:       'pending_review' | 'approved' | 'rejected'
  reviewed_at:  string | null
  reviewed_by:  string | null
  notes:        string | null
  created_at:   string
  updated_at:   string
}

export interface InventoryCountDraftItem {
  id:                string
  draft_id:          string
  item_id:           string
  previous_quantity: number
  counted_qty:       number
  // `note` (singular) is a legacy duplicate column nobody writes or reads —
  // app/api/crew/inventory-count/route.ts and app/(dashboard)/inventory/
  // page.tsx both use `notes` (plural) exclusively. Kept here only so the
  // interface doesn't silently drop a real live column (see CLAUDE.md's
  // "Two inventory tables with different column names" section).
  note:              string | null
  notes:             string | null
}

export interface PurchaseOrder {
  id:                   string
  property_id:          string
  org_id:               string
  status:               PoStatus
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

export type InvoiceStatus = 'pending_payment' | 'paid' | 'cancelled'

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
  month_due:                 number | null
  day_of_month_due:          number | null
  estimated_cost:            number | null
  instructions:              string | null
  auto_create_wo:            boolean
  last_completed_date:       string | null
  next_due_date:             string | null
  active_from_month:         number | null
  active_to_month:           number | null
  asset_category:            string | null
  is_from_standard_template: boolean
  source_template_item_id:   string | null
  source_catalog_item_id:    string | null
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
  external_reservation_id: string
  external_source:         string
  conversation_id:         string | null
  platform:                string | null
  sender_type:             'host' | 'guest'
  sender_name:             string | null
  content_type:            string | null
  body:                    string
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
  created_at:  string
  updated_at:  string
}

export interface PlatformInventoryTemplateItem {
  id:                             string
  platform_inventory_template_id: string
  catalog_item_id:                string
  par_level:                      number
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
  extension_contact_method:      'ownerrez_url' | 'email' | 'sms' | null
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
  macrs_class:                MacrsClass
  depreciation_method:        string
  salvage_value:              number
  health_score:               number | null
  health_score_updated_at:    string | null
  replacement_status:         'projected' | 'budgeted' | 'approved' | 'deferred'
  is_active:                  boolean
  replaced_by_asset_id:       string | null
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

export interface Database {
  public: {
    Tables: {
      // ── Core platform ──────────────────────────────────────
      profiles:                    { Row: Profile;                  Insert: Partial<Profile>;                  Update: Partial<Profile>;                  Relationships: [] }
      organizations:               { Row: Organization;             Insert: Partial<Organization>;             Update: Partial<Organization>;             Relationships: [] }
      organization_members:        { Row: OrganizationMember;       Insert: Partial<OrganizationMember>;       Update: Partial<OrganizationMember>;       Relationships: [] }
      properties:                  { Row: Property;                 Insert: Partial<Property>;                 Update: Partial<Property>;                 Relationships: [] }
      property_owners:             { Row: PropertyOwner;            Insert: Partial<PropertyOwner>;            Update: Partial<PropertyOwner>;            Relationships: [] }
      owner_portal_tokens:         { Row: OwnerPortalToken;         Insert: Partial<OwnerPortalToken>;         Update: Partial<OwnerPortalToken>;         Relationships: [] }
      ical_feeds:                  { Row: IcalFeed;                 Insert: Partial<IcalFeed>;                 Update: Partial<IcalFeed>;                 Relationships: [] }
      bookings:                    { Row: Booking;                  Insert: Partial<Booking>;                  Update: Partial<Booking>;                  Relationships: [] }
      crew_members:                { Row: CrewMember;               Insert: Partial<CrewMember>;               Update: Partial<CrewMember>;               Relationships: [] }
      crew_availability:           { Row: CrewAvailability;         Insert: Partial<CrewAvailability>;         Update: Partial<CrewAvailability>;         Relationships: [] }
      vendors:                     { Row: Vendor;                   Insert: Partial<Vendor>;                   Update: Partial<Vendor>;                   Relationships: [] }
      checklist_templates:         { Row: ChecklistTemplate;        Insert: Partial<ChecklistTemplate>;        Update: Partial<ChecklistTemplate>;        Relationships: [] }
      checklist_template_sections: { Row: ChecklistTemplateSection; Insert: Partial<ChecklistTemplateSection>; Update: Partial<ChecklistTemplateSection>; Relationships: [] }
      checklist_template_items:    { Row: ChecklistTemplateItem;    Insert: Partial<ChecklistTemplateItem>;    Update: Partial<ChecklistTemplateItem>;    Relationships: [] }
      room_templates:              { Row: RoomTemplate;             Insert: Partial<RoomTemplate>;             Update: Partial<RoomTemplate>;             Relationships: [] }
      room_template_items:         { Row: RoomTemplateItem;         Insert: Partial<RoomTemplateItem>;         Update: Partial<RoomTemplateItem>;         Relationships: [] }
      org_inventory_catalog:       { Row: OrgInventoryCatalogItem;  Insert: Partial<OrgInventoryCatalogItem>;  Update: Partial<OrgInventoryCatalogItem>;  Relationships: [] }
      org_maintenance_catalog_items: { Row: OrgMaintenanceCatalogItem; Insert: Partial<OrgMaintenanceCatalogItem>; Update: Partial<OrgMaintenanceCatalogItem>; Relationships: [] }
      platform_staff:                      { Row: PlatformStaff;                 Insert: Partial<PlatformStaff>;                 Update: Partial<PlatformStaff>;                 Relationships: [] }
      platform_seed_room_templates:       { Row: PlatformSeedRoomTemplate;      Insert: Partial<PlatformSeedRoomTemplate>;      Update: Partial<PlatformSeedRoomTemplate>;      Relationships: [] }
      platform_seed_room_template_items:  { Row: PlatformSeedRoomTemplateItem;  Insert: Partial<PlatformSeedRoomTemplateItem>;  Update: Partial<PlatformSeedRoomTemplateItem>;  Relationships: [] }
      turnovers:                   { Row: Turnover;                 Insert: Partial<Turnover>;                 Update: Partial<Turnover>;                 Relationships: [] }
      turnover_assignments:        { Row: TurnoverAssignment;       Insert: Partial<TurnoverAssignment>;       Update: Partial<TurnoverAssignment>;       Relationships: [] }
      checklist_instances:         { Row: ChecklistInstance;        Insert: Partial<ChecklistInstance>;        Update: Partial<ChecklistInstance>;        Relationships: [] }
      checklist_instance_items:    { Row: ChecklistInstanceItem;    Insert: Partial<ChecklistInstanceItem>;    Update: Partial<ChecklistInstanceItem>;    Relationships: [] }
      inventory_catalog:           { Row: InventoryCatalogItem;     Insert: Partial<InventoryCatalogItem>;     Update: Partial<InventoryCatalogItem>;     Relationships: [] }
      inventory_items:             { Row: InventoryItem;            Insert: Partial<InventoryItem>;            Update: Partial<InventoryItem>;            Relationships: [] }
      inventory_counts:            { Row: InventoryCount;           Insert: Partial<InventoryCount>;           Update: Partial<InventoryCount>;           Relationships: [] }
      inventory_count_items:       { Row: InventoryCountItem;       Insert: Partial<InventoryCountItem>;       Update: Partial<InventoryCountItem>;       Relationships: [] }
      inventory_count_drafts:      { Row: InventoryCountDraft;      Insert: Partial<InventoryCountDraft>;      Update: Partial<InventoryCountDraft>;      Relationships: [] }
      inventory_count_draft_items: { Row: InventoryCountDraftItem;  Insert: Partial<InventoryCountDraftItem>;  Update: Partial<InventoryCountDraftItem>;  Relationships: [] }
      purchase_orders:             { Row: PurchaseOrder;            Insert: Partial<PurchaseOrder>;            Update: Partial<PurchaseOrder>;            Relationships: [] }
      purchase_order_items:        { Row: PurchaseOrderItem;        Insert: Partial<PurchaseOrderItem>;        Update: Partial<PurchaseOrderItem>;        Relationships: [] }
      work_orders:                 { Row: WorkOrder;                Insert: Partial<WorkOrder>;                Update: Partial<WorkOrder>;                Relationships: [] }
      work_order_line_items:       { Row: WorkOrderLineItem;        Insert: Partial<WorkOrderLineItem>;        Update: Partial<WorkOrderLineItem>;        Relationships: [] }
      work_order_updates:          { Row: WorkOrderUpdate;          Insert: Partial<WorkOrderUpdate>;          Update: Partial<WorkOrderUpdate>;          Relationships: [] }
      work_order_photos:           { Row: WorkOrderPhoto;           Insert: Partial<WorkOrderPhoto>;           Update: Partial<WorkOrderPhoto>;           Relationships: [] }
      maintenance_schedules:       { Row: MaintenanceSchedule;      Insert: Partial<MaintenanceSchedule>;      Update: Partial<MaintenanceSchedule>;      Relationships: [] }
      maintenance_schedule_templates:      { Row: MaintenanceScheduleTemplate;      Insert: Partial<MaintenanceScheduleTemplate>;      Update: Partial<MaintenanceScheduleTemplate>;      Relationships: [] }
      maintenance_schedule_template_items: { Row: MaintenanceScheduleTemplateItem;  Insert: Partial<MaintenanceScheduleTemplateItem>;  Update: Partial<MaintenanceScheduleTemplateItem>;  Relationships: [] }
      owner_transactions:          { Row: OwnerTransaction;         Insert: Partial<OwnerTransaction>;         Update: Partial<OwnerTransaction>;         Relationships: [] }
      org_milestones:              { Row: OrgMilestone;             Insert: Partial<OrgMilestone>;             Update: Partial<OrgMilestone>;             Relationships: [] }
      audit_events:                { Row: AuditEvent;               Insert: Partial<AuditEvent>;               Update: Partial<AuditEvent>;               Relationships: [] }
      stripe_processed_events:     { Row: StripeProcessedEvent;     Insert: Partial<StripeProcessedEvent>;     Update: Partial<StripeProcessedEvent>;     Relationships: [] }
      org_invites:                 { Row: OrgInvite;                Insert: Partial<OrgInvite>;                Update: Partial<OrgInvite>;                Relationships: [] }
      quote_requests:              { Row: QuoteRequest;             Insert: Partial<QuoteRequest>;             Update: Partial<QuoteRequest>;             Relationships: [] }
      communication_logs:          { Row: CommunicationLog;              Insert: Partial<CommunicationLog>;              Update: Partial<CommunicationLog>;              Relationships: [] }
      messages:                    { Row: Message;                       Insert: Partial<Message>;                       Update: Partial<Message>;                       Relationships: [] }
      push_subscriptions:          { Row: PushSubscription;              Insert: Partial<PushSubscription>;              Update: Partial<PushSubscription>;              Relationships: [] }
      org_sms_templates:           { Row: OrgSmsTemplate;                Insert: Partial<OrgSmsTemplate>;                Update: Partial<OrgSmsTemplate>;                Relationships: [] }

      // ── Crew learning loop / feedback ───────────────────────
      assignment_outcomes:         { Row: AssignmentOutcome;             Insert: Partial<AssignmentOutcome>;             Update: Partial<AssignmentOutcome>;             Relationships: [] }
      vendor_assignment_outcomes:  { Row: VendorAssignmentOutcome;       Insert: Partial<VendorAssignmentOutcome>;       Update: Partial<VendorAssignmentOutcome>;       Relationships: [] }
      crew_feedback:               { Row: CrewFeedback;                  Insert: Partial<CrewFeedback>;                  Update: Partial<CrewFeedback>;                  Relationships: [] }
      checklist_item_signals:      { Row: ChecklistItemSignal;           Insert: Partial<ChecklistItemSignal>;           Update: Partial<ChecklistItemSignal>;           Relationships: [] }

      // ── Inventory templates ─────────────────────────────────
      inventory_templates:         { Row: InventoryTemplate;             Insert: Partial<InventoryTemplate>;             Update: Partial<InventoryTemplate>;             Relationships: [] }
      inventory_template_items:    { Row: InventoryTemplateItem;         Insert: Partial<InventoryTemplateItem>;         Update: Partial<InventoryTemplateItem>;         Relationships: [] }
      platform_inventory_templates:      { Row: PlatformInventoryTemplate;      Insert: Partial<PlatformInventoryTemplate>;      Update: Partial<PlatformInventoryTemplate>;      Relationships: [] }
      platform_inventory_template_items: { Row: PlatformInventoryTemplateItem;  Insert: Partial<PlatformInventoryTemplateItem>;  Update: Partial<PlatformInventoryTemplateItem>;  Relationships: [] }

      // ── Maintenance ──────────────────────────────────────────
      maintenance_catalog_items:   { Row: MaintenanceCatalogItem;        Insert: Partial<MaintenanceCatalogItem>;        Update: Partial<MaintenanceCatalogItem>;        Relationships: [] }
      maintenance_completions:     { Row: MaintenanceCompletion;         Insert: Partial<MaintenanceCompletion>;         Update: Partial<MaintenanceCompletion>;         Relationships: [] }

      // ── Work order billing ──────────────────────────────────
      work_order_invoices:         { Row: WorkOrderInvoice;              Insert: Partial<WorkOrderInvoice>;              Update: Partial<WorkOrderInvoice>;              Relationships: [] }

      // ── Guest messaging ──────────────────────────────────────
      reservation_messages:        { Row: ReservationMessage;            Insert: Partial<ReservationMessage>;            Update: Partial<ReservationMessage>;            Relationships: [] }

      // ── RepuGuard ────────────────────────────────────────────
      reviews:                     { Row: Review;                        Insert: Partial<Review>;                        Update: Partial<Review>;                        Relationships: [] }
      review_responses:            { Row: ReviewResponse;                Insert: Partial<ReviewResponse>;                Update: Partial<ReviewResponse>;                Relationships: [] }

      // ── Asset Health ───────────────────────────────────────
      property_assets:             { Row: PropertyAsset;            Insert: Partial<PropertyAsset>;            Update: Partial<PropertyAsset>;            Relationships: [] }
      asset_type_standards:        { Row: AssetTypeStandard;        Insert: Partial<AssetTypeStandard>;        Update: Partial<AssetTypeStandard>;        Relationships: [] }
      asset_depreciation_entries:  { Row: AssetDepreciationEntry;   Insert: Partial<AssetDepreciationEntry>;   Update: Partial<AssetDepreciationEntry>;   Relationships: [] }
      asset_manuals:               { Row: AssetManual;              Insert: Partial<AssetManual>;              Update: Partial<AssetManual>;              Relationships: [] }

      // ── Vendor Compliance ──────────────────────────────────
      vendor_compliance_documents: { Row: VendorComplianceDocument; Insert: Partial<VendorComplianceDocument>; Update: Partial<VendorComplianceDocument>; Relationships: [] }

      // ── Integration framework (server-side only) ───────────
      integration_providers:          { Row: IntegrationProvider;         Insert: Partial<IntegrationProvider>;         Update: Partial<IntegrationProvider>;         Relationships: [] }
      integration_connections:        { Row: IntegrationConnection;       Insert: Partial<IntegrationConnection>;       Update: Partial<IntegrationConnection>;       Relationships: [] }
      oauth_states:                   { Row: OAuthState;                  Insert: Partial<OAuthState>;                  Update: Partial<OAuthState>;                  Relationships: [] }
      processed_webhooks:             { Row: ProcessedWebhook;            Insert: Partial<ProcessedWebhook>;            Update: Partial<ProcessedWebhook>;            Relationships: [] }
      integration_entity_owners:      { Row: IntegrationEntityOwner;      Insert: Partial<IntegrationEntityOwner>;      Update: Partial<IntegrationEntityOwner>;      Relationships: [] }
      pending_integration_links:      { Row: PendingIntegrationLink;      Insert: Partial<PendingIntegrationLink>;      Update: Partial<PendingIntegrationLink>;      Relationships: [] }
      pending_oauth_authorizations:   { Row: PendingOAuthAuthorization;   Insert: Partial<PendingOAuthAuthorization>;   Update: Partial<PendingOAuthAuthorization>;   Relationships: [] }

      // ── Support bot ────────────────────────────────────────
      support_kb_chunks:     { Row: SupportKbChunk;     Insert: Partial<SupportKbChunk>;     Update: Partial<SupportKbChunk>;     Relationships: [] }
      support_conversations: { Row: SupportConversation; Insert: Partial<SupportConversation>; Update: Partial<SupportConversation>; Relationships: [] }
      support_messages:      { Row: SupportMessage;      Insert: Partial<SupportMessage>;      Update: Partial<SupportMessage>;      Relationships: [] }
      // ── Self-Funding Guidebook ───────────────────────────────
      guidebook_configurations:    { Row: GuidebookConfiguration;   Insert: Partial<GuidebookConfiguration>;   Update: Partial<GuidebookConfiguration>;   Relationships: [] }
      guidebook_sponsors:          { Row: GuidebookSponsor;         Insert: Partial<GuidebookSponsor>;         Update: Partial<GuidebookSponsor>;         Relationships: [] }
      guidebook_property_configs:  { Row: GuidebookPropertyConfig;  Insert: Partial<GuidebookPropertyConfig>;  Update: Partial<GuidebookPropertyConfig>;  Relationships: [] }
      guidebook_guest_sms_optins:  { Row: GuidebookGuestSmsOptin;   Insert: Partial<GuidebookGuestSmsOptin>;   Update: Partial<GuidebookGuestSmsOptin>;   Relationships: [] }
      guidebook_offer_redemptions: { Row: GuidebookOfferRedemption; Insert: Partial<GuidebookOfferRedemption>; Update: Partial<GuidebookOfferRedemption>; Relationships: [] }
      stay_extension_requests:     { Row: StayExtensionRequest;     Insert: Partial<StayExtensionRequest>;     Update: Partial<StayExtensionRequest>;     Relationships: [] }

      // ── In-app notifications (bell) ─────────────────────────
      notifications:               { Row: Notification;             Insert: Partial<Notification>;             Update: Partial<Notification>;             Relationships: [] }
      notification_digest_state:   { Row: NotificationDigestState;  Insert: Partial<NotificationDigestState>; Update: Partial<NotificationDigestState>; Relationships: [] }

      // ── Roadshow demo ───────────────────────────────────────
      demo_activity_log:           { Row: DemoActivityLog;          Insert: Partial<DemoActivityLog>;          Update: Partial<DemoActivityLog>;          Relationships: [] }
      // ── Hospitable launch promo ─────────────────────────────
      hospitable_launch_promo:         { Row: HospitableLaunchPromo;         Insert: Partial<HospitableLaunchPromo>;         Update: Partial<HospitableLaunchPromo>;         Relationships: [] }
      promo_hospitable_launch_counter: { Row: PromoHospitableLaunchCounter;  Insert: Partial<PromoHospitableLaunchCounter>;  Update: Partial<PromoHospitableLaunchCounter>;  Relationships: [] }
    }
    Views: {
      vendor_compliance_status: { Row: VendorComplianceStatus }
    }
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}
