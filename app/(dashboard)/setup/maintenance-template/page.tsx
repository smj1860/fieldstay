import Link from 'next/link'
import { markStepComplete } from '../actions'
import { Button } from '@/components/ui/Button'

export default async function OnboardingMaintenanceTemplatePage() {
  async function continueAction() {
    'use server'
    await markStepComplete('maintenance_template', '/setup/power-ups')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Scheduled Maintenance
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          A real 36-item FieldStay standard schedule is already available to
          apply as-is, or as a starting point for your own.
        </p>
        <div className="mt-4 rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
            Build and manage recurring maintenance templates under{' '}
            <Link href="/templates/maintenance" className="underline font-medium" style={{ color: 'var(--accent-gold)' }}>
              Templates → Scheduled Maintenance
            </Link>
            . Apply the standard schedule or a custom one to any property
            whenever convenient — nothing here needs to be built before you
            continue.
          </p>
        </div>
      </div>

      <div className="pt-4 border-t border-themed">
        <form action={continueAction}>
          <Button type="submit">
            Save &amp; Continue →
          </Button>
        </form>
      </div>
    </div>
  )
}
