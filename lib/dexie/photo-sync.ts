// lib/dexie/photo-sync.ts
//
// Drains the pending_photo_uploads queue: attempts each queued photo's
// Supabase Storage upload, and on success writes the resulting path to the
// local Dexie row and queues a mutation so it reaches Supabase too — Dexie
// does not track local writes automatically, so every local write that needs
// to reach the server has to be queued explicitly.
//
// Durability rules mirror the mutation outbox (lib/dexie/syncService.ts)
// exactly, because a queued photo is just as much crew work as a checklist
// tick:
//  - Offline is not a failure. The drain no-ops while offline and a
//    transport failure never consumes the retry budget.
//  - Failures back off exponentially (computeNextAttemptAt) instead of
//    re-attempting on every 30 s tick.
//  - A permanently-failed row is KEPT and marked `failed`, surfaced by the
//    crew shell's failed-sync banner with a retry, rather than dropping out
//    of the query with its blob orphaned and no signal anywhere.
//  - The blob is only garbage-collected once the row is genuinely finished
//    with (uploaded, discarded, or pruned by lib/dexie/prune.ts) — never
//    while a retry affordance still points at it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getDexieDb, type PendingPhotoUploadRow } from './schema'
import { computeNextAttemptAt, enqueueMutation } from './syncService'
import { getPendingPhotoBlob, deletePendingPhotoBlob } from './photo-queue'
import { isOnline, withTabLock, classifyUploadFailure, UploadDataError } from './net'
import { hasAnyOrgPrefix, orgScopedStoragePath } from '../storage/object-path'

const MAX_RETRIES = 5

// Closed allowlist of valid (table, column) targets — target_table/column
// are never user input (only ever written by this codebase's own queueing
// code), but validated here anyway before being used.
const ALLOWED_TARGETS: Record<string, string> = {
  checklist_instance_items: 'photo_storage_path',
  checklist_instances:      'section_photo_path',
  property_assets:          'photo_url',
}

let processing = false

/**
 * Removes a queued photo and its underlying blob. Only call once the row is
 * genuinely finished with — a row still offering a retry in the UI must keep
 * its blob, or "Retry" would have nothing left to upload.
 */
export async function discardPendingPhoto(userId: string, row: Pick<PendingPhotoUploadRow, 'id' | 'local_blob_key'>): Promise<void> {
  const db = getDexieDb(userId)
  await db.pending_photo_uploads.delete(row.id)
  try {
    await deletePendingPhotoBlob(userId, row.local_blob_key)
  } catch (blobErr) {
    console.warn('[photo-sync] Failed to delete photo blob:', blobErr)
  }
}

/**
 * Re-queues photos that exhausted their retries (marked `failed` rather
 * than dropped — see the module doc above). Mirrors
 * retryFailedMutation() in helpers.ts.
 */
export async function retryFailedPhotoUploads(
  supabase: SupabaseClient,
  userId: string,
  targetId?: string,
): Promise<void> {
  const db = getDexieDb(userId)
  const failed = (await db.pending_photo_uploads.toArray())
    .filter((row) => row.failed && (targetId === undefined || row.target_id === targetId))

  for (const row of failed) {
    await db.pending_photo_uploads.update(row.id, {
      failed:              false,
      retry_count:         0,
      network_retry_count: 0,
      next_attempt_at:     0,
      last_error:          '',
    })
  }

  void processPendingPhotoUploads(supabase, userId)
}

async function applyUploadedPath(
  userId: string,
  row: PendingPhotoUploadRow,
): Promise<void> {
  const db = getDexieDb(userId)

  if (row.target_table === 'checklist_instance_items') {
    await db.checklist_instance_items.update(row.target_id, { photo_storage_path: row.storage_path })
    await enqueueMutation(userId, 'checklist_instance_items', row.target_id, 'PATCH', {
      photo_storage_path: row.storage_path,
    })
    return
  }

  if (row.target_table === 'checklist_instances') {
    await db.checklist_instances.update(row.target_id, { section_photo_path: row.storage_path ?? '' })
    await enqueueMutation(userId, 'checklist_instances', row.target_id, 'PATCH', {
      section_photo_path: row.storage_path,
    })
    return
  }

  // property_assets.photo_url stores the BARE object key, same as the two
  // targets above. It used to hold a getPublicUrl() result, but turnover-photos
  // is a private bucket now: a public URL 400s and a signed one expires, so the
  // stable key is what gets persisted and readers sign it on demand.
  await db.property_assets.update(row.target_id, { photo_url: row.storage_path! })
  await enqueueMutation(userId, 'property_assets', row.target_id, 'PATCH', {
    photo_url:   row.storage_path,
    scanRequest: { storagePath: row.storage_path, mediaType: 'image/jpeg' },
  })
}

/**
 * Reads the owning org id out of the local cache, via the row this photo is
 * attached to. `crew_members` is not a Dexie store (dropped in a later schema
 * version), so the target row is the only local source.
 */
async function resolveTargetOrgId(userId: string, row: PendingPhotoUploadRow): Promise<string | null> {
  const db = getDexieDb(userId)

  if (row.target_table === 'property_assets') {
    return (await db.property_assets.get(row.target_id))?.org_id ?? null
  }
  if (row.target_table === 'checklist_instances') {
    return (await db.checklist_instances.get(row.target_id))?.org_id ?? null
  }

  const item = await db.checklist_instance_items.get(row.target_id)
  if (!item) return null
  return (await db.checklist_instances.get(item.instance_id))?.org_id ?? null
}

/**
 * Repairs a queued photo whose path predates the `${org_id}/` prefix
 * contract (queued on this device before the app updated).
 *
 * turnover-photos is private and its RLS policies match on the first path
 * segment, so a legacy path can never upload successfully — it would burn
 * five retries and dead-letter with the blob still sitting in IndexedDB.
 * The org id is recoverable locally from the crew member's own synced row,
 * so re-prefix the path instead of losing the evidence.
 *
 * Returns the path to upload to, or null when the org id isn't available
 * locally yet (rare, and transient — the next safety poll fixes it).
 */
async function orgPrefixedUploadPath(
  userId: string,
  row:    PendingPhotoUploadRow,
): Promise<string | null> {
  const path = row.storage_path!
  if (hasAnyOrgPrefix(path)) return path

  const db = getDexieDb(userId)
  const orgId = await resolveTargetOrgId(userId, row)
  if (!orgId) return null

  const repaired = orgScopedStoragePath(orgId, path)
  await db.pending_photo_uploads.update(row.id, { storage_path: repaired })
  row.storage_path = repaired
  console.warn(`[photo-sync] photo ${row.id} had a legacy (pre-org-prefix) path — re-targeted to ${repaired}`)
  return repaired
}

/**
 * Records one failed photo upload. Transport failures cost no retry budget
 * and can never dead-letter; server rejections do, exactly as in the
 * mutation outbox.
 */
async function recordPhotoFailure(userId: string, row: PendingPhotoUploadRow, err: unknown): Promise<void> {
  const db = getDexieDb(userId)
  const kind = classifyUploadFailure(err)

  if (kind === 'network') {
    const level = (row.network_retry_count ?? 0) + 1
    console.warn(
      `[photo-sync] photo ${row.id} could not reach storage ` +
      `(transport attempt ${level}) — retrying, retry budget untouched`
    )
    await db.pending_photo_uploads.update(row.id, {
      network_retry_count: level,
      next_attempt_at:     computeNextAttemptAt(level, Date.now()),
    })
    return
  }

  const retryCount = row.retry_count + 1
  const message = err instanceof Error ? err.message.slice(0, 200) : 'Unknown error'
  console.error(`[photo-sync] photo ${row.id} upload failed (attempt ${retryCount}, ${kind}):`, err)

  if (kind === 'terminal' || retryCount >= MAX_RETRIES) {
    // Dead-letter: keep BOTH the row and its blob so the crew shell's
    // failed-sync surface can offer a real retry. lib/dexie/prune.ts is what
    // eventually collects one the crew never acts on.
    await db.pending_photo_uploads.update(row.id, {
      retry_count: retryCount,
      failed:      true,
      last_error:  message,
    })
    return
  }

  await db.pending_photo_uploads.update(row.id, {
    retry_count:     retryCount,
    next_attempt_at: computeNextAttemptAt(retryCount, Date.now()),
  })
}

export async function processPendingPhotoUploads(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  if (processing) return  // avoid overlapping runs (interval + 'online' event firing close together)
  processing = true
  try {
    await withTabLock(`fieldstay-crew-photos-${userId}`, () => drainPhotoQueue(supabase, userId))
  } finally {
    processing = false
  }
}

async function drainPhotoQueue(supabase: SupabaseClient, userId: string): Promise<void> {
  // Offline: attempting is pointless and, worse, used to burn the retry
  // budget for an attempt that never left the device.
  if (!isOnline()) return

  const db = getDexieDb(userId)
  const now = Date.now()
  const pending = (await db.pending_photo_uploads.toArray())
    .filter((row) => !row.failed && (row.next_attempt_at ?? 0) <= now)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))

  for (const row of pending) {
    if (!isOnline()) return

    if (ALLOWED_TARGETS[row.target_table] !== row.target_column) {
      console.error(`[photo-sync] Unexpected target ${row.target_table}.${row.target_column} — dropping`)
      await discardPendingPhoto(userId, row)
      continue
    }

    const blob = await getPendingPhotoBlob(userId, row.local_blob_key)
    if (!blob) {
      // Blob missing (cleared browser storage, etc.) — nothing to upload
      await db.pending_photo_uploads.delete(row.id)
      continue
    }

    const uploadPath = await orgPrefixedUploadPath(userId, row)
    if (!uploadPath) {
      // Not a failure of this attempt — the crew member's own row hasn't
      // synced yet, so there's no org id to build a policy-visible path
      // from. Leave the row untouched (retry budget included) and let the
      // next tick, once the sync has landed, deal with it.
      console.warn(`[photo-sync] photo ${row.id}: org id not available locally yet — deferring`)
      continue
    }

    try {
      // Compression in photo-queue.ts always re-encodes to JPEG regardless
      // of the original capture format — upload with that content type
      // rather than the original file's row.mime_type, which may say
      // image/heic or similar and no longer match the actual bytes.
      const { error } = await supabase.storage
        .from('turnover-photos')
        .upload(uploadPath, blob, { contentType: 'image/jpeg', upsert: true })
      if (error) throw new UploadDataError(`photo upload failed: ${error.message}`)

      await applyUploadedPath(userId, row)
      await discardPendingPhoto(userId, row)
    } catch (err) {
      await recordPhotoFailure(userId, row, err)
    }
  }
}
