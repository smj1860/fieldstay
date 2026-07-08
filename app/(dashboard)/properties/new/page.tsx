import type { Metadata } from 'next'
import { NewPropertyForm } from './new-property-form'
import { Card } from '@/components/ui/Card'

export const metadata: Metadata = { title: 'Add Property' }

export default function NewPropertyPage() {
  return (
    <div className="max-w-2xl">
      <div className="page-header">
        <h1 className="page-title">Add Property</h1>
        <p className="page-subtitle">
          Basic details first — you&apos;ll set up inventory, checklists, and more in the next steps.
        </p>
      </div>
      <Card>
        <NewPropertyForm />
      </Card>
    </div>
  )
}
