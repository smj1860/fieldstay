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
  // Inventory has no turnover-scoped table of its own — these live on the
  // turnover directly. Nullable, matching completed_at's own convention on
  // ChecklistInstanceItemRow below (empty timestamp columns use '' per the
  // is_completed/completed_by_crew_id convention elsewhere in this file).
  inventory_started_at:            string | null
  inventory_confirmed_complete_at: string | null
  inventory_confirmed_by_crew_id:  string
  completion_notes:                string
  // Staged checkout/checkin change against an in_progress turnover — see
  // lib/turnovers/generator.ts's refreshExistingPairDates(). Genuinely
  // nullable (not the ''-empty-string convention above) to match
  // checklist_instances.completed_at's pattern for real timestamp-or-null
  // fields. NO Dexie version bump needed for these — non-indexed fields
  // don't require one.
  pending_checkout_datetime:    string | null
  pending_checkin_datetime:     string | null
  dates_changed_at:             string | null
  dates_change_acknowledged_at: string | null
}

export interface ChecklistInstanceRow {
  id:                   string
  turnover_id:          string
  org_id:               string
  status:               string
  section_photo_path:   string
  started_at:           string | null
  completed_at:         string | null
  completed_by_crew_id: string
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
  id:       string
  name:     string
  org_id:   string
  address:  string
  city:     string
  state:    string
  lat:      number | null
  lng:      number | null
  timezone: string   // IANA identifier, e.g. "America/Chicago" — see lib/utils/timezone.ts
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

// Progressive Asset Discovery cache — synced read-only for properties the
// crew member is currently assigned to (see lib/asset-discovery/config.ts
// for the REQUIRED_ASSET_TYPES list this is checked against).
export interface PropertyAssetRow {
  id:          string
  org_id:      string
  property_id: string
  asset_type:  string
  make:        string
  model:       string
  is_na:       number
  photo_url:   string
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

export interface CrewWorkOrderRow {
  id:                      string
  org_id:                  string
  property_id:             string
  assigned_crew_member_id: string | null
  title:                   string
  description:             string | null
  status:                  string
  priority:                string
  scheduled_date:          string | null
  wo_number:               string | null
  created_at:              string
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
  // Set once retryCount exceeds processOutbox()'s MAX_RETRIES. Dead-lettered
  // mutations used to be deleted outright — losing any record that a write
  // never made it to the server. Keeping the row (excluded from the pending
  // queue) lets the UI surface "this didn't sync" instead of silently
  // discarding it.
  failed?:    boolean
}

export class FieldStayDexie extends Dexie {
  turnovers!:                Table<TurnoverRow, string>
  checklist_instances!:      Table<ChecklistInstanceRow, string>
  checklist_instance_items!: Table<ChecklistInstanceItemRow, string>
  inventory_items!:          Table<InventoryItemRow, string>
  properties!:               Table<PropertyRow, string>
  crew_availability!:        Table<CrewAvailabilityRow, string>
  messages!:                 Table<MessageRow, string>
  pending_photo_uploads!:    Table<PendingPhotoUploadRow, string>
  mutations!:                Table<MutationRow, number>
  sync_meta!:                Table<SyncMetaRow, string>
  crew_work_orders!:         Table<CrewWorkOrderRow, string>
  property_assets!:          Table<PropertyAssetRow, string>

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

    // crew_members, maintenance_schedules, maintenance_completions, and
    // turnover_assignments were never read or written anywhere in the crew
    // app — DexieProvider derives turnover/property/inventory/checklist data
    // straight from Supabase without ever populating these stores. Dropped
    // as dead schema; null deletes the object store on upgrade.
    this.version(4).stores({
      crew_members:            null,
      maintenance_schedules:   null,
      maintenance_completions: null,
      turnover_assignments:    null,
    })

    // Crew-assigned work orders surface alongside turnovers in the crew PWA.
    // Only the new store is declared — Dexie carries forward all prior stores.
    this.version(5).stores({
      crew_work_orders: 'id, property_id, org_id, status, scheduled_date',
    })

    // turnover_issue_reports was insert-only local staging for the old
    // "Report an Issue" flow, dropped in favor of turnovers.completion_notes
    // (a plain field update, no local queue table needed). property_assets
    // backs the crew Assets & Maintenance page's missing-items list.
    this.version(6).stores({
      turnover_issue_reports: null,
      property_assets:        'id, property_id, org_id, asset_type',
    })

    // sender_id wasn't indexed, so the "my conversation with the PM" query
    // in app/crew/messages/page.tsx had to fall back to a full-table
    // .filter() instead of a proper .where(...).or(...) compound query.
    this.version(7).stores({
      messages: 'id, org_id, turnover_id, recipient_id, sender_id, created_at',
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
    const dbName = db.name
    const formerUserId = dbUserId
    db.close()
    db = null
    dbUserId = null
    // Delete the entire IndexedDB database so no crew data persists
    // on the device after sign-out. Crew-app data is re-synced fresh
    // on next login; nothing is lost that can't be re-fetched.
    try {
      await Dexie.delete(dbName)
    } catch (err) {
      console.error('[Dexie] Failed to delete DB on logout:', err)
      // Non-fatal: the closed connection already prevents reads;
      // the delete just ensures no residual storage remains.
    }
    // Also delete the user-namespaced photo blob store (lib/dexie/photo-queue.ts)
    if (formerUserId) {
      try {
        await Dexie.delete(`fieldstay-photo-queue-${formerUserId}`)
      } catch (err) {
        console.error('[Dexie] Failed to delete photo blob store on logout:', err)
      }
    }
  }
}

/**
 * Deletes IndexedDB databases belonging to users OTHER than the current one.
 * Called on Dexie context mount when a userId is known.
 *
 * Safety: only deletes databases matching the 'fieldstay-' prefix pattern.
 * Never deletes the active user's database.
 * Non-fatal: failures are logged and ignored.
 */
export async function cleanupStaleDexieDbs(currentUserId: string): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB.databases) return

    const dbs = await indexedDB.databases()
    const stale = dbs.filter((info) => {
      if (!info.name) return false
      if (!info.name.startsWith('fieldstay-')) return false
      // Keep the active user's database
      return !info.name.includes(currentUserId)
    })

    await Promise.allSettled(
      stale.map((info) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(info.name!)
          req.onsuccess = () => resolve()
          req.onerror   = () => reject(req.error)
          req.onblocked = () => {
            // Another tab has it open — skip rather than block
            console.warn(`[Dexie cleanup] ${info.name} is blocked — skipping`)
            resolve()
          }
        })
      )
    )
  } catch (err) {
    // Non-fatal: cleanup failure should never affect the active session
    console.warn('[Dexie cleanup] stale DB cleanup failed (non-fatal):', err)
  }
}
