// lib/dexie/prune.ts
//
// Local cache garbage collection for the crew PWA.
//
// Only three of the cached tables reconcile deletions during a pull
// (turnovers + its checklists via the assignment scope, and crew_work_orders
// via its id-set snapshot). Everything else is bulkPut-only and therefore
// grows without bound on a device that stays logged in for months —
// `messages` worst of all (500 rows per pull against a rolling 90-day
// server window, nothing ever removed locally).
//
// Dead-lettered outbox rows and exhausted photo-queue rows are deliberately
// NOT collected on sight: they are the durable trace that a write never
// reached the server, and the crew shell's failed-sync surface is built on
// them. They're collected only once they're older than
// DEAD_LETTER_RETENTION_DAYS, by which point the crew member has had every
// opportunity to retry or discard them.

import { getDexieDb } from './schema'
import { deletePendingPhotoBlob } from './photo-queue'
import { MESSAGE_WINDOW_DAYS } from './sync/messages'

/** Matches syncCrewAvailability's own 30-day lookback. */
const AVAILABILITY_RETENTION_DAYS = 30

/**
 * How long a dead-lettered mutation / failed photo stays on the device
 * before it's collected. Long enough that a crew member who only opens the
 * app on shift days still sees it in the failed-sync surface.
 */
export const DEAD_LETTER_RETENTION_DAYS = 30

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

/**
 * Removes cached rows the crew member can no longer reach, plus expired
 * dead letters. Safe to call on every resync — every deletion is derived
 * from the current local scope, never from a server response, so it is
 * correct offline too.
 */
export async function pruneLocalCache(userId: string): Promise<void> {
  const db = getDexieDb(userId)

  // ── Scope-derived: rows for properties the crew member no longer has ──
  const [turnovers, workOrders] = await Promise.all([
    db.turnovers.toArray(),
    db.crew_work_orders.toArray(),
  ])
  const livePropertyIds = new Set<string>([
    ...turnovers.map((t) => t.property_id),
    ...workOrders.map((w) => w.property_id),
  ])

  const [properties, inventory, assets] = await Promise.all([
    db.properties.toArray(),
    db.inventory_items.toArray(),
    db.property_assets.toArray(),
  ])

  await Promise.all([
    db.properties.bulkDelete(properties.filter((p) => !livePropertyIds.has(p.id)).map((p) => p.id)),
    db.inventory_items.bulkDelete(inventory.filter((i) => !livePropertyIds.has(i.property_id)).map((i) => i.id)),
    db.property_assets.bulkDelete(assets.filter((a) => !livePropertyIds.has(a.property_id)).map((a) => a.id)),
  ])

  // ── Time-windowed: mirror the server-side pull windows ────────────────
  const messageHorizon = daysAgoIso(MESSAGE_WINDOW_DAYS)
  const messages = await db.messages.toArray()
  await db.messages.bulkDelete(
    messages.filter((m) => m.created_at < messageHorizon).map((m) => m.id)
  )

  // available_date is a plain date string (YYYY-MM-DD), so a lexical
  // comparison against the date part of the horizon is the correct one.
  const availabilityHorizon = daysAgoIso(AVAILABILITY_RETENTION_DAYS).slice(0, 10)
  const availability = await db.crew_availability.toArray()
  await db.crew_availability.bulkDelete(
    availability.filter((a) => a.available_date < availabilityHorizon).map((a) => a.id)
  )

  await pruneExpiredDeadLetters(userId)
}

/**
 * Collects dead letters the crew member never acted on. Kept separate so a
 * caller can reason about (and a test can assert) that live dead letters —
 * the ones the failed-sync surface is showing right now — are untouched.
 */
export async function pruneExpiredDeadLetters(userId: string): Promise<void> {
  const db = getDexieDb(userId)
  const horizon = daysAgoIso(DEAD_LETTER_RETENTION_DAYS)

  const staleMutations = (await db.mutations.toArray())
    .filter((m) => m.failed && m.createdAt < horizon)
  for (const mutation of staleMutations) {
    await db.mutations.delete(mutation.id as number)
  }

  const stalePhotos = (await db.pending_photo_uploads.toArray())
    .filter((p) => p.failed && p.created_at < horizon)
  for (const photo of stalePhotos) {
    await db.pending_photo_uploads.delete(photo.id)
    try {
      // Blob GC — a permanently-failed photo used to leave its bytes in
      // fieldstay-photo-queue-{userId} forever with nothing referencing them.
      await deletePendingPhotoBlob(userId, photo.local_blob_key)
    } catch (err) {
      console.warn('[prune] failed to delete expired photo blob:', err)
    }
  }
}

/**
 * Work that is genuinely still on its way to the server: pending outbox
 * mutations and pending photos, EXCLUDING dead-lettered rows.
 *
 * The logout warning is built on this. Counting dead letters here (as it
 * used to) meant one ancient permanently-failed row made the "unsynced
 * work" confirmation fire on every single logout forever — which trains
 * crew to click through the one dialog that exists to stop them destroying
 * real work. Dead letters get their own, actionable surface instead.
 */
export async function countPendingSyncWork(userId: string): Promise<{ pending: number; deadLettered: number }> {
  const db = getDexieDb(userId)
  const [mutations, photos] = await Promise.all([
    db.mutations.toArray(),
    db.pending_photo_uploads.toArray(),
  ])
  return {
    pending:      mutations.filter((m) => !m.failed).length + photos.filter((p) => !p.failed).length,
    deadLettered: mutations.filter((m) => !!m.failed).length + photos.filter((p) => !!p.failed).length,
  }
}
