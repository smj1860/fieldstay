import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/observability/report-error'
import { orgScopedStoragePath } from '@/lib/storage/object-path'
import { compressPhoto } from '@/lib/images/compress'
import { describeCapture, type CaptureMetadata } from '@/lib/evidence/capture'

export type FlagPhotoUploadResult =
  | { ok: true;  path: string; capture: CaptureMetadata }
  | { ok: false; error: string }

/**
 * Uploads a quick-flag photo to Storage under this turnover's folder.
 *
 * The upload error used to be discarded entirely — no check, no log, no
 * return value — so a denied or failed upload (the `turnover-photos` bucket
 * has no storage policies today; see the pre-launch audit's H2) made flag
 * photos vanish with zero signal to anyone, including Sentry.
 *
 * Returns a result rather than throwing so an existing caller can't be
 * turned into an unhandled rejection, but a failure is now genuinely
 * observable: logged, reported, and reflected in the return value the
 * caller is expected to surface to the user.
 *
 * `orgId` is REQUIRED and is the first path segment: the turnover-photos
 * storage RLS policies match on it (public.storage_org_prefix), and the
 * bucket is private, so a path without it is denied on write and unsignable
 * on read.
 */
export async function flagPhotoUpload(orgId: string, turnoverId: string, file: File): Promise<FlagPhotoUploadResult> {
  const supabase = createClient()
  const ext  = 'jpg'
  // UUID, not Date.now(): two flag photos in the same millisecond overwrote
  // each other. And the bytes are re-encoded to JPEG below, so the stored
  // object is always .jpg whatever the camera produced.
  const path = orgScopedStoragePath(orgId, `turnover-${turnoverId}`, `flag-${crypto.randomUUID()}.${ext}`)
  const compressed = await compressPhoto(file)
  const capture    = await describeCapture(compressed)
  const { error } = await supabase.storage
    .from('turnover-photos')
    .upload(path, compressed, { contentType: 'image/jpeg', upsert: false })
  if (error) {
    console.error('[flagPhotoUpload] upload failed:', error.message)
    reportError(error, { site: 'lib.turnovers.flagPhotoUpload' })
    return { ok: false, error: error.message }
  }
  return { ok: true, path, capture }
}
