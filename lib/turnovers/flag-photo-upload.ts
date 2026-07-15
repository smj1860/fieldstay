import { createClient } from '@/lib/supabase/client'

/** Uploads a quick-flag photo to Storage under this turnover's folder. */
export async function flagPhotoUpload(turnoverId: string, file: File): Promise<void> {
  const supabase = createClient()
  const ext  = file.name.split('.').pop() ?? 'jpg'
  const path = `turnover-${turnoverId}/flag-${Date.now()}.${ext}`
  await supabase.storage.from('turnover-photos').upload(path, file, { upsert: true })
}
