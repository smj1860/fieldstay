import { OutboxEngine } from './outboxEngine'
import {
  getVendorWoDb,
  type VendorWoMutationRow,
  type VendorWoDraftRow,
  type VendorLineItemSubmission,
} from './vendorWoSchema'

// The server returns 409 when the WO was already closed by another path (PM
// cancelled it, someone else completed it) while this vendor was offline
// queuing their own completion, and 410 when the completion token itself
// has expired (a vendor offline long enough for the 30-day link TTL to
// lapse). Neither can ever succeed on retry no matter how many times it's
// attempted, so both must dead-letter immediately rather than burn the
// full retry budget silently.
class WorkOrderClosedError extends Error {}
class LinkExpiredError extends Error {}

async function uploadVendorCompletion(mutation: VendorWoMutationRow): Promise<void> {
  const res = await fetch(`/api/work-orders/${mutation.token}/complete`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(mutation.payload),
  })

  if (res.ok) return

  if (res.status === 409) {
    await getVendorWoDb(mutation.token).mutations.update(mutation.id!, { terminalReason: 'closed' })
    throw new WorkOrderClosedError('Work order already closed')
  }
  if (res.status === 410) {
    await getVendorWoDb(mutation.token).mutations.update(mutation.id!, { terminalReason: 'expired' })
    throw new LinkExpiredError('Link has expired')
  }
  throw new Error(`Vendor work order completion failed: ${res.status}`)
}

const engines = new Map<string, OutboxEngine<VendorWoMutationRow>>()

function getVendorSyncEngine(token: string): OutboxEngine<VendorWoMutationRow> {
  let engine = engines.get(token)
  if (!engine) {
    const db = getVendorWoDb(token)
    engine = new OutboxEngine<VendorWoMutationRow>(db.mutations, {
      uploadOne:  uploadVendorCompletion,
      isTerminal: (err) => err instanceof WorkOrderClosedError || err instanceof LinkExpiredError,
    })
    engines.set(token, engine)
  }
  return engine
}

/** Debounced local persistence of in-progress line items/notes — call on every field change. */
export async function saveVendorWoDraft(
  token:     string,
  notes:     string,
  lineItems: VendorWoDraftRow['lineItems'],
): Promise<void> {
  const db = getVendorWoDb(token)
  await db.drafts.put({ token, notes, lineItems, updatedAt: new Date().toISOString() })
}

export async function loadVendorWoDraft(token: string): Promise<VendorWoDraftRow | undefined> {
  const db = getVendorWoDb(token)
  return db.drafts.get(token)
}

/**
 * The current queued/dead-lettered completion submission for this token, if
 * any — at most one ever exists (submitVendorWoCompletion replaces rather
 * than accumulates). Used on mount to restore the correct screen after a
 * reload/reopen instead of showing a blank form for work that's already
 * been submitted and is only waiting to sync.
 */
export async function getVendorWoSubmissionState(token: string): Promise<VendorWoMutationRow | undefined> {
  const db = getVendorWoDb(token)
  const rows = await db.mutations.where('token').equals(token).toArray()
  return rows[0]
}

/**
 * Queues the completion submission and returns whether it actually reached
 * the server before this call returned (true) or is still sitting in the
 * outbox waiting for connectivity (false) — the caller needs this to show
 * accurate copy rather than implying the submission is already confirmed
 * server-side when it might not be.
 */
export async function submitVendorWoCompletion(
  token:     string,
  notes:     string,
  lineItems: VendorLineItemSubmission[],
  subtotal:  number,
): Promise<{ synced: boolean }> {
  const db = getVendorWoDb(token)

  // Only one completion submission is ever meaningful per work order —
  // replace any not-yet-drained attempt rather than queuing a second one.
  // Without this, a vendor who edits and resubmits before the first
  // attempt drains would have their correction lose the race against
  // their own stale earlier submission (outbox drains in insertion
  // order — the first one would claim the WO, the second would then hit
  // the 409-already-closed path and dead-letter instead of applying).
  const existing = await db.mutations.where('token').equals(token).toArray()
  if (existing.length > 0) {
    await db.mutations.bulkDelete(existing.map((m) => m.id as number))
  }

  await db.mutations.add({
    token,
    payload:    { notes, lineItems, subtotal },
    createdAt:  new Date().toISOString(),
    retryCount: 0,
  })

  const engine = getVendorSyncEngine(token)
  await engine.processOutbox()

  const stillPending = await db.mutations.where('token').equals(token).count()
  // Clear the draft only once nothing is left outstanding for this token —
  // a dead-lettered (terminal) mutation still counts as "pending" here on
  // purpose, so the vendor's original entries aren't wiped out from under
  // a rejection they haven't necessarily seen yet.
  if (stillPending === 0) await db.drafts.delete(token)

  return { synced: stillPending === 0 }
}

/** Auto-retry on reconnect — drains anything still pending, but does not
 * revive a dead-lettered mutation (see retryFailedVendorWoSubmission for that). */
export function retryVendorWoSubmission(token: string): Promise<void> {
  return getVendorSyncEngine(token).processOutbox()
}

/**
 * Re-queues a dead-lettered (failed) mutation for a manual "Retry" tap.
 * Only meaningful for a non-terminal failure (a transient network/server
 * error that exhausted its retry budget) — the caller should not offer
 * this for a terminal (closed/expired) failure, since resetting and
 * retrying it can never succeed.
 */
export async function retryFailedVendorWoSubmission(token: string): Promise<void> {
  const db = getVendorWoDb(token)
  const failed = await db.mutations.where('token').equals(token).filter((m) => !!m.failed).toArray()

  for (const mutation of failed) {
    await db.mutations.update(mutation.id!, { failed: false, retryCount: 0, terminalReason: undefined })
  }

  await getVendorSyncEngine(token).processOutbox()
}
