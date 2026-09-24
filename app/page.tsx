import localFont from 'next/font/local'
import type { Metadata } from 'next'
import { HomepageContent } from '@/components/landing/homepage-content'
import { marketingUrl, marketingOrigin } from '@/lib/marketing'
import { buildJsonLd, serializeJsonLd } from './json-ld'

// Self-hosted — see the note in app/layout.tsx for why these are not
// next/font/google. Same pair, same pattern, as app/g/kit/[media_kit_token]
// /page.tsx: one variable-font file each, scoped to this route only (the
// global layout only loads Inter, via --font-inter). font-display in
// tailwind.config.ts stays mapped to var(--font-inter) — this page reaches
// the Archivo/Source Serif weights directly via var(--font-archivo) and
// var(--font-source-serif) in inline styles inside HomepageContent, not
// through the font-display utility class.
const archivo = localFont({
  src:      './fonts/archivo-latin-var.woff2',
  variable: '--font-archivo',
  display:  'swap',
  // Covers the 500-900 range this page uses; the file is the full axis.
  weight:   '100 900',
})

const sourceSerif4 = localFont({
  src:      './fonts/source-serif-4-latin-var.woff2',
  variable: '--font-source-serif',
  display:  'swap',
  // Covers the 400/600 this page uses.
  weight:   '200 900',
})

export const metadata: Metadata = {
  // Absolute apex canonical. fieldstay.app and app.fieldstay.app are
  // aliases of one deployment, so this page exists at two URLs; without
  // this Google picks a winner itself, and a relative value would resolve
  // against metadataBase (NEXT_PUBLIC_APP_URL) to the wrong one.
  alternates: { canonical: marketingUrl('/') },
  // UNLIKE every other page's title in this codebase, this one needs the
  // brand written out in full. The root layout's `title.template` only
  // applies to titles from CHILD route segments — a page.tsx co-located in
  // the SAME segment as the layout defining the template (this file and
  // app/layout.tsx both live directly under app/) never gets the template
  // applied to it at all. Verified against the actual prerendered
  // .next/server/app/index.html: a bare 'Property Ops for ...' string here
  // rendered with NO "— FieldStay" appended — an earlier version of this
  // comment claimed the opposite (that omitting the brand here avoided a
  // double-suffix) and was wrong for this one page specifically, unlike
  // /ownerrez, /hospitable, and /hosts, which really do get the suffix
  // auto-appended since their page.tsx files live one segment below layout.tsx.
  title: 'Property Ops for Short-Term Rental Managers — FieldStay',
  description: 'FieldStay handles crew scheduling, turnovers, maintenance, inventory, vendor work orders, and guest communications for STR property managers.',
  openGraph: {
    title: 'FieldStay — Property Operations for Short-Term Rental Managers',
    description: 'The operations layer for the work that happens between checkouts.',
    images: ['/logo.png'],
  },
}

export default function HomePage() {
  return (
    <div className={`${archivo.variable} ${sourceSerif4.variable}`}>
      <script type="application/ld+json">{serializeJsonLd(buildJsonLd(marketingOrigin()))}</script>
      <HomepageContent />
    </div>
  )
}
