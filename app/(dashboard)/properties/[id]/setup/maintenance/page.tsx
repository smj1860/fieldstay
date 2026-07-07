import { requireProperty } from '@/lib/auth'
import { MaintenanceSetupStep } from './maintenance-form'
import { Card } from '@/components/ui/Card'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Maintenance Schedule' }
interface Props { params: Promise<{ id: string }> }

export default async function MaintenancePage({ params }: Props) {
  const { id } = await params
  await requireProperty(id)

  return (
    <Card>
      <MaintenanceSetupStep propertyId={id} />
    </Card>
  )
}
