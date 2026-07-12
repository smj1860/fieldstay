import type { Metadata } from 'next'
import { HomepageContent } from '@/components/landing/homepage-content'

export const metadata: Metadata = {
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
