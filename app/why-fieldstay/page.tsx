import localFont from 'next/font/local'
import type { Metadata } from 'next'
import { WhyFieldStayContent } from '@/components/landing/why-fieldstay-content'
import { marketingUrl } from '@/lib/marketing'

// Self-hosted and scoped to this route only, the same pattern app/page.tsx
// uses: the global layout loads only Inter.
//
// Source Serif is loaded here because this page actually DRAWS with it: the
// letter's running prose is set in it. That is worth stating because
// app/page.tsx loads the same file and never uses it — its header comment says
// HomepageContent reaches the serif "in inline styles", and
// `grep -r 'font-source-serif' components/` returns nothing, so the homepage's
// headlines render in Inter (font-display maps to var(--font-inter)) and the
// serif is downloaded for no one. Measured on the rendered page. Headings here
// stay on font-display so they match the homepage's; bringing the serif to
// headings is a live decision for both pages at once.
const archivo = localFont({
  src:      '../fonts/archivo-latin-var.woff2',
  variable: '--font-archivo',
  display:  'swap',
  weight:   '100 900',
})

const sourceSerif4 = localFont({
  src:      '../fonts/source-serif-4-latin-var.woff2',
  variable: '--font-source-serif',
  display:  'swap',
  weight:   '200 900',
})

export const metadata: Metadata = {
  // Absolute apex canonical, same reason as every other marketing page: the
  // apex and app.fieldstay.app are aliases of one deployment, so this page
  // exists at two URLs and a relative value would resolve to the wrong one.
  alternates: { canonical: marketingUrl('/why-fieldstay') },
  title: 'Why FieldStay',
  description: 'No venture capital, no feature gates, no contract. Why a short-term rental manager should trust a new product with their operations, from the person who built it.',
  openGraph: {
    title: 'Why FieldStay',
    description: 'No venture capital, no feature gates, no contract. Written by the person who built it.',
  },
}

export default function WhyFieldStayPage() {
  return (
    <div className={`${archivo.variable} ${sourceSerif4.variable}`}>
      <WhyFieldStayContent />
    </div>
  )
}
