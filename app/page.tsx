import type { Metadata } from 'next'
import { HomepageContent } from '@/components/landing/homepage-content'
import { marketingUrl, marketingOrigin } from '@/lib/marketing'
import { buildJsonLd, serializeJsonLd } from './json-ld'

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
    <>
      <script type="application/ld+json">{serializeJsonLd(buildJsonLd(marketingOrigin()))}</script>
      <HomepageContent />
    </>
  )
}
