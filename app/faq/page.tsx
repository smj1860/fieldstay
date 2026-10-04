import localFont from 'next/font/local'
import type { Metadata } from 'next'
import { FaqContent } from '@/components/landing/faq-content'
import { marketingUrl, marketingOrigin } from '@/lib/marketing'
import { buildJsonLd, serializeJsonLd } from './json-ld'

// Scoped to this route, same pattern as app/page.tsx, /why-fieldstay,
// /features and /integrations. Both faces are drawn with here: Archivo for
// headings and UI, Source Serif for the running prose.
const archivo = localFont({
  src: '../fonts/archivo-latin-var.woff2', variable: '--font-archivo', display: 'swap', weight: '100 900',
})
const sourceSerif4 = localFont({
  src: '../fonts/source-serif-4-latin-var.woff2', variable: '--font-source-serif', display: 'swap', weight: '200 900',
})

export const metadata: Metadata = {
  alternates: { canonical: marketingUrl('/faq') },
  title: 'FAQ',
  description: 'What FieldStay costs, how it connects to your PMS, what your crew and your property owners can see, and how your data is handled. Twelve common questions, answered plainly.',
  openGraph: {
    title: 'FieldStay FAQ',
    description: 'Pricing, PMS sync, crew access, owner reporting and data security. The twelve questions that come up most.',
  },
}

export default function FaqPage() {
  return (
    <div className={`${archivo.variable} ${sourceSerif4.variable}`}>
      {/* serializeJsonLd, not dangerouslySetInnerHTML: this repo has zero uses
          of that prop and an ESLint rule keeping it that way. Same injection
          pattern as every other landing page. */}
      <script type="application/ld+json">{serializeJsonLd(buildJsonLd(marketingOrigin()))}</script>
      <FaqContent />
    </div>
  )
}
