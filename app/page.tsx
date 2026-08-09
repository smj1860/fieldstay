import type { Metadata } from 'next'
import { HomepageContent } from '@/components/landing/homepage-content'
import { marketingUrl } from '@/lib/marketing'

export const metadata: Metadata = {
  // Absolute apex canonical. fieldstay.app and app.fieldstay.app are
  // aliases of one deployment, so this page exists at two URLs; without
  // this Google picks a winner itself, and a relative value would resolve
  // against metadataBase (NEXT_PUBLIC_APP_URL) to the wrong one.
  alternates: { canonical: marketingUrl('/') },
  title: 'FieldStay — Property Operations for Short-Term Rental Managers',
  description: 'FieldStay handles crew scheduling, turnovers, maintenance, inventory, vendor work orders, and guest communications for STR property managers.',
  openGraph: {
    title: 'FieldStay — Property Operations for Short-Term Rental Managers',
    description: 'The operations layer for the work that happens between checkouts.',
    images: ['/logo.png'],
  },
}

export default function HomePage() {
  return <HomepageContent />
}
