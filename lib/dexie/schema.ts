import Dexie, { type Table } from 'dexie'

import { reportError } from '@/lib/observability/report-error'
// Table shapes mirror the Supabase tables they cache. Booleans are stored as
// integers (0/1) and everything else — including ids and timestamps — as text,
// so rows round-trip through IndexedDB without type coercion surprises.

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

// Local-only: never synced as its own table, purely a local queue.
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
  // Mirrors MutationRow's backoff/dead-letter fields — a queued photo used
  // to have neither, so five failed ticks (~2.5 min offline) silently
  // dropped it out of the drain query forever with the blob orphaned and no
  // UI anywhere saying so.
  next_attempt_at?:     number
  network_retry_count?: number
  /** 0/1, not a boolean — see the note on MutationRow.failed. */
  failed?:              DeadLetterFlag
  last_error?:          string
}

/**
 * Dead-letter marker, stored as 0/1 rather than a boolean.
 *
 * IndexedDB has no boolean key type: a record whose indexed property holds
 * `true` is simply omitted from that index, so `failed` could never be
 * indexed while it was a boolean and every dead-letter query — including the
 * three `useLiveQuery`s FailedSyncBanner keeps live on every crew screen —
 * had to full-scan the outbox on every single write to it.
 *
 * 0/1 preserves every existing truthiness check (`!m.failed`, `!!m.failed`)
 * unchanged; only the literal `true`/`false` writes moved. Version 9's
 * upgrade normalizes rows written before this.
 */
export type DeadLetterFlag = 0 | 1

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

// Every value here must have a matching entry in UPLOAD_HANDLERS
// (lib/dexie/syncService.ts) — an unhandled table used to silently vanish
// from the outbox instead of reaching Supabase.
export type MutationTable =
  | 'checklist_instance_items'
  | 'turnovers'
  | 'checklist_instances'
  | 'work_order_reports'
  // Legacy: the crew turnover tab used to write current_quantity per item.
  // No crew surface enqueues this any more — the whole count now goes through
  // 'inventory_counts' — but the handler stays for one release so a mutation
  // already queued on a device drains instead of dead-lettering as NO_HANDLER.
  | 'inventory_items'
  | 'inventory_counts'
  | 'crew_availability'
  | 'property_assets'
  | 'crew_work_orders'
  | 'messages'

export interface MutationRow {
  id?:        number
  table:      MutationTable
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
  //
  // 0/1 rather than boolean so it can actually be indexed — see DeadLetterFlag.
  failed?:    DeadLetterFlag
  // Shape version of `payload`, stamped at enqueue time. An outbox row can
  // outlive the release that queued it (a device offline across a deploy), so
  // the drain migrates an older payload forward rather than replaying a shape
  // the current upload handler no longer understands. Absent ⇒ version 1.
  payloadVersion?: number
  // Retry backoff: epoch ms before which processOutbox() must not re-push
  // this mutation. Set on push failure (exponential backoff with jitter),
  // cleared by the row's deletion on successful push. Not indexed — the
  // drain scans in insertion order and checks this in memory.
  nextAttemptAt?: number
  // Transport-failure counter, deliberately SEPARATE from retryCount: a push
  // that never reached the server (offline, dropped connection) must not
  // consume the retry budget that leads to dead-lettering, but must still
  // drive the backoff curve so a dead connection isn't hammered. See
  // lib/dexie/net.ts's classifyUploadFailure.
  networkRetryCount?: number
  // Short, user-safe reason a dead-lettered mutation failed, for the crew
  // failed-sync surface. Never contains the payload (crew notes, quantities,
  // completion data) — see describeFailure() in syncService.ts.
  lastError?: string
}

export class FieldStayDexie extends Dexie {
  turnovers!:                Table<TurnoverRow, string>
  checklist_instances!:      Table<ChecklistInstanceRow, string>
  checklist_instance_items!: Table<ChecklistInstanceItemRow, string>
  inventory_items!:          Table<InventoryItemRow, string>
  properties!:               Table<PropertyRow, string>
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

    // Outbox retry backoff (Crew Sync v2 Phase 4): MutationRow gains
    // nextAttemptAt (epoch ms). Non-indexed — processOutbox() drains in
    // insertion order and checks due-ness in memory — so the index strings
    // are unchanged; the full store map is repeated here to keep this block
    // a complete snapshot of the live schema.
    this.version(8).stores({
      turnovers:                'id, property_id, org_id, status',
      checklist_instances:      'id, turnover_id, org_id, status',
      checklist_instance_items: 'id, instance_id, turnover_id, is_completed',
      inventory_items:          'id, property_id, org_id',
      properties:               'id, org_id',
      crew_availability:        'id, org_id, crew_member_id, available_date',
      messages:                 'id, org_id, turnover_id, recipient_id, sender_id, created_at',
      pending_photo_uploads:    'id, target_id, target_table, retry_count',
      // ++id = auto-incrementing outbox key; table/targetId are indexed so
      // processOutbox() can replay mutations in insertion order per record.
      mutations:                '++id, table, targetId',
      sync_meta:                'key',
      crew_work_orders:         'id, property_id, org_id, status, scheduled_date',
      property_assets:          'id, property_id, org_id, asset_type',
    })

    // Index correction (2026-08-04 offline-sync audit). Only the three changed
    // stores are declared — Dexie carries every other store forward unchanged.
    //
    //  - `mutations.failed` / `pending_photo_uploads.failed`: the predicate of
    //    every dead-letter query in the app, previously unindexed AND
    //    unindexABLE (booleans are not valid IndexedDB keys). FailedSyncBanner
    //    keeps three of those queries live on every crew screen, so each one
    //    full-scanned the outbox on every checklist tick and every drain step.
    //  - `[table+targetId]`: the per-record lookup enqueueMutation() and
    //    holdBackSuccessors() both do. Both ran as full scans; the former now
    //    runs on EVERY crew write.
    //  - `pending_photo_uploads.retry_count`: dropped. Nothing has ever queried
    //    it — it cost an index write per attempt and bought nothing.
    //  - `checklist_instance_items.is_completed`: dropped. Never queried by
    //    index either, and a two-value column is close to useless as one
    //    while costing a write on the highest-volume mutation in the app.
    this.version(9)
      .stores({
        mutations:                '++id, table, targetId, failed, [table+targetId]',
        pending_photo_uploads:    'id, target_id, target_table, failed',
        checklist_instance_items: 'id, instance_id, turnover_id',
      })
      .upgrade((tx) =>
        // Normalize the pre-existing boolean flags to the 0/1 the index needs.
        // Rows written as `failed: true` are invisible to `.where('failed')`
        // until this runs — which on a device that dead-lettered work while
        // offline is exactly the row the crew member most needs to see.
        Promise.all([
          tx.table('mutations').toCollection()
            .modify((m: MutationRow) => { m.failed = m.failed ? 1 : 0 }),
          tx.table('pending_photo_uploads').toCollection()
            .modify((p: PendingPhotoUploadRow) => { p.failed = p.failed ? 1 : 0 }),
        ]).then(() => undefined),
      )

    // crew_availability leaves the crew cache entirely. Time off is now an
    // online-only screen: app/crew/availability reads its rows server-side and
    // writes through a Server Action, so nothing on the device reads this
    // store. It was the second-heaviest thing the five-minute safety poll
    // pulled — a full 30-days-back-to-a-year-forward window, uncursored, on
    // every tick — to back a screen that needs a connection to be useful.
    //
    // The `crew_availability` UPLOAD_HANDLERS entries deliberately REMAIN for
    // one release: a mutation queued before this deploy lives in `mutations`,
    // not in the store being dropped here, and must still drain rather than
    // dead-letter as NO_HANDLER.
    this.version(10).stores({
      crew_availability: null,
    })

    // messages leaves the crew cache too. History is read from the server
    // (app/crew/messages/page.tsx) and the unread badge is server-rendered by
    // the crew layout — the badge's Dexie live query was the only reason this
    // table had to be cached at all. It was the heaviest thing the safety poll
    // pulled: up to 500 rows across a rolling 90-day window, uncursored, every
    // five minutes, with no reconciliation.
    //
    // SENDING a message is now offline-capable for the first time — it goes
    // through the outbox as a 'messages' mutation (see queueMessageToPM), so
    // nothing about this drop reduces what a crew member can do without signal.
    this.version(11).stores({
      messages: null,
    })
  }
}

// ── Crew Sync v2 coverage (docs/CREW_SYNC_V2_PHASES.md section 5e) ─────────
// Every Supabase-backed table declared on FieldStayDexie above must appear
// here, mapped to the Supabase table it caches (identical to the Dexie name
// except crew_work_orders, which caches `work_orders`). Checked by
// unit/guardrails/crew-sync-coverage.test.ts against every `Table<...>`
// field on the class above — a newly added cached table fails CI until it's
// placed here (or in LOCAL_ONLY_TABLES below) AND covered by a broadcast
// trigger or the SAFETY_POLL_ONLY allowlist in that same test file.
export const CREW_SYNCED_TABLES: Readonly<Record<string, string>> = {
  turnovers:                'turnovers',
  checklist_instances:      'checklist_instances',
  checklist_instance_items: 'checklist_instance_items',
  inventory_items:          'inventory_items',
  properties:                'properties',
  crew_work_orders:         'work_orders',
  property_assets:          'property_assets',
}

// Dexie tables with no Supabase counterpart — pure local state (the
// mutation outbox, sync cursors/watermarks, the local photo-upload queue).
// Never subject to the crew-sync trigger/safety-poll coverage check above.
export const LOCAL_ONLY_TABLES = ['pending_photo_uploads', 'mutations', 'sync_meta'] as const

let db: FieldStayDexie | null = null
let dbUserId: string | null = null

// ── Post-logout shutdown latch ────────────────────────────────────────────
//
// closeDexieDb() deletes the signed-out user's IndexedDB, but deleting it is
// not the same as keeping it deleted. Logout races every drain and sync path
// in the crew PWA: an `online` event (which the logout flow itself provokes —
// crew members confirm "Log Out Anyway" the moment connectivity returns), the
// 30 s outbox interval, the DexieProvider safety poll, and any drain already
// mid-await when the delete landed. Every one of those ends at
// getDexieDb(userId), which used to construct a fresh FieldStayDexie and let
// Dexie auto-open it — silently RE-CREATING the database that was just wiped
// and leaving the signed-out user's data on a shared device. That is exactly
// what e2e/specs/22-crew-logout-guard.spec.ts asserts against.
//
// The latch makes re-opening structurally impossible rather than a matter of
// stopping every caller in time: once a user id is marked shut down,
// getDexieDb() hands back a permanently CLOSED Dexie handle (below). Dexie
// clears autoOpen on close(), so a handle closed before it was ever opened
// never touches IndexedDB at all — every operation on it rejects with
// DatabaseClosedError, which is the same failure the existing callers already
// handle after a plain close(), and no storage is created.
//
// It is a latch, not a permanent kill: resumeDexieDb() clears it when a
// session for that user starts again in the same document (see DexieProvider),
// so logging back in on the same tab works normally.
const shutdownUserIds = new Set<string>()

let tombstone: FieldStayDexie | null = null
let tombstoneUserId: string | null = null

/** True once this user's local database has been torn down by logout. */
export function isDexieShutdown(userId: string): boolean {
  return shutdownUserIds.has(userId)
}

/**
 * Marks the user's local database as shutting down. MUST be called before
 * closeDexieDb() — anything that reaches getDexieDb() after this point gets a
 * closed handle instead of a freshly re-created database.
 */
export function markDexieShutdown(userId: string): void {
  shutdownUserIds.add(userId)
}

/** Clears the latch so a new session for this user in the same document works. */
export function resumeDexieDb(userId: string): void {
  shutdownUserIds.delete(userId)
  if (tombstoneUserId === userId) {
    tombstone = null
    tombstoneUserId = null
  }
}

function shutdownHandle(userId: string): FieldStayDexie {
  if (!tombstone || tombstoneUserId !== userId) {
    tombstoneUserId = userId
    const handle = new FieldStayDexie(userId)
    // Closed before it is ever opened: Dexie sets autoOpen = false here, so no
    // subsequent operation can open (and therefore create) the IndexedDB.
    handle.close()
    tombstone = handle
  }
  return tombstone
}

export function getDexieDb(userId: string): FieldStayDexie {
  if (shutdownUserIds.has(userId)) return shutdownHandle(userId)
  if (!db || dbUserId !== userId) {
    if (db) db.close()
    dbUserId = userId
    db = new FieldStayDexie(userId)
  }
  return db
}

// ── Cross-tab logout ──────────────────────────────────────────────────────
//
// The shutdown latch above is per-DOCUMENT module state, but IndexedDB is a
// per-ORIGIN resource. With a second crew tab open (an office tablet, a
// turnover opened in a new tab) logging out in tab A used to fail two ways at
// once:
//
//  1. `indexedDB.deleteDatabase` fires `blocked` and WAITS while any other
//     connection is open. Dexie's default blocked handler warns and keeps
//     waiting, so `await Dexie.delete(...)` never resolved — and because it
//     sits before `supabase.auth.signOut()` and the redirect in
//     performLogout(), the user stayed signed in, on the crew screen, with the
//     logout button already re-enabled by its own `finally`. Silent no-op.
//  2. Tab B's own `shutdownUserIds` was never latched, so it kept draining and
//     its next getDexieDb() would re-create the database — leaving a
//     signed-out user's work on a shared device, the exact thing the latch
//     exists to prevent.
//
// So: tell the other tabs first (they latch, close their connection, and
// leave), and bound the delete so a tab that ignores us can never strand the
// user mid-logout.
const LOGOUT_CHANNEL = 'fieldstay-crew-logout'

/** How long to wait for other tabs to release the database before giving up. */
const DELETE_BLOCKED_TIMEOUT_MS = 3_000

interface ShutdownMessage { type: 'shutdown'; userId: string }

function broadcastShutdown(userId: string): void {
  if (typeof BroadcastChannel === 'undefined') return
  try {
    const channel = new BroadcastChannel(LOGOUT_CHANNEL)
    channel.postMessage({ type: 'shutdown', userId } satisfies ShutdownMessage)
    channel.close()
  } catch (err) {
    // Never let a messaging failure block the logout it is meant to assist.
    console.warn('[Dexie] logout broadcast failed (non-fatal):', err)
  }
}

/**
 * Subscribes this document to logout broadcasts from sibling tabs. Installed
 * once per session by DexieProvider; the returned function unsubscribes.
 *
 * `onShutdown` is how the UI leaves the crew surface — a tab still rendering
 * cached assignments for a user who just signed out on another tab is the
 * same shared-device leak, just on screen instead of on disk.
 */
export function listenForRemoteShutdown(userId: string, onShutdown: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}

  let channel: BroadcastChannel
  try {
    channel = new BroadcastChannel(LOGOUT_CHANNEL)
  } catch {
    return () => {}
  }

  channel.onmessage = (event: MessageEvent<ShutdownMessage>) => {
    if (event.data?.type !== 'shutdown' || event.data.userId !== userId) return
    // Latch BEFORE closing: anything mid-await here must not re-open storage.
    markDexieShutdown(userId)
    if (db && dbUserId === userId) {
      db.close()          // release the connection so the deleting tab unblocks
      db = null
      dbUserId = null
    }
    onShutdown()
  }

  return () => channel.close()
}

/**
 * Deletes a database, giving up rather than waiting indefinitely on a
 * connection another tab refuses to release. Losing the delete is recoverable
 * — the shutdown latch already blocks every read, and cleanupStaleDexieDbs()
 * collects the residue on the next login — whereas hanging here strands the
 * user in a half-signed-out state, which is not.
 */
async function deleteDbBounded(name: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Dexie.delete(name),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`IndexedDB delete of ${name} blocked by another connection`)),
          DELETE_BLOCKED_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function closeDexieDb(): Promise<void> {
  if (db) {
    const dbName = db.name
    const formerUserId = dbUserId
    // Latch first, synchronously, before the first await: a drain resumed by
    // the microtask queue between here and the delete below must not be able
    // to re-open what we are about to delete.
    if (formerUserId) {
      markDexieShutdown(formerUserId)
      // Other tabs latch and close their connection, so the delete below has
      // a chance of not being blocked in the first place.
      broadcastShutdown(formerUserId)
    }
    db.close()
    db = null
    dbUserId = null
    // Delete the entire IndexedDB database so no crew data persists
    // on the device after sign-out. Crew-app data is re-synced fresh
    // on next login; nothing is lost that can't be re-fetched.
    try {
      await deleteDbBounded(dbName)
    } catch (err) {
      console.error('[Dexie] Failed to delete DB on logout:', err)
      reportError(err, { site: 'lib.dexie.schema.Dexie' })
      // Non-fatal: the closed connection already prevents reads;
      // the delete just ensures no residual storage remains.
    }
    // Also delete the user-namespaced photo blob store (lib/dexie/photo-queue.ts)
    if (formerUserId) {
      try {
        await deleteDbBounded(`fieldstay-photo-queue-${formerUserId}`)
      } catch (err) {
        console.error('[Dexie] Failed to delete photo blob store on logout:', err)
        reportError(err, { site: 'lib.dexie.schema.Dexie' })
      }
    }
  }
}

// The ONLY database-name prefixes this cleanup may touch: the crew cache
// and the crew photo blob store, both namespaced by auth user id.
//
// Deliberately NOT `fieldstay-` — that broader prefix also matches
// `fieldstay-vendor-wo-{token}` (lib/dexie/vendorWoSchema.ts), a completely
// unrelated principal's outbox. A crew member logging in on a shared device
// (an office tablet, a borrowed phone) used to destroy a vendor's queued,
// never-uploaded work-order completion, because a link token is not a user
// id and so never "contains" it.
const CLEANABLE_DB_PREFIXES = ['fieldstay-crew-', 'fieldstay-photo-queue-'] as const

/** True only for a crew-owned database belonging to some OTHER user. */
export function isStaleCrewDbName(name: string, currentUserId: string): boolean {
  const prefix = CLEANABLE_DB_PREFIXES.find((p) => name.startsWith(p))
  if (!prefix) return false
  // Exact suffix match, not `includes` — the remainder after the prefix is
  // the owning user's id and nothing else.
  return name.slice(prefix.length) !== currentUserId
}

/**
 * Deletes the crew IndexedDB databases belonging to users OTHER than the
 * current one. Called on Dexie context mount when a userId is known.
 *
 * Safety: only ever touches CLEANABLE_DB_PREFIXES databases (see above) —
 * never the active user's, and never another principal's (vendor) storage.
 * Non-fatal: failures are logged and ignored.
 */
export async function cleanupStaleDexieDbs(currentUserId: string): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB.databases) return

    const dbs = await indexedDB.databases()
    const stale = dbs.filter((info) => !!info.name && isStaleCrewDbName(info.name, currentUserId))

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
