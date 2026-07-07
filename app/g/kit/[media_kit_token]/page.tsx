import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { MediaKitClient } from './media-kit-client'
import type { GuidebookSponsor } from '@/types/database'

export default async function MediaKitPage({
  params,
}: {
  params: Promise<{ media_kit_token: string }>
}) {
  const { media_kit_token } = await params
  const supabase = createServiceClient()

  const { data: sponsor } = await supabase
    .from('guidebook_sponsors')
    .select('id, status, business_name, business_description, custom_offer_text, address, media_kit_token, photo_storage_path')
    .eq('media_kit_token', media_kit_token)
    .maybeSingle()

  if (!sponsor) notFound()

  const photoUrl = sponsor.photo_storage_path
    ? supabase.storage.from('guidebook-sponsor-photos').getPublicUrl(sponsor.photo_storage_path).data.publicUrl
    : null

  return <MediaKitClient sponsor={sponsor as GuidebookSponsor} initialPhotoUrl={photoUrl} />
}
