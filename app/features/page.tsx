import localFont from 'next/font/local'
import type { Metadata } from 'next'
import { FeaturesContent } from '@/components/landing/features-content'
import { marketingUrl } from '@/lib/marketing'

// Scoped to this route, same pattern as app/page.tsx and app/why-fieldstay.
// Both faces are drawn with here: Archivo for headings and UI, Source Serif for
// the running prose.
const archivo = localFont({
  src: '../fonts/archivo-latin-var.woff2', variable: '--font-archivo', display: 'swap', weight: '100 900',
})
const sourceSerif4 = localFont({
  src: '../fonts/source-serif-4-latin-var.woff2', variable: '--font-source-serif', display: 'swap', weight: '200 900',
})

export const metadata: Metadata = {
  alternates: { canonical: marketingUrl('/features') },
  title: 'Features',
  description: 'Turnovers, an offline crew app, maintenance and vendor portals, self-correcting inventory, owner P&L, asset health and CapEx, guest guidebooks. Every feature is in every plan.',
  openGraph: {
    title: 'FieldStay Features',
    description: 'Everything FieldStay does, and it is all in every plan.',
  },
}

export default function FeaturesPage() {
  return (
    <div className={`${archivo.variable} ${sourceSerif4.variable}`}>
      <FeaturesContent />
    </div>
  )
}
