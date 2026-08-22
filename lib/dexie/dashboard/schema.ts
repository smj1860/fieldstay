// lib/dexie/dashboard/schema.ts
//
// The PM dashboard's local cache and outbox — the second first-class Dexie
// surface, per docs/INSPECTIONS_SPEC.md §8.
//
// It exists because §8 widened offline support from inspections alone to the
// whole Maintenance page: a PM standing at a property with no signal who
// notices a broken handrail wants to raise a work order, and "the inspection
// works offline but the work order does not" is a line drawn by our
// architecture rather than by their job.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE DATABASE NAME CARRIES BOTH THE USER AND THE ORG
//
// §8: "IndexedDB survives sign-out unless something explicitly clears it, so a
// PM removed from an org keeps a readable copy of that org's maintenance board
// on their tablet indefinitely." The crew cache only needs a user key, because
// a crew member's scope is their assignments. A PM's is an ORG, and a PM can
// belong to several and be removed from one.
//
// The dashboard holds more than the crew PWA does — costs, vendor contacts,
// owner-adjacent detail — so this is the difference between a stale cache and a
// disclosure. §8 is explicit that it has to be built in rather than
// retrofitted, "because the version that works without it looks identical".
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS HAS ITS OWN PREFIX LIST AND ITS OWN STALENESS TEST
//
// `cleanupStaleDexieDbs` in ../schema.ts deletes crew databases whose name does
// not end in the current user id. Adding this prefix to ITS list would delete
// the PM's live dashboard cache on every crew-context mount, because the
// dashboard suffix is `{userId}-{orgId}` and never equals `{userId}`.
//
// That is the same shape of mistake the comment on CLEANABLE_DB_PREFIXES
// already records: a crew login on a shared device used to destroy a vendor's
// queued work-order completion, because a link token is not a user id and so
// never "contains" one. Three principals, three prefixes, three cleanups that
// touch only their own. `unit/guardrails/dexie-db-namespacing.test.ts` holds
// them apart.

import Dexie, { type Table } from 'dexie'

import type { DeadLetterFlag } from '../outbox-primitives'
import type {
  MaintenanceSchedule,
  Property,
  PropertyAsset,
  Vendor,
  WorkOrder,
} from '@/types/database'

/**
 * What the dashboard queues while offline. §8: offline writes are CREATE ONLY.
 *
 * Editing or completing an EXISTING work order offline is deliberately absent
 * and is not a matter of effort. The maintenance board is shared — a PM, a
 * second PM and the vendor portal can all touch one work order — so
 * last-write-wins across a six-hour offline gap silently reverts whatever
 * happened while the tablet was in a basement, and neither party ever learns.
 * The crew PWA escapes this because a crew member effectively owns their
 * turnover; nobody owns a work order.
 */
export type DashboardMutationKind = 'work_order.create' | 'inspection.submit'

export interface DashboardMutationRow {
  id?:        number
  kind:       DashboardMutationKind
  /** Client-generated id, so the optimistic local row and the queued write agree. */
  targetId:   string
  orgId:      string
  payload:    Record<string, unknown>
  createdAt:  string
  retryCount: number
  /** 0/1, never a boolean — IndexedDB cannot index a boolean. See DeadLetterFlag. */
  failed?:            DeadLetterFlag
  nextAttemptAt?:     number
  networkRetryCount?: number
  /** Short, user-safe reason. NEVER the payload — it carries notes and costs. */
  lastError?: string
}

export interface DashboardPendingPhotoRow {
  id:         string
  orgId:      string
  /** Which queued write this photo belongs to, by `targetId`. */
  targetId:   string
  blobKey:    string
  mimeType:   string
  status:     'pending' | 'uploaded'
  retryCount: number
  failed?:            DeadLetterFlag
  nextAttemptAt?:     number
  networkRetryCount?: number
  lastError?: string
  createdAt:  string
}

/** Incremental-pull watermarks, same role as the crew cache's sync_meta. */
export interface DashboardSyncMetaRow {
  key:   string
  value: string
}

export class FieldStayDashboardDexie extends Dexie {
  // Read cache. Every one of these is bounded by the org's plan-capped property
  // count — at 50 properties roughly 1,050 assets and 900 schedules, both from
  // the live per-property ratios measured during the `-org-scoped` semgrep
  // audit rather than a guess (§8).
  properties!:            Table<Property, string>
  vendors!:               Table<Vendor, string>
  property_assets!:       Table<PropertyAsset, string>
  maintenance_schedules!: Table<MaintenanceSchedule, string>
  work_orders!:           Table<WorkOrder, string>

  // Write path.
  mutations!:             Table<DashboardMutationRow, number>
  pending_photo_uploads!: Table<DashboardPendingPhotoRow, string>
  sync_meta!:             Table<DashboardSyncMetaRow, string>

  constructor(userId: string, orgId: string) {
    super(dashboardDbName(userId, orgId))

    this.version(1).stores({
      properties:            'id, org_id',
      vendors:               'id, org_id',
      property_assets:       'id, org_id, property_id, asset_type',
      maintenance_schedules: 'id, org_id, property_id, next_due_date',
      work_orders:           'id, org_id, property_id, wo_status',

      // `failed` is indexed on BOTH outboxes — the dead-letter banner keeps a
      // live query on each, and an unindexed predicate would full-scan the
      // outbox on every write to it. That only works because the flag is 0/1;
      // a boolean is silently absent from its own index.
      mutations:             '++id, kind, targetId, failed, [kind+targetId]',
      pending_photo_uploads: 'id, targetId, failed',
      sync_meta:             'key',
    })
  }
}

/** `fieldstay-dash-{userId}-{orgId}`. Both ids are UUIDs and both contain
 *  hyphens, so nothing may ever parse this by splitting — compare it whole. */
export function dashboardDbName(userId: string, orgId: string): string {
  return `${DASHBOARD_DB_PREFIX}${userId}-${orgId}`
}

export const DASHBOARD_DB_PREFIX = 'fieldstay-dash-'

/**
 * True for a dashboard database belonging to a different user OR a different
 * org — both are stale, which is what makes one predicate serve sign-out and
 * org-switch alike.
 *
 * Exact suffix comparison, never a split: `{userId}-{orgId}` is two UUIDs
 * joined by a hyphen and both are full of hyphens, so there is no position to
 * split on. `startsWith(userId)` would be wrong too — it would spare every org
 * of the current user, which is exactly the org-switch case §8 requires be
 * cleared.
 */
export function isStaleDashboardDbName(name: string, userId: string, orgId: string): boolean {
  if (!name.startsWith(DASHBOARD_DB_PREFIX)) return false
  return name.slice(DASHBOARD_DB_PREFIX.length) !== `${userId}-${orgId}`
}

let db:      FieldStayDashboardDexie | null = null
let dbKey:   string | null = null

export function getDashboardDb(userId: string, orgId: string): FieldStayDashboardDexie {
  const key = dashboardDbName(userId, orgId)
  if (!db || dbKey !== key) {
    // Closed, not just dropped: leaving the previous handle open holds a
    // connection that makes deleteDatabase() fire `blocked` and hang, which is
    // how an org switch silently fails to clear the previous org's cache.
    if (db) db.close()
    dbKey = key
    db = new FieldStayDashboardDexie(userId, orgId)
  }
  return db
}

/** Drops the in-process handle without deleting anything. */
export function closeDashboardDb(): void {
  if (db) db.close()
  db    = null
  dbKey = null
}

/**
 * Deletes every dashboard database that is not the (user, org) pair now in
 * use — covering sign-out, org switch, and a device shared between PMs in one
 * pass, because all three are the same question: "is this cache still mine?"
 *
 * Only ever touches DASHBOARD_DB_PREFIX names, so a crew cache or a vendor's
 * queued completion on the same device is untouchable from here.
 *
 * Non-fatal by construction: a cleanup failure must never break the session it
 * was tidying up after.
 */
export async function cleanupStaleDashboardDbs(userId: string, orgId: string): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB.databases) return

    const all   = await indexedDB.databases()
    const stale = all.filter((info) => !!info.name && isStaleDashboardDbName(info.name, userId, orgId))

    reportRejections(
      await Promise.allSettled(stale.map((info) => deleteDbByName(info.name!))),
      'stale cache cleanup',
    )
  } catch (err) {
    console.warn('[dashboard-dexie] stale cache cleanup failed (non-fatal):', err)
  }
}

/**
 * Sign-out: delete THIS user's dashboard caches across every org they had
 * open, not merely the active one.
 *
 * `cleanupStaleDashboardDbs` cannot serve here — it is defined relative to a
 * current pair, and at sign-out there is no current pair to be relative to.
 */
export async function purgeDashboardDbsForUser(userId: string): Promise<void> {
  closeDashboardDb()
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB.databases) return

    const all = await indexedDB.databases()
    const mine = all.filter((info) =>
      !!info.name &&
      info.name.startsWith(DASHBOARD_DB_PREFIX) &&
      // The suffix is `{userId}-{orgId}`; the org part is unknown and
      // irrelevant. A prefix test on the USER portion is right here and wrong
      // in isStaleDashboardDbName — opposite questions, opposite tests.
      info.name.slice(DASHBOARD_DB_PREFIX.length).startsWith(`${userId}-`))

    reportRejections(
      await Promise.allSettled(mine.map((info) => deleteDbByName(info.name!))),
      'sign-out purge',
    )
  } catch (err) {
    console.warn('[dashboard-dexie] sign-out purge failed (non-fatal):', err)
  }
}

/**
 * `allSettled` is right here — one database another tab holds open must not
 * abort the rest of the sweep — but on its own it DISCARDS every rejection
 * reason, which made a failed delete completely silent. That matters more than
 * usual: this sweep is a disclosure control, so "it didn't work and nobody
 * knows" is the failure mode it exists to prevent.
 *
 * Still non-fatal. Visible, not fatal.
 */
function reportRejections(results: PromiseSettledResult<void>[], what: string): void {
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failures.length === 0) return

  console.warn(
    `[dashboard-dexie] ${what}: ${failures.length} database(s) could not be deleted — ` +
    failures.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join('; '),
  )
}

function deleteDbByName(name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    // `req.error` is DOMException | NULL. Rejecting with it directly can hand
    // the caller `null`, which every `err instanceof Error` branch then reports
    // as the string "null" — a delete failure with no reason attached.
    req.onerror   = () => reject(req.error ?? new Error(`deleteDatabase("${name}") failed with no reason`))
    req.onblocked = () => {
      // Another tab holds it open. Skipping is right: blocking here would hang
      // the sign-out or the org switch behind a tab the user may never return
      // to, and that tab's own cleanup will delete it on its next mount.
      console.warn(`[dashboard-dexie] ${name} is blocked by another tab — skipping`)
      resolve()
    }
  })
}
