'use server'

import { createServiceClient } from '@/lib/supabase/server'

const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED   = new Set(['image/jpeg', 'image/png', 'image/webp'])

export async function uploadSponsorPhoto(
  mediaKitToken: string,
  photo: File
): Promise<{ error: string } | { photoStoragePath: string }> {
  if (!ALLOWED.has(photo.type)) {
    return { error: 'Please upload a JPG, PNG, or WEBP image.' }
  }
  if (photo.size > MAX_BYTES) {
    return { error: 'Image must be under 5MB.' }
  }

  const supabase = createServiceClient()

  const { data: sponsor, error: lookupErr } = await supabase
    .from('guidebook_sponsors')
    .select('id, photo_storage_path')
    .eq('media_kit_token', mediaKitToken)
    .maybeSingle()

  if (lookupErr || !sponsor) {
    return { error: 'Could not find this sponsor listing. Refresh and try again.' }
  }

  const ext  = photo.type === 'image/png' ? 'png' : photo.type === 'image/webp' ? 'webp' : 'jpg'
  const path = `sponsors/${sponsor.id}/${crypto.randomUUID()}.${ext}`

  const { error: uploadErr } = await supabase.storage
    .from('guidebook-sponsor-photos')
    .upload(path, photo, { contentType: photo.type, upsert: false })

  if (uploadErr) {
    console.error('[uploadSponsorPhoto] upload failed', uploadErr)
    return { error: 'Upload failed. Please try again.' }
  }

  // Clean up the previous photo if replacing one — avoid orphaned files piling up in the bucket.
  if (sponsor.photo_storage_path) {
    const { error: removeErr } = await supabase.storage
      .from('guidebook-sponsor-photos')
      .remove([sponsor.photo_storage_path])
    if (removeErr) console.error('[uploadSponsorPhoto] cleanup of old photo failed', removeErr)
  }

  const { error: updateErr } = await supabase
    .from('guidebook_sponsors')
    .update({ photo_storage_path: path })
    .eq('id', sponsor.id)

  if (updateErr) {
    console.error('[uploadSponsorPhoto] db update failed', updateErr)
    // The file is already uploaded at this point — don't leave the DB out of sync silently.
    await supabase.storage.from('guidebook-sponsor-photos').remove([path])
    return { error: 'Could not save your photo. Please try again.' }
  }

  return { photoStoragePath: path }
}

export async function removeSponsorPhoto(
  mediaKitToken: string
): Promise<{ error: string } | { success: true }> {
  const supabase = createServiceClient()

  const { data: sponsor, error: lookupErr } = await supabase
    .from('guidebook_sponsors')
    .select('id, photo_storage_path')
    .eq('media_kit_token', mediaKitToken)
    .maybeSingle()

  if (lookupErr || !sponsor) {
    return { error: 'Could not find this sponsor listing. Refresh and try again.' }
  }
  if (!sponsor.photo_storage_path) {
    return { success: true }
  }

  await supabase.storage
    .from('guidebook-sponsor-photos')
    .remove([sponsor.photo_storage_path])

  const { error: updateErr } = await supabase
    .from('guidebook_sponsors')
    .update({ photo_storage_path: null })
    .eq('id', sponsor.id)

  if (updateErr) {
    console.error('[removeSponsorPhoto] db update failed', updateErr)
    return { error: 'Could not remove your photo. Please try again.' }
  }

  return { success: true }
}
