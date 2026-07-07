import { requireProperty } from '@/lib/auth'
import { DetailsForm } from './details-form'
import { Card } from '@/components/ui/Card'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Property Details' }

interface Props { params: Promise<{ id: string }> }

export default async function DetailsPage({ params }: Props) {
  const { id } = await params
  const { property } = await requireProperty(id)
  return (
    <Card>
      <h2 className="text-lg font-semibold text-primary-themed mb-1">Property Details</h2>
      <p className="text-sm text-accent-500 mb-6">Name, address, check-in/out times, and access info.</p>
      <DetailsForm property={property} />
    </Card>
  )
}
