import { unwrap } from '@/lib/supabase/unwrap'
import { notFound } from 'next/navigation'
import { Archivo, Source_Serif_4 } from 'next/font/google'
import { createServiceClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/validation/uuid'
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

  // media_kit_token is a `uuid` column, so a malformed one is Postgres 22P02 —
  // which unwrap() turns into a throw and the segment error boundary renders
  // as "something went wrong". That is the exact inversion of the note below:
  // an outage must not read as an invalid token, but neither may a genuinely
  // invalid token read as an outage. Shape-check first and 404 it, so each of
  // the two failures gets its own honest surface.
  if (!isUuid(media_kit_token)) notFound()

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
