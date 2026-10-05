import localFont from 'next/font/local'
import type { Metadata } from 'next'
import { AboutContent } from '@/components/landing/about-content'
import { marketingUrl } from '@/lib/marketing'

// Scoped to this route, same pattern as the other editorial pages. Both faces
// are drawn with here: Archivo for headings and UI, Source Serif for prose.
const archivo = localFont({
  src: '../fonts/archivo-latin-var.woff2', variable: '--font-archivo', display: 'swap', weight: '100 900',
})
const sourceSerif4 = localFont({
  src: '../fonts/source-serif-4-latin-var.woff2', variable: '--font-source-serif', display: 'swap', weight: '200 900',
})

export const metadata: Metadata = {
  alternates: { canonical: marketingUrl('/about') },
  title: 'About',
  description: 'FieldStay is built by two people who ran hospitality operations and logistics before they built software. Who we are, why we started it, who we answer to, and where we are.',
  openGraph: {
    title: 'About FieldStay',
    description: 'Built by two people who came from operations, not software. Short-term rental property operations, from rural Alabama.',
  },
}

export default function AboutPage() {
  return (
    <div className={`${archivo.variable} ${sourceSerif4.variable}`}>
      <AboutContent />
    </div>
  )
}
