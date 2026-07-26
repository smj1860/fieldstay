import Link from 'next/link'
import { markStepComplete } from '../actions'
import { Button } from '@/components/ui/Button'

export default async function OnboardingChecklistTemplatePage() {
  async function continueAction() {
    'use server'
    await markStepComplete('checklist_template', '/setup/maintenance-template')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Turnover Checklist
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Every property already has a real turnover checklist — nothing to
          set up to get started.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
            <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>Already done, automatically</p>
            <ul className="text-sm space-y-1.5" style={{ color: 'var(--text-primary)' }}>
              <li>• Whole Home — general tasks, every property</li>
              <li>• Kitchen — every property</li>
              <li>• Living Room — every property</li>
              <li>• Bedrooms &amp; Bathrooms — one section per room, from your PMS count</li>
            </ul>
          </div>
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
            <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>Your turn, anytime after this</p>
            <ul className="text-sm space-y-1.5" style={{ color: 'var(--text-primary)' }}>
              <li>• Add any other rooms a property needs (Office, Den, etc.) from the Properties page</li>
              <li>• Remove Kitchen and/or Living Room from any property that doesn&apos;t actually have one</li>
              <li>• We&apos;ll flag any property showing 0 bedrooms or no bathroom count, so you know to double-check it</li>
            </ul>
          </div>
        </div>
        <div className="mt-4 rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
            Want to build reusable room templates, or bulk-import a checklist
            you already have written up for a property? Both live under{' '}
            <Link href="/templates/checklist" className="underline font-medium" style={{ color: 'var(--accent-gold)' }}>
              Templates → Turnover Checklist
            </Link>
            {' '}— the room library there works the same before or after
            onboarding, so there&apos;s nothing you need to do here right now.
            (A specific property&apos;s CSV/DOCX import lives on that
            property&apos;s own Setup → Checklist page.)
          </p>
        </div>
      </div>

      <div className="pt-4 border-t border-themed">
        <form action={continueAction}>
          <Button type="submit">
            Continue →
          </Button>
        </form>
      </div>
    </div>
  )
}
