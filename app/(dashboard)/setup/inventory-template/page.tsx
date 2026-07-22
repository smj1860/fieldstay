import Link from 'next/link'
import { markStepComplete } from '../actions'
import { Button } from '@/components/ui/Button'

export default async function OnboardingInventoryTemplatePage() {
  async function continueAction() {
    'use server'
    await markStepComplete('inventory_template', '/setup/checklist-template')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Inventory
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Unlike the turnover checklist, supply lists aren&apos;t built for you
          automatically — there&apos;s less to set up here right now.
        </p>
        <div className="mt-4 rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
            Your org starts with an editable copy of the FieldStay starter
            supply list, ready to customize under{' '}
            <Link href="/templates/inventory" className="underline font-medium" style={{ color: 'var(--accent-gold)' }}>
              Templates → Inventory
            </Link>
            . Build a template from it whenever convenient, then set par
            levels per property — no auto-apply, so nothing changes on a
            property until you assign one.
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
