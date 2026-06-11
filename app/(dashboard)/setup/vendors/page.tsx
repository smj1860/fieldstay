import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '../actions'

export default async function OnboardingVendorsPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: vendors } = await supabase
    .from('vendors')
    .select('id, name, specialty, contact_name, is_active')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('specialty')
    .order('name')

  async function continueAction() {
    'use server'
    await markStepComplete('vendors', '/setup/inventory-template')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Add Your Vendors
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Add your service vendors and contractors for maintenance and specialized work.
        </p>
      </div>

      {vendors && vendors.length > 0 ? (
        <div className="border border-themed rounded-xl overflow-hidden">
          {vendors.map((v) => (
            <div key={v.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-themed last:border-0">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                style={{ background: 'var(--accent-blue-dim)', color: 'var(--accent-blue)' }}
              >
                {v.name[0]?.toUpperCase()}
              </div>
              <div>
                <div className="text-sm font-medium text-primary-themed">{v.name}</div>
                <div className="text-xs text-muted-themed capitalize">
                  {v.specialty.replace('_', ' ')}
                  {v.contact_name && ` · ${v.contact_name}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl p-6 text-center" style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}>
          <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>No vendors yet.</p>
          <a href="/vendors" target="_blank" rel="noopener noreferrer" className="btn-secondary text-sm">
            Add vendors in Vendors section →
          </a>
          <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
            Tip: The Vendors section supports bulk CSV import.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <form action={continueAction}>
          <button type="submit" className="btn-primary">
            {vendors && vendors.length > 0 ? 'Continue →' : 'Skip for now →'}
          </button>
        </form>
      </div>
    </div>
  )
}
