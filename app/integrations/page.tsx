import localFont from 'next/font/local'
import type { Metadata } from 'next'
import { IntegrationsContent } from '@/components/landing/integrations-content'
import { marketingUrl } from '@/lib/marketing'

// Scoped to this route, same pattern as app/page.tsx, /why-fieldstay and
// /features. Both faces are drawn with here: Archivo for headings and UI,
// Source Serif for the running prose.
const archivo = localFont({
  src: '../fonts/archivo-latin-var.woff2', variable: '--font-archivo', display: 'swap', weight: '100 900',
})
const sourceSerif4 = localFont({
  src: '../fonts/source-serif-4-latin-var.woff2', variable: '--font-source-serif', display: 'swap', weight: '200 900',
})

export const metadata: Metadata = {
  alternates: { canonical: marketingUrl('/integrations') },
  title: 'Integrations',
  description: 'FieldStay connects to OwnerRez, Hospitable, Hostex, Hostaway, Lodgify and iCal for reservations, Stripe and Stripe Connect for payments, Resend for email and Telnyx for text. Guesty and Uplisting are coming soon.',
  openGraph: {
    title: 'FieldStay Integrations',
    description: 'Five PMS platforms, iCal, Stripe, Resend and Telnyx. Guesty and Uplisting coming soon.',
  },
}

export default function IntegrationsPage() {
  return (
    <div className={`${archivo.variable} ${sourceSerif4.variable}`}>
      <IntegrationsContent />
    </div>
  )
}
