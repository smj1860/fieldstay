import Link from 'next/link'
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
        <div className="card p-6 text-center" style={{ color: 'var(--text-muted)' }}>
          <p className="text-sm mb-3">No vendors yet.</p>
          <Link href="/vendors" className="btn-secondary text-sm">
            Add vendors in Vendors section →
          </Link>
        </div>
      )}

      <div className="flex items-center gap-3">
        <form action={continueAction}>
          <button type="submit" className="btn-primary">
            {vendors && vendors.length > 0 ? 'Continue →' : 'Skip for now →'}
          </button>
        </form>
        {(vendors?.length ?? 0) === 0 && (
          <Link href="/vendors" className="btn-secondary">
            Add vendors
          </Link>
        )}
      </div>
    </div>
  )
}
