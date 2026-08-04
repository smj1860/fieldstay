import { unwrap } from '@/lib/supabase/unwrap'
import { notFound } from 'next/navigation'
import { Archivo, Source_Serif_4 } from 'next/font/google'
import { createServiceClient } from '@/lib/supabase/server'
import { MediaKitClient } from './media-kit-client'
import type { GuidebookSponsor } from '@/types/database'

const archivo = Archivo({
  subsets: ['latin'],
  weight:  ['500', '600', '700', '800', '900'],
  variable: '--font-archivo',
  display: 'swap',
})

const sourceSerif4 = Source_Serif_4({
  subsets: ['latin'],
  weight:  ['400', '600'],
  variable: '--font-source-serif',
  display: 'swap',
})

export default async function MediaKitPage({
  params,
}: {
  params: Promise<{ media_kit_token: string }>
}) {
  const { media_kit_token } = await params
  const supabase = createServiceClient({ publicSurface: 'g-kit--media-kit-token-' })

  // Token-gated public page: a failed read used to fall into notFound(),
  // telling the sponsor their media-kit link is dead. Throw to the error
  // boundary instead so an outage doesn't read as an invalid token.
  const sponsorRes = await supabase
    .from('guidebook_sponsors')
    .select('id, status, business_name, business_description, custom_offer_text, address, media_kit_token, slot_type, slot_context, offer_type, offer_value, offer_item')
    .eq('media_kit_token', media_kit_token)
    .maybeSingle()

  const sponsor = unwrap(sponsorRes, { site: 'page.media-kit' })
  if (!sponsor) notFound()

  return (
    <div className={`${archivo.variable} ${sourceSerif4.variable}`}>
      <MediaKitClient sponsor={sponsor as GuidebookSponsor} />
    </div>
  )
}
