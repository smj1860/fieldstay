import { requireProperty } from '@/lib/auth'
import { MaintenanceSetupStep } from './maintenance-form'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Maintenance Schedule' }
interface Props { params: Promise<{ id: string }> }

export default async function MaintenancePage({ params }: Props) {
  const { id } = await params
  await requireProperty(id)

  return (
    <div className="card">
      <MaintenanceSetupStep propertyId={id} />
    </div>
  )
}
