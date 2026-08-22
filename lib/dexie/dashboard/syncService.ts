// lib/dexie/dashboard/syncService.ts
//
// The dashboard's outbox drain. Built ON lib/dexie/outboxEngine.ts, not beside
// it — INSPECTIONS_SPEC §8 is explicit that a second outbox means paying twice
// for behaviours that were each bought with a production bug: the offline gate,
// the cross-tab lock, the strict in-order stop, backoff, transport failures
// that cost no retry budget, and dead-lettering rather than deleting.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HANDLERS ARE NOT WIRED YET, AND THAT IS DELIBERATE.
//
// §10 puts "offline WO create" in phase 3 and remediation in phase 4, so
// neither server endpoint exists. What phase 2a owes is the MECHANISM and its
// safety net, so that phase 3 cannot add a queued write without also being
// forced to give it an upload handler, a banner label and a retry affordance.
//
// `DASHBOARD_UPLOAD_HANDLERS` is a `Record<DashboardMutationKind, …>`, so that
// pairing is enforced by the COMPILER rather than by a string-scanning test:
// adding a kind without a handler will not build. That is strictly stronger
// than the crew equivalent, which greps `UPLOAD_HANDLERS` for each member of
// its union.
//
// Until an endpoint exists, each handler throws a terminal, clearly-labelled
// error. Nothing enqueues today, so nothing dead-letters today; the shape is
// what matters, and a loud throw beats a silent no-op if anything ever does
// reach it before phase 3 lands.

import { OutboxEngine } from '../outboxEngine'
import {
  getDashboardDb,
  type DashboardMutationKind,
  type DashboardMutationRow,
} from './schema'

/**
 * Thrown by a handler whose server endpoint has not shipped yet. Terminal on
 * purpose — retrying cannot conjure a route, and burning the retry budget to
 * discover that five times would only delay the visible failure.
 */
export class HandlerNotImplementedError extends Error {
  constructor(kind: DashboardMutationKind) {
    super(`No upload handler for "${kind}" yet — see INSPECTIONS_SPEC §10 phases 3–4.`)
    this.name = 'HandlerNotImplementedError'
  }
}

type UploadHandler = (mutation: DashboardMutationRow) => Promise<void>

/**
 * One entry per mutation kind. Exhaustiveness is a compile error, not a lint.
 *
 * A handler must be IDEMPOTENT: the drain deletes the row only after the
 * handler resolves, so a response lost in flight replays the same write. Every
 * row carries a client-generated `targetId` precisely so the server can treat a
 * replay as the same write rather than a second one.
 */
export const DASHBOARD_UPLOAD_HANDLERS: Record<DashboardMutationKind, UploadHandler> = {
  // Phase 3. Will POST to a Route Handler rather than call the existing
  // `createWorkOrder` Server Action: a queued row can outlive the release that
  // wrote it (a tablet offline across a deploy), and Server Action ids are not
  // stable across builds, so a replay would 404. The Route Handler must reuse
  // the helpers that action already uses rather than reimplement them — two
  // paths that create a work order is exactly the drift this repo pays for.
  'work_order.create': (m) => Promise.reject(new HandlerNotImplementedError(m.kind)),

  // Phase 4. One atomic completion, per §8: the inspection's own semantics
  // survive the change of mechanism.
  'inspection.submit': (m) => Promise.reject(new HandlerNotImplementedError(m.kind)),
}

const engines = new Map<string, OutboxEngine<DashboardMutationRow>>()

export function getDashboardSyncEngine(userId: string, orgId: string): OutboxEngine<DashboardMutationRow> {
  const key = `${userId}-${orgId}`
  const existing = engines.get(key)
  if (existing) return existing

  const db = getDashboardDb(userId, orgId)
  const engine = new OutboxEngine<DashboardMutationRow>(db.mutations, {
    // Distinct from the crew lock. Sharing one would let a crew tab's drain
    // block a dashboard tab's on the same device for no reason — they push to
    // different endpoints and have no ordering relationship.
    lockName:   `fieldstay-dashboard-outbox-${key}`,
    uploadOne:  (m) => DASHBOARD_UPLOAD_HANDLERS[m.kind](m),
    isTerminal: (err) => err instanceof HandlerNotImplementedError,
  })
  engines.set(key, engine)
  return engine
}

/** Stops and forgets the engine for a pair — call before deleting its database. */
export function disposeDashboardSyncEngine(userId: string, orgId: string): void {
  const key = `${userId}-${orgId}`
  engines.get(key)?.dispose()
  engines.delete(key)
}

/**
 * Queues a write. The caller's optimistic local change and this outbox row MUST
 * commit in ONE Dexie transaction — CLAUDE.md's rule, bought with a real bug:
 * as two transactions, a PWA reclaimed between them left the cache updated with
 * nothing queued to send it, and no delta pull corrects that because the server
 * row's `updated_at` never changed.
 *
 * So this takes the caller's local write as a callback and runs both inside one
 * transaction. Nothing async-external may go in there: an IndexedDB transaction
 * auto-commits the moment an await leaves it, which is why the drain kick sits
 * outside.
 */
export async function enqueueDashboardMutation(
  userId: string,
  orgId: string,
  mutation: Omit<DashboardMutationRow, 'id' | 'createdAt' | 'retryCount' | 'orgId'>,
  localWrite?: () => Promise<void> | void,
): Promise<void> {
  const db = getDashboardDb(userId, orgId)

  await db.transaction('rw', db.mutations, db.work_orders, async () => {
    if (localWrite) await localWrite()
    await db.mutations.add({
      ...mutation,
      orgId,
      createdAt:  new Date().toISOString(),
      retryCount: 0,
      failed:     0,
    } as DashboardMutationRow)
  })

  // Outside the transaction, deliberately — see above.
  void getDashboardSyncEngine(userId, orgId).processOutbox()
}

/**
 * Clears the dead-letter flag on every failed mutation and drains immediately.
 *
 * `ignoreBackoff` because an explicit "Retry" tap invalidates the reason the
 * backoff exists. Without it the drain stops at the gate and the tap silently
 * does nothing — which is worse than no button.
 */
export async function retryAllFailedDashboardMutations(userId: string, orgId: string): Promise<void> {
  const db = getDashboardDb(userId, orgId)
  const failed = await db.mutations.where('failed').equals(1).toArray()

  for (const m of failed) {
    await db.mutations.update(m.id as number, {
      failed:            0,
      retryCount:        0,
      networkRetryCount: 0,
      nextAttemptAt:     undefined,
      lastError:         undefined,
    })
  }

  await getDashboardSyncEngine(userId, orgId).processOutbox({ ignoreBackoff: true })
}

/**
 * Throws a dead letter away for good.
 *
 * No cursor invalidation here, unlike the crew's `discardFailedMutation`. That
 * is not an omission: the crew rule exists because a queued mutation is
 * REPLAYED over every pull while the cursor advances past the server row it
 * masks, so abandoning it without rewinding pins the cache to a value the
 * server never accepted. The dashboard outbox is CREATE-ONLY (§8) — it masks no
 * server row, because the row it would have created does not exist. If an
 * update kind is ever added, that rule arrives with it.
 */
export async function discardFailedDashboardMutation(
  userId: string,
  orgId:  string,
  id:     number,
): Promise<void> {
  await getDashboardDb(userId, orgId).mutations.delete(id)
}

/** Pending work that has not dead-lettered — what a "you have unsent work" prompt counts. */
export async function countPendingDashboardWork(userId: string, orgId: string): Promise<number> {
  const db = getDashboardDb(userId, orgId)
  const [mutations, photos] = await Promise.all([
    db.mutations.filter((m) => !m.failed).count(),
    db.pending_photo_uploads.filter((p) => !p.failed && p.status === 'pending').count(),
  ])
  return mutations + photos
}
