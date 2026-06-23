import Dexie, { type Table } from 'dexie'

// Mirrors lib/powersync/schema.ts table-for-table. Column types follow the
// same convention PowerSync uses: column.integer for booleans (0/1) and
// column.text for everything else, including ids and timestamps.

export interface TurnoverRow {
  id:                string
  property_id:       string
  org_id:            string
  checkout_datetime: string
  checkin_datetime:  string
  window_minutes:    number
  status:            string
  priority:          string
  notes:             string
}

export interface ChecklistInstanceRow {
  id:                  string
  turnover_id:         string
  org_id:              string
  status:              string
  section_photo_path:  string
}

export interface ChecklistInstanceItemRow {
  id:                    string
  instance_id:           string
  turnover_id:           string
  section_name:          string
  task:                  string
  is_completed:          number
  completed_at:          string | null
  completed_by_crew_id:  string
  requires_photo:        number
  photo_reason:          string
  photo_storage_path:    string | null
  crew_notes:            string
  sort_order:            number
  is_section_final_item: number
}

export interface InventoryItemRow {
  id:               string
  property_id:      string
  org_id:           string
  name:             string
  category:         string
  unit:             string
  par_level:        number
  current_quantity: number
}

export interface PropertyRow {
  id:      string
  name:    string
  org_id:  string
  address: string
  city:    string
  state:   string
  lat:     number | null
  lng:     number | null
}

export interface CrewAvailabilityRow {
  id:             string
  org_id:         string
  crew_member_id: string
  available_date: string
  is_available:   number
  notes:          string
  created_at:     string
}

export interface CrewMemberRow {
  id:                 string
  org_id:             string
  name:               string
  email:              string
  phone:              string
  role:               string
  specialty:          string
  is_active:          number
  user_id:            string
  invite_sent_at:     string
  invite_accepted_at: string
}

export interface MaintenanceScheduleRow {
  id:                        string
  property_id:               string
  org_id:                    string
  name:                      string
  description:               string
  schedule_type:             string
  frequency:                 string
  active_from_month:         number
  active_to_month:           number
  asset_category:            string
  next_due_date:             string
  estimated_cost:            string
  instructions:              string
  auto_create_wo:            number
  is_from_standard_template: number
  is_active:                 number
  created_at:                string
  updated_at:                string
}

export interface MaintenanceCompletionRow {
  id:                      string
  maintenance_schedule_id: string
  property_id:             string
  org_id:                  string
  asset_category:          string
  completed_at:            string
  completed_by:            string
  notes:                   string
  work_order_id:           string
  next_due_date_set:       string
  created_at:              string
}

export interface TurnoverAssignmentRow {
  id:             string
  turnover_id:    string
  crew_member_id: string
  org_id:         string
  assigned_at:    string
  assigned_by:    string
}

export interface MessageRow {
  id:           string
  org_id:       string
  sender_id:    string
  recipient_id: string
  content:      string
  read_at:      string | null
  turnover_id:  string
  group_id:     string
  group_label:  string
  created_at:   string
}

// insertOnly in PowerSync — locally we only ever create rows, never update/delete.
export interface TurnoverIssueReportRow {
  id:          string
  turnover_id: string
  org_id:      string
  property_id: string
  title:       string
  description: string
  priority:    string
}

// localOnly in PowerSync — never synced as its own table, purely a local queue.
export interface PendingPhotoUploadRow {
  id:             string
  target_table:   string
  target_id:      string
  target_column:  string
  storage_path:   string | null
  local_blob_key: string
  mime_type:      string
  retry_count:    number
  created_at:     string
}

// Tracks incremental-sync watermarks (e.g. the last `turnover_assignments.created_at`
// pulled from Supabase), so initialSync can fetch only what changed since last time
// instead of re-pulling everything whenever the local cache is already populated.
export interface SyncMetaRow {
  key:   string
  value: string
}

export type MutationOp = 'PUT' | 'PATCH' | 'DELETE'

export interface MutationRow {
  id?:        number
  table:      string
  targetId:   string
  op:         MutationOp
  payload:    Record<string, unknown>
  createdAt:  string
  retryCount: number
}

export class FieldStayDexie extends Dexie {
  turnovers!:                Table<TurnoverRow, string>
  checklist_instances!:      Table<ChecklistInstanceRow, string>
  checklist_instance_items!: Table<ChecklistInstanceItemRow, string>
  inventory_items!:          Table<InventoryItemRow, string>
  properties!:               Table<PropertyRow, string>
  crew_availability!:        Table<CrewAvailabilityRow, string>
  crew_members!:             Table<CrewMemberRow, string>
  maintenance_schedules!:    Table<MaintenanceScheduleRow, string>
  maintenance_completions!:  Table<MaintenanceCompletionRow, string>
  turnover_assignments!:     Table<TurnoverAssignmentRow, string>
  messages!:                 Table<MessageRow, string>
  turnover_issue_reports!:   Table<TurnoverIssueReportRow, string>
  pending_photo_uploads!:    Table<PendingPhotoUploadRow, string>
  mutations!:                Table<MutationRow, number>
  sync_meta!:                Table<SyncMetaRow, string>

  constructor(userId: string) {
    super(`fieldstay-crew-${userId}`)

    this.version(1).stores({
      turnovers:                'id, property_id, org_id, status',
      checklist_instances:      'id, turnover_id, org_id, status',
      checklist_instance_items: 'id, instance_id, turnover_id, is_completed',
      inventory_items:          'id, property_id, org_id',
      properties:               'id, org_id',
      crew_availability:        'id, org_id, crew_member_id, available_date',
      crew_members:             'id, org_id, user_id',
      maintenance_schedules:    'id, property_id, org_id, next_due_date',
      maintenance_completions:  'id, maintenance_schedule_id, property_id, org_id',
      turnover_assignments:     'id, turnover_id, crew_member_id, org_id',
      messages:                 'id, org_id, turnover_id, group_id',
      turnover_issue_reports:   'id, turnover_id, org_id',
      pending_photo_uploads:    'id, target_table, target_id',
      // ++id = auto-incrementing outbox key; table/targetId are indexed so
      // processOutbox() can replay mutations in insertion order per record.
      mutations:                '++id, table, targetId',
    })

    this.version(2).stores({
      turnovers:                'id, property_id, org_id, status',
      checklist_instances:      'id, turnover_id, org_id, status',
      checklist_instance_items: 'id, instance_id, turnover_id, is_completed',
      inventory_items:          'id, property_id, org_id',
      properties:               'id, org_id',
      crew_availability:        'id, org_id, crew_member_id, available_date',
      crew_members:             'id, org_id, user_id',
      maintenance_schedules:    'id, property_id, org_id, next_due_date',
      maintenance_completions:  'id, maintenance_schedule_id, property_id, org_id',
      turnover_assignments:     'id, turnover_id, crew_member_id, org_id',
      messages:                 'id, org_id, turnover_id, recipient_id, created_at',
      turnover_issue_reports:   'id, turnover_id, org_id',
      pending_photo_uploads:    'id, target_id, target_table, retry_count',
      // ++id = auto-incrementing outbox key; table/targetId are indexed so
      // processOutbox() can replay mutations in insertion order per record.
      mutations:                '++id, table, targetId',
    })

    this.version(3).stores({
      turnovers:                'id, property_id, org_id, status',
      checklist_instances:      'id, turnover_id, org_id, status',
      checklist_instance_items: 'id, instance_id, turnover_id, is_completed',
      inventory_items:          'id, property_id, org_id',
      properties:               'id, org_id',
      crew_availability:        'id, org_id, crew_member_id, available_date',
      crew_members:             'id, org_id, user_id',
      maintenance_schedules:    'id, property_id, org_id, next_due_date',
      maintenance_completions:  'id, maintenance_schedule_id, property_id, org_id',
      turnover_assignments:     'id, turnover_id, crew_member_id, org_id',
      messages:                 'id, org_id, turnover_id, recipient_id, created_at',
      turnover_issue_reports:   'id, turnover_id, org_id',
      pending_photo_uploads:    'id, target_id, target_table, retry_count',
      mutations:                '++id, table, targetId',
      sync_meta:                'key',
    })
  }
}

let db: FieldStayDexie | null = null
let dbUserId: string | null = null

export function getDexieDb(userId: string): FieldStayDexie {
  if (!db || dbUserId !== userId) {
    if (db) db.close()
    dbUserId = userId
    db = new FieldStayDexie(userId)
  }
  return db
}

export async function closeDexieDb(): Promise<void> {
  if (db) {
    db.close()
    db = null
    dbUserId = null
  }
}
