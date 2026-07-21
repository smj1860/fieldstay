import { requireProperty } from '@/lib/auth'
import { InventoryStepPointer } from './inventory-step-pointer'
import { Card } from '@/components/ui/Card'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Inventory Setup' }

interface Props { params: Promise<{ id: string }> }

export default async function InventoryPage({ params }: Props) {
  const { id } = await params
  const { property } = await requireProperty(id)

  return (
    <Card>
      <InventoryStepPointer propertyId={property.id} />
    </Card>
  )
}
