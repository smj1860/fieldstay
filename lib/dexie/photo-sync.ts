// lib/dexie/photo-sync.ts
//
// Drains the pending_photo_uploads queue: attempts each queued photo's
// Supabase Storage upload, and on success writes the resulting path to the
// local Dexie row and queues a mutation so it reaches Supabase too — Dexie
// has no equivalent of PowerSync's automatic CRUD-queue tracking, so every
// local write that needs to reach the server has to be queued explicitly.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getDexieDb } from './schema'
import { enqueueMutation } from './syncService'
import { getPendingPhotoBlob, deletePendingPhotoBlob } from './photo-queue'

const MAX_RETRIES = 5

// Closed allowlist of valid (table, column) targets — target_table/column
// are never user input (only ever written by this codebase's own queueing
// code), but validated here anyway before being used.
const ALLOWED_TARGETS: Record<string, string> = {
  checklist_instance_items: 'photo_storage_path',
  checklist_instances:      'section_photo_path',
}

let processing = false

export async function processPendingPhotoUploads(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  if (processing) return  // avoid overlapping runs (interval + 'online' event firing close together)
  processing = true

  try {
    const db = getDexieDb(userId)
    const pending = await db.pending_photo_uploads
      .where('retry_count').below(MAX_RETRIES)
      .sortBy('created_at')

    for (const row of pending) {
      if (ALLOWED_TARGETS[row.target_table] !== row.target_column) {
        console.error(`[photo-sync] Unexpected target ${row.target_table}.${row.target_column} — dropping`)
        await db.pending_photo_uploads.delete(row.id)
        // Remove the underlying blob so it doesn't accumulate as dead storage
        try {
          await deletePendingPhotoBlob(userId, row.local_blob_key)
        } catch (blobErr) {
          console.warn('[photo-sync] Failed to delete orphaned blob:', blobErr)
        }
        continue
      }

      const blob = await getPendingPhotoBlob(userId, row.local_blob_key)
      if (!blob) {
        // Blob missing (cleared browser storage, etc.) — nothing to upload
        await db.pending_photo_uploads.delete(row.id)
        continue
      }

      // Compression in photo-queue.ts always re-encodes to JPEG regardless
      // of the original capture format — upload with that content type
      // rather than the original file's row.mime_type, which may say
      // image/heic or similar and no longer match the actual bytes.
      const { error } = await supabase.storage
        .from('turnover-photos')
        .upload(row.storage_path!, blob, { contentType: 'image/jpeg', upsert: true })

      if (error) {
        await db.pending_photo_uploads.update(row.id, { retry_count: row.retry_count + 1 })
        continue
      }

      if (row.target_table === 'checklist_instance_items') {
        await db.checklist_instance_items.update(row.target_id, { photo_storage_path: row.storage_path })
        await enqueueMutation(userId, 'checklist_instance_items', row.target_id, 'PATCH', {
          photo_storage_path: row.storage_path,
        })
      } else if (row.target_table === 'checklist_instances') {
        await db.checklist_instances.update(row.target_id, { section_photo_path: row.storage_path ?? '' })
        await enqueueMutation(userId, 'checklist_instances', row.target_id, 'PATCH', {
          section_photo_path: row.storage_path,
        })
      }

      await db.pending_photo_uploads.delete(row.id)
      await deletePendingPhotoBlob(userId, row.local_blob_key)
    }
  } finally {
    processing = false
  }
}
