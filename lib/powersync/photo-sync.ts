// lib/powersync/photo-sync.ts
//
// Drains the pending_photo_uploads queue: attempts each queued photo's
// Supabase Storage upload, and on success writes the resulting path to the
// real target row — the same local write the old synchronous code used to
// do inline — so it flows through the existing connector normally.

import type { AbstractPowerSyncDatabase } from '@powersync/common'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPendingPhotoBlob, deletePendingPhotoBlob } from './photo-queue'

const MAX_RETRIES = 5

// Closed allowlist of valid (table, column) targets — target_table/column
// are never user input (only ever written by this codebase's own queueing
// code), but validated here anyway before being interpolated into SQL.
const ALLOWED_TARGETS: Record<string, string> = {
  checklist_instance_items: 'photo_storage_path',
  checklist_instances:      'section_photo_path',
}

interface PendingUploadRow {
  id:             string
  target_table:   string
  target_id:      string
  target_column:  string
  storage_path:   string
  local_blob_key: string
  mime_type:      string
  retry_count:    number
}

let processing = false

export async function processPendingPhotoUploads(
  db: AbstractPowerSyncDatabase,
  supabase: SupabaseClient,
): Promise<void> {
  if (processing) return  // avoid overlapping runs (interval + 'online' event firing close together)
  processing = true

  try {
    const pending = await db.getAll<PendingUploadRow>(
      `SELECT * FROM pending_photo_uploads WHERE retry_count < ? ORDER BY created_at ASC`,
      [MAX_RETRIES]
    )

    for (const row of pending) {
      if (ALLOWED_TARGETS[row.target_table] !== row.target_column) {
        console.error(`[photo-sync] Unexpected target ${row.target_table}.${row.target_column} — dropping`)
        await db.execute('DELETE FROM pending_photo_uploads WHERE id = ?', [row.id])
        continue
      }

      const blob = await getPendingPhotoBlob(row.local_blob_key)
      if (!blob) {
        // Blob missing (cleared browser storage, etc.) — nothing to upload
        await db.execute('DELETE FROM pending_photo_uploads WHERE id = ?', [row.id])
        continue
      }

      const { error } = await supabase.storage
        .from('turnover-photos')
        .upload(row.storage_path, blob, { contentType: row.mime_type, upsert: true })

      if (error) {
        await db.execute(
          'UPDATE pending_photo_uploads SET retry_count = retry_count + 1 WHERE id = ?',
          [row.id]
        )
        continue
      }

      await db.execute(
        `UPDATE ${row.target_table} SET ${row.target_column} = ? WHERE id = ?`,
        [row.storage_path, row.target_id]
      )
      await db.execute('DELETE FROM pending_photo_uploads WHERE id = ?', [row.id])
      await deletePendingPhotoBlob(row.local_blob_key)
    }
  } finally {
    processing = false
  }
}
