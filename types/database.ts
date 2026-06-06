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

export type OrgPlan             = 'starter' | 'growth' | 'pro' | 'enterprise'
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
export type InventoryCategory   = 'paper_goods' | 'cleaning' | 'kitchen' | 'bath' | 'laundry' | 'bedroom' | 'outdoor' | 'other'
export type PoStatus            = 'draft' | 'sent' | 'acknowledged' | 'ordered' | 'received' | 'cancelled'
export type VendorSpecialty     = 'plumbing' | 'electrical' | 'hvac' | 'landscaping' | 'cleaning' | 'pest_control' | 'pool' | 'roofing' | 'general' | 'other'
export type WoStatus            = 'pending' | 'quote_requested' | 'assigned' | 'in_progress' | 'completed' | 'cancelled'
export type WoSource            = 'manual' | 'maintenance_schedule' | 'crew_flag' | 'guest_report'
export type WoCategory          =
  | 'hvac' | 'plumbing' | 'electrical' | 'appliance' | 'cleaning'
  | 'landscaping' | 'roofing' | 'flooring' | 'windows_doors'
  | 'pest_control' | 'pool' | 'structural' | 'general' | 'other'
export type LineItemType        =
  | 'labor' | 'material' | 'equipment' | 'subcontractor' | 'other'
export type ScheduleType        = 'routine' | 'seasonal'
export type ScheduleFrequency   = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'semi_annual' | 'annual'
export type MessageTrigger      = 'booking_confirmed' | 'pre_checkout'
export type MessageStatus       = 'sent' | 'failed' | 'bounced'
export type TxnType             = 'revenue' | 'expense'
export type TxnCategory         = 'booking_revenue' | 'cleaning_fee' | 'maintenance' | 'restock' | 'utility' | 'insurance' | 'supplies' | 'other'
export type QuoteRequestStatus  = 'pending' | 'submitted' | 'approved' | 'declined' | 'expired'
export type CrewRole            = 'cleaning' | 'landscaping' | 'maintenance' | 'general'

// Communication logs
export type CommRecipientType   = 'vendor' | 'crew'
export type CommChannel         = 'email' | 'sms' | 'phone' | 'in_person' | 'note'
export type CommSource          = 'manual' | 'system'

// Integration framework
export type IntegrationAuthType = 'oauth2' | 'api_key'
export type IntegrationStatus   = 'active' | 'revoked' | 'error'

// ─────────────────────────────────────────────────────────────
// Row interfaces — one per Supabase table
// ─────────────────────────────────────────────────────────────

export interface Profile {
  id:          string
  full_name:   string | null
  phone:       string | null
  avatar_url:  string | null
  created_at:  string
  updated_at:  string
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
  bathrooms:               number
  max_guests:              number
  avg_stay_length:         number
  avg_turnovers_per_month: number
  wifi_name:               string | null
  wifi_password:           string | null
  door_code:               string | null
  checkout_time:           string
  checkin_time:            string
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
  created_at:              string
  updated_at:              string
}

export interface PropertyOwner {
  id:                string
  org_id:            string
  property_id:       string
  name:              string
  email:             string | null
  phone:             string | null
  revenue_share_pct: number | null
  notes:             string | null
  created_at:        string
  updated_at:        string
}

export interface OwnerPortalToken {
  id:                string
  property_owner_id: string
  token:             string
  expires_at:        string | null
  last_accessed_at:  string | null
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
  id:            string
  property_id:   string
  org_id:        string
  ical_feed_id:  string | null
  ical_uid:      string | null
  guest_name:    string | null
  guest_email:   string | null
  checkin_date:  string
  checkout_date: string
  checkin_time:  string | null
  checkout_time: string | null
  source:        BookingSource
  status:        BookingStatus
  notes:         string | null
  raw_ical_data: Record<string, unknown> | null
  created_at:    string
  updated_at:    string
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
  invite_token:       string | null
  invite_sent_at:     string | null
  invite_accepted_at: string | null
  created_at:         string
  updated_at:         string
}

export interface Vendor {
  id:             string
  org_id:         string
  name:           string
  contact_name:   string | null
  email:          string | null
  phone:          string | null
  specialty:      VendorSpecialty
  portal_enabled: boolean
  notes:          string | null
  is_active:      boolean
  avg_rating:     number | null
  rating_count:   number
  created_at:     string
  updated_at:     string
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
  completed_at:          string | null
  auto_generated:        boolean
  created_at:            string
  updated_at:            string
}

export interface TurnoverAssignment {
  id:                string
  turnover_id:       string
  crew_member_id:    string
  assigned_at:       string
  notified_at:       string | null
  notification_type: ContactPref | null
  created_at:        string
}

export interface ChecklistInstance {
  id:                string
  turnover_id:       string
  org_id:            string
  template_id:       string | null
  template_snapshot: Record<string, unknown>
  status:            ChecklistStatus
  started_at:        string | null
  completed_at:      string | null
  created_at:        string
  updated_at:        string
}

export interface ChecklistInstanceItem {
  id:                   string
  instance_id:          string
  section_name:         string
  task:                 string
  requires_photo:       boolean
  notes:                string | null
  sort_order:           number
  is_completed:         boolean
  completed_at:         string | null
  completed_by_crew_id: string | null
  photo_storage_path:   string | null
  crew_notes:           string | null
  created_at:           string
  updated_at:           string
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
  notes:                   string | null
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
  generated_at:         string
  sent_at:              string | null
  acknowledged_at:      string | null
  notes:                string | null
  total_estimated_cost: number | null
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
  id:            string
  work_order_id: string
  org_id:        string
  line_type:     LineItemType
  description:   string
  quantity:      number
  unit:          string | null
  unit_cost:     number
  line_total:    number
  sort_order:    number
  created_at:    string
}

export interface WorkOrder {
  id:                          string
  property_id:                 string
  org_id:                      string
  vendor_id:                   string | null
  assigned_crew_id:            string | null
  wo_number:                   string | null
  title:                       string
  description:                 string | null
  category:                    WoCategory | null
  priority:                    PriorityLevel
  status:                      WoStatus
  source:                      WoSource
  source_schedule_id:          string | null
  scheduled_date:              string | null
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
  created_at:                  string
  updated_at:                  string
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
  id:                  string
  property_id:         string
  org_id:              string
  assigned_vendor_id:  string | null
  name:                string
  description:         string | null
  schedule_type:       ScheduleType
  frequency:           ScheduleFrequency | null
  month_due:           number | null
  day_of_month_due:    number | null
  estimated_cost:      number | null
  instructions:        string | null
  auto_create_wo:      boolean
  last_completed_date: string | null
  next_due_date:       string | null
  is_active:           boolean
  created_at:          string
  updated_at:          string
}

export interface GuestMessageTemplate {
  id:          string
  property_id: string
  org_id:      string
  trigger:     MessageTrigger
  name:        string
  subject:     string
  body:        string
  days_before: number
  is_active:   boolean
  created_at:  string
  updated_at:  string
}

export interface GuestMessageSent {
  id:                string
  property_id:       string
  org_id:            string
  booking_id:        string | null
  template_id:       string | null
  trigger:           MessageTrigger
  recipient_name:    string | null
  recipient_email:   string
  subject:           string
  body_rendered:     string
  sent_at:           string
  resend_message_id: string | null
  status:            MessageStatus
  created_at:        string
}

export interface OwnerTransaction {
  id:                string
  property_id:       string
  org_id:            string
  transaction_type:  TxnType
  category:          TxnCategory
  amount:            number
  description:       string
  transaction_date:  string
  work_order_id:     string | null
  purchase_order_id: string | null
  booking_id:        string | null
  notes:             string | null
  created_at:        string
  updated_at:        string
}

export interface OrgMilestone {
  id:             string
  org_id:         string
  milestone:      string
  achieved_at:    string
  prompted_at:    string | null
  review_clicked: boolean
  dismissed:      boolean
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
      purchase_orders:             { Row: PurchaseOrder;            Insert: Partial<PurchaseOrder>;            Update: Partial<PurchaseOrder>;            Relationships: [] }
      purchase_order_items:        { Row: PurchaseOrderItem;        Insert: Partial<PurchaseOrderItem>;        Update: Partial<PurchaseOrderItem>;        Relationships: [] }
      work_orders:                 { Row: WorkOrder;                Insert: Partial<WorkOrder>;                Update: Partial<WorkOrder>;                Relationships: [] }
      work_order_line_items:       { Row: WorkOrderLineItem;        Insert: Partial<WorkOrderLineItem>;        Update: Partial<WorkOrderLineItem>;        Relationships: [] }
      work_order_updates:          { Row: WorkOrderUpdate;          Insert: Partial<WorkOrderUpdate>;          Update: Partial<WorkOrderUpdate>;          Relationships: [] }
      work_order_photos:           { Row: WorkOrderPhoto;           Insert: Partial<WorkOrderPhoto>;           Update: Partial<WorkOrderPhoto>;           Relationships: [] }
      maintenance_schedules:       { Row: MaintenanceSchedule;      Insert: Partial<MaintenanceSchedule>;      Update: Partial<MaintenanceSchedule>;      Relationships: [] }
      guest_message_templates:     { Row: GuestMessageTemplate;     Insert: Partial<GuestMessageTemplate>;     Update: Partial<GuestMessageTemplate>;     Relationships: [] }
      guest_messages_sent:         { Row: GuestMessageSent;         Insert: Partial<GuestMessageSent>;         Update: Partial<GuestMessageSent>;         Relationships: [] }
      owner_transactions:          { Row: OwnerTransaction;         Insert: Partial<OwnerTransaction>;         Update: Partial<OwnerTransaction>;         Relationships: [] }
      org_milestones:              { Row: OrgMilestone;             Insert: Partial<OrgMilestone>;             Update: Partial<OrgMilestone>;             Relationships: [] }
      quote_requests:              { Row: QuoteRequest;             Insert: Partial<QuoteRequest>;             Update: Partial<QuoteRequest>;             Relationships: [] }
      communication_logs:          { Row: CommunicationLog;              Insert: Partial<CommunicationLog>;              Update: Partial<CommunicationLog>;              Relationships: [] }
      push_subscriptions:          { Row: PushSubscription;              Insert: Partial<PushSubscription>;              Update: Partial<PushSubscription>;              Relationships: [] }
      org_master_checklist_items:      { Row: OrgMasterChecklistItem;        Insert: Partial<OrgMasterChecklistItem>;        Update: Partial<OrgMasterChecklistItem>;        Relationships: [] }
      org_master_maintenance_schedules:{ Row: OrgMasterMaintenanceSchedule;  Insert: Partial<OrgMasterMaintenanceSchedule>;  Update: Partial<OrgMasterMaintenanceSchedule>;  Relationships: [] }

      // ── Integration framework (server-side only) ───────────
      integration_providers:       { Row: IntegrationProvider;      Insert: Partial<IntegrationProvider>;      Update: Partial<IntegrationProvider>;      Relationships: [] }
      integration_connections:     { Row: IntegrationConnection;    Insert: Partial<IntegrationConnection>;    Update: Partial<IntegrationConnection>;    Relationships: [] }
      oauth_states:                { Row: OAuthState;               Insert: Partial<OAuthState>;               Update: Partial<OAuthState>;               Relationships: [] }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}
