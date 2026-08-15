import { notFound } from 'next/navigation'
import localFont from 'next/font/local'
import { createServiceClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/validation/uuid'
import { unwrap } from '@/lib/supabase/unwrap'
import { PrintKit } from './print-kit'
import type { GuidebookSponsor } from '@/types/database'

// Self-hosted — see the note in app/layout.tsx for why these are not
// next/font/google. Latin subset of each VARIABLE font, so one file covers
// every weight this page asks for.
const archivo = localFont({
  src:      '../../../../fonts/archivo-latin-var.woff2',
  variable: '--font-archivo',
  display:  'swap',
  // Covers the 500-900 range this page uses; the file is the full axis.
  weight:   '100 900',
})

const sourceSerif4 = localFont({
  src:      '../../../../fonts/source-serif-4-latin-var.woff2',
  variable: '--font-source-serif',
  display:  'swap',
  // Covers the 400/600 this page uses.
  weight:   '200 900',
})

export default async function PrintKitPage({
  params,
}: {
  params: Promise<{ media_kit_token: string }>
}) {
  const { media_kit_token } = await params

  // Same shape check as the non-print page — media_kit_token is a `uuid`, so a
  // malformed one is 22P02, which unwrap() escalates to the error boundary
  // rather than the 404 an invalid link deserves.
  if (!isUuid(media_kit_token)) notFound()

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
