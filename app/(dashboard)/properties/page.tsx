import { requireOrgMember } from '@/lib/auth'
import { calcSetupProgress } from '@/lib/wizard'
import Link from 'next/link'
import { Plus, AlertCircle, CheckCircle2, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Properties' }

export default async function PropertiesPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: properties } = await supabase
    .from('properties')
    .select('id, name, city, state, property_type, bedrooms, bathrooms, setup_steps_completed, is_active')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')

  const atLimit = (properties?.length ?? 0) >= membership.org.max_properties

  return (
    <div>
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Properties</h1>
          <p className="page-subtitle">
            {properties?.length ?? 0} of {membership.org.max_properties} properties
          </p>
        </div>
        {atLimit ? (
          <span className="btn-secondary opacity-60 cursor-not-allowed text-xs">
            Upgrade to add more
          </span>
        ) : (
          <Link href="/properties/new" className="btn-primary">
            <Plus className="w-4 h-4" />
            Add Property
          </Link>
        )}
      </div>

      {!properties?.length ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {properties.map((p) => {
            const steps    = (p.setup_steps_completed as Record<string, boolean>) ?? {}
            const progress = calcSetupProgress(steps)
            const complete = progress === 100

            return (
              <div key={p.id} className="card flex flex-col gap-4 hover:shadow-card-md transition-shadow">
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-primary-themed truncate">{p.name}</h3>
                    {(p.city || p.state) && (
                      <p className="text-sm text-muted-themed mt-0.5">
                        {[p.city, p.state].filter(Boolean).join(', ')}
                      </p>
                    )}
                  </div>
                  <Link
                    href={`/properties/${p.id}/setup/details`}
                    className="flex-shrink-0 text-muted-themed hover:text-secondary-themed transition-colors p-1"
                    title="Property settings"
                  >
                    <Settings className="w-4 h-4" />
                  </Link>
                </div>

                {/* Meta */}
                <div className="flex gap-3 text-xs text-muted-themed">
                  <span className="capitalize">{p.property_type}</span>
                  <span>·</span>
                  <span>{p.bedrooms} bed</span>
                  <span>·</span>
                  <span>{p.bathrooms} bath</span>
                </div>

                {/* Setup progress */}
                {!complete ? (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs text-amber-600 font-medium flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        Setup {progress}% complete
                      </span>
                      <Link
                        href={`/properties/${p.id}/setup/details`}
                        className="text-xs text-brand-700 font-medium hover:underline"
                      >
                        Continue →
                      </Link>
                    </div>
                    <div className="h-1.5 bg-raised-themed rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-400 rounded-full transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-green-600 font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    Setup complete
                  </p>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-1 border-t border-themed">
                  <Link
                    href={`/properties/${p.id}`}
                    className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center"
                  >
                    View
                  </Link>
                  <Link
                    href={`/properties/${p.id}/setup/details`}
                    className="btn-ghost text-xs px-3 py-1.5"
                  >
                    Setup
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="card text-center py-16 max-w-md mx-auto mt-8">
      <div className="w-12 h-12 rounded-full bg-brand-50 flex items-center justify-center mx-auto mb-4">
        <Plus className="w-6 h-6 text-brand-700" />
      </div>
      <h3 className="font-semibold text-primary-themed mb-1">Add your first property</h3>
      <p className="text-sm text-muted-themed mb-6">
        Connect your Airbnb or VRBO calendar and FieldStay handles the rest.
      </p>
      <Link href="/properties/new" className="btn-primary">
        Add Property
      </Link>
    </div>
  )
}
