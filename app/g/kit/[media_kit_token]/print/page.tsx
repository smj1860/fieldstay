import { notFound } from 'next/navigation'
import { Archivo, Source_Serif_4 } from 'next/font/google'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrap } from '@/lib/supabase/unwrap'
import { PrintKit } from './print-kit'
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

export default async function PrintKitPage({
  params,
}: {
  params: Promise<{ media_kit_token: string }>
}) {
  const { media_kit_token } = await params
  const supabase = createServiceClient({ publicSurface: 'g-kit--media-kit-token-print' })

  const sponsorRes = await supabase
    .from('guidebook_sponsors')
    .select('id, status, business_name, business_description, custom_offer_text, address, media_kit_token, slot_type, slot_context, offer_type, offer_value, offer_item, org_id')
    .eq('media_kit_token', media_kit_token)
    .maybeSingle()
  const sponsor = unwrap(sponsorRes, { site: 'page.g.kit.print' })

  if (!sponsor) notFound()

  const orgRes = await supabase
    .from('organizations')
    .select('name')
    .eq('id', sponsor.org_id)
    .maybeSingle()
  const org = unwrap(orgRes, { site: 'page.g.kit.print', orgId: sponsor.org_id })

  const kitUrl = `${process.env.NEXT_PUBLIC_APP_URL}/g/kit/${sponsor.media_kit_token}`

  return (
    <div className={`${archivo.variable} ${sourceSerif4.variable}`}>
      <PrintKit
        sponsor={sponsor as GuidebookSponsor}
        orgName={org?.name ?? null}
        kitUrl={kitUrl}
      />
    </div>
  )
}
