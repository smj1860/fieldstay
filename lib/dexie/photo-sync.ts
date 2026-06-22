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
        continue
      }

      const blob = await getPendingPhotoBlob(row.local_blob_key)
      if (!blob) {
        // Blob missing (cleared browser storage, etc.) — nothing to upload
        await db.pending_photo_uploads.delete(row.id)
        continue
      }

      const { error } = await supabase.storage
        .from('turnover-photos')
        .upload(row.storage_path!, blob, { contentType: row.mime_type, upsert: true })

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
        // NOTE: SyncEngine has no upstream handler for checklist_instances —
        // this mirrors a pre-existing gap in the old PowerSync connector,
        // which also had no case for this table. section_photo_path is
        // updated locally but does not currently reach Supabase.
        await db.checklist_instances.update(row.target_id, { section_photo_path: row.storage_path ?? '' })
      }

      await db.pending_photo_uploads.delete(row.id)
      await deletePendingPhotoBlob(row.local_blob_key)
    }
  } finally {
    processing = false
  }
}
