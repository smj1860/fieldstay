import Link from 'next/link'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '../actions'

export default async function OnboardingCrewPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, specialty, role, is_active')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')

  async function continueAction() {
    'use server'
    await markStepComplete('crew', '/onboarding/vendors')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Add Your Crew
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Add the cleaning and maintenance team members who will execute turnovers and work orders.
        </p>
      </div>

      {crew && crew.length > 0 ? (
        <div className="border border-themed rounded-xl overflow-hidden">
          {crew.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-themed last:border-0">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)' }}
              >
                {m.name[0]?.toUpperCase()}
              </div>
              <div>
                <div className="text-sm font-medium text-primary-themed">{m.name}</div>
                <div className="text-xs text-muted-themed capitalize">{m.role} · {m.specialty}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card p-6 text-center" style={{ color: 'var(--text-muted)' }}>
          <p className="text-sm mb-3">No crew members yet.</p>
          <Link href="/crew-manage" className="btn-secondary text-sm">
            Add crew in Crew section →
          </Link>
        </div>
      )}

      <div className="flex items-center gap-3">
        <form action={continueAction}>
          <button type="submit" className="btn-primary">
            {crew && crew.length > 0 ? 'Continue →' : 'Skip for now →'}
          </button>
        </form>
        {(crew?.length ?? 0) === 0 && (
          <Link href="/crew-manage" className="btn-secondary">
            Add crew members
          </Link>
        )}
      </div>
    </div>
  )
}
