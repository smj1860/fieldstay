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
export type BookingSource       = 'airbnb' | 'vrbo' | 'booking_com' | 'direct' | 'manual' | 'other'
export type TurnoverStatus      = 'pending_assignment' | 'assigned' | 'in_progress' | 'completed' | 'flagged' | 'cancelled'
export type PriorityLevel       = 'low' | 'medium' | 'high' | 'urgent'
export type ContactPref         = 'email' | 'sms' | 'both'
export type ChecklistStatus     = 'not_started' | 'in_progress' | 'completed'
export type InventoryCategory   = 'paper_goods' | 'cleaning' | 'kitchen' | 'bath' | 'laundry' | 'bedroom_linens' | 'outdoor' | 'maintenance_safety' | 'guest_experience' | 'technology' | 'other'
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
export type AutoAssignMode     = 'suggest' | 'autopilot' | 'disabled'
export type SuggestionStatus   = 'pending' | 'accepted' | 'dismissed'

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
export type MacrsClass        = '5_year' | '15_year' | '27_5_year' | '39_year' | 'section_179'
export type ComplianceDocType = 'coi' | 'workers_comp' | 'business_license' | 'contractor_license' | 'bonding' | 'other'
export type ComplianceStatus  = 'compliant' | 'expiring_soon' | 'grace_period' | 'hard_blocked' | 'no_documents'

// Communication logs
export type CommRecipientType   = 'vendor' | 'crew'
export type CommChannel         = 'email' | 'sms' | 'phone' | 'in_person' | 'note'
export type CommSource          = 'manual' | 'system'

// Integration framework
export type IntegrationAuthType = 'oauth2' | 'api_key'
export type IntegrationStatus   = 'active' | 'revoked' | 'error'

// Support bot
export type SupportCategory    = 'faq' | 'technical' | 'account_specific'
export type SupportMessageRole = 'user' | 'assistant'

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
  preferred_retailer:           string | null
  kroger_location_name:         string | null
  auto_assign_mode:             AutoAssignMode
  comms_log_retention_days:     number
  slack_webhook_url:            string | null
  repuguard_status:             'inactive' | 'trial' | 'active' | 'cancelled'
  repuguard_trial_start:        string | null
  repuguard_trial_end:          string | null
  repuguard_stripe_subscription_id: string | null
  repuguard_founding_member:    boolean
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
  address_line1:           string | null
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
  door_code:               string | null
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
  guidebook_token:      string | null
  guidebook_pre_arrival_email_sent_at: string | null
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
  created_at:     string
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
  id:          string
  template_id: string
  name:        string
  sort_order:  number
  created_at:  string
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
  auto_generated:        boolean
  is_same_day_turnover:  boolean
  suggested_crew_ids:    string[] | null
  suggestion_reasoning:  string | null
  suggestion_status:     SuggestionStatus | null
  is_archived:           boolean
  created_at:            string
  updated_at:            string
  turnover_assignments:  TurnoverAssignment[]
}

export interface TurnoverAssignment {
  id:                string
  turnover_id:       string
  crew_member_id:    string
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
  id:           string
  name:         string
  category:     InventoryCategory
  default_unit: string
  description:  string | null
  is_active:    boolean
  created_at:   string
}

export interface InventoryItem {
  id:                      string
  property_id:             string
  org_id:                  string
  catalog_item_id:         string | null
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

export interface InventoryCountDraft {
  id:             string
  org_id:         string
  property_id:    string
  crew_member_id: string | null
  status:         'pending_review' | 'approved' | 'rejected'
  submitted_at:   string | null
  reviewed_at:    string | null
  reviewed_by:    string | null
  notes:          string | null
  created_at:     string
  updated_at:     string
}

export interface InventoryCountDraftItem {
  id:                 string
  draft_id:           string
  inventory_item_id:  string
  previous_quantity:  number
  submitted_quantity: number
  created_at:         string
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
  invoice_reference:           string | null
  quote_token:                 string | null
  quote_token_expires_at:      string | null
  quoted_amount:               number | null
  quote_notes:                 string | null
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
  created_at:                  string
  updated_at:                  string
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
  id:          string
  org_id:      string
  name:        string
  description: string | null
  created_at:  string
}

// ── Inventory template item ──────────────────────────────────────────────────
export interface InventoryTemplateItem {
  id:              string
  template_id:     string
  catalog_item_id: string | null
  name:            string
  category:        InventoryCategory
  unit:            string
  par_level:       number
  sort_order:      number
  notes:           string | null
  preferred_brand: string | null
  created_at:      string
}

// ── Portfolio-level master checklist item ───────────────────────────────────
export interface OrgMasterChecklistItem {
  id:         string
  org_id:     string
  section:    string
  task:       string
  sort_order: number
  source:     'catalog' | 'custom' | 'upload'
  created_at: string
  updated_at: string
}

// ── Portfolio-level master maintenance schedule ──────────────────────────────
export interface OrgMasterMaintenanceSchedule {
  id:             string
  org_id:         string
  title:          string
  description:    string | null
  frequency:      'weekly' | 'monthly' | 'quarterly' | 'annually'
  month_day:      number | null
  week_day:       number | null
  estimated_cost: number | null
  specialty:      string | null
  notes:          string | null
  is_active:      boolean
  created_at:     string
  updated_at:     string
}

export interface PushSubscription {
  id:             string
  crew_member_id: string
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
//     added to PowerSync sync rules or the powersync publication
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
  id:                     string
  org_id:                 string
  property_id:            string
  slug:                   string
  check_in_instructions:  string | null
  check_out_instructions: string | null
  wifi_network:           string | null
  wifi_password:          string | null
  house_rules:            string | null
  is_published:           boolean
  created_at:             string
  updated_at:             string
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
  created_at:                 string
  updated_at:                 string
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
  id:              string
  org_id:          string
  user_id:         string
  status:          string
  created_at:      string
  last_message_at: string
}

export interface SupportMessage {
  id:              string
  conversation_id: string
  role:            SupportMessageRole
  content:         string
  category:        SupportCategory | null
  model_used:      string | null
  created_at:      string
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
      org_master_checklist_items:      { Row: OrgMasterChecklistItem;        Insert: Partial<OrgMasterChecklistItem>;        Update: Partial<OrgMasterChecklistItem>;        Relationships: [] }
      org_master_maintenance_schedules:{ Row: OrgMasterMaintenanceSchedule;  Insert: Partial<OrgMasterMaintenanceSchedule>;  Update: Partial<OrgMasterMaintenanceSchedule>;  Relationships: [] }

      // ── Asset Health ───────────────────────────────────────
      property_assets:             { Row: PropertyAsset;            Insert: Partial<PropertyAsset>;            Update: Partial<PropertyAsset>;            Relationships: [] }
      asset_type_standards:        { Row: AssetTypeStandard;        Insert: Partial<AssetTypeStandard>;        Update: Partial<AssetTypeStandard>;        Relationships: [] }
      asset_depreciation_entries:  { Row: AssetDepreciationEntry;   Insert: Partial<AssetDepreciationEntry>;   Update: Partial<AssetDepreciationEntry>;   Relationships: [] }

      // ── Vendor Compliance ──────────────────────────────────
      vendor_compliance_documents: { Row: VendorComplianceDocument; Insert: Partial<VendorComplianceDocument>; Update: Partial<VendorComplianceDocument>; Relationships: [] }

      // ── Integration framework (server-side only) ───────────
      integration_providers:          { Row: IntegrationProvider;         Insert: Partial<IntegrationProvider>;         Update: Partial<IntegrationProvider>;         Relationships: [] }
      integration_connections:        { Row: IntegrationConnection;       Insert: Partial<IntegrationConnection>;       Update: Partial<IntegrationConnection>;       Relationships: [] }
      oauth_states:                   { Row: OAuthState;                  Insert: Partial<OAuthState>;                  Update: Partial<OAuthState>;                  Relationships: [] }
      processed_webhooks:             { Row: ProcessedWebhook;            Insert: Partial<ProcessedWebhook>;            Update: Partial<ProcessedWebhook>;            Relationships: [] }
      pending_integration_links:      { Row: PendingIntegrationLink;      Insert: Partial<PendingIntegrationLink>;      Update: Partial<PendingIntegrationLink>;      Relationships: [] }

      // ── Support bot ────────────────────────────────────────
      support_kb_chunks:     { Row: SupportKbChunk;     Insert: Partial<SupportKbChunk>;     Update: Partial<SupportKbChunk>;     Relationships: [] }
      support_conversations: { Row: SupportConversation; Insert: Partial<SupportConversation>; Update: Partial<SupportConversation>; Relationships: [] }
      support_messages:      { Row: SupportMessage;      Insert: Partial<SupportMessage>;      Update: Partial<SupportMessage>;      Relationships: [] }
      // ── Self-Funding Guidebook ───────────────────────────────
      guidebook_configurations:    { Row: GuidebookConfiguration;   Insert: Partial<GuidebookConfiguration>;   Update: Partial<GuidebookConfiguration>;   Relationships: [] }
      guidebook_sponsors:          { Row: GuidebookSponsor;         Insert: Partial<GuidebookSponsor>;         Update: Partial<GuidebookSponsor>;         Relationships: [] }
      guidebook_property_configs:  { Row: GuidebookPropertyConfig;  Insert: Partial<GuidebookPropertyConfig>;  Update: Partial<GuidebookPropertyConfig>;  Relationships: [] }
      guidebook_guest_sms_optins:  { Row: GuidebookGuestSmsOptin;   Insert: Partial<GuidebookGuestSmsOptin>;   Update: Partial<GuidebookGuestSmsOptin>;   Relationships: [] }
      stay_extension_requests:     { Row: StayExtensionRequest;     Insert: Partial<StayExtensionRequest>;     Update: Partial<StayExtensionRequest>;     Relationships: [] }
    }
    Views: {
      vendor_compliance_status: { Row: VendorComplianceStatus }
    }
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}
