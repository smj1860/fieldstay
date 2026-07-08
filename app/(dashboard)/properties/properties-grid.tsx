'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Search, AlertCircle, CheckCircle2, Settings, Wrench, RefreshCw } from 'lucide-react'
import { calcSetupProgress } from '@/lib/wizard'
import { CopyFromButton } from './property-card-actions'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { buttonVariantClass } from '@/components/ui/Button'

interface PropertyRow {
  id: string
  name: string
  address: string | null
  city: string | null
  state: string | null
  property_type: string
  bedrooms: number
  bathrooms: number
  setup_steps_completed: Record<string, boolean> | null
  is_active: boolean
}

interface PropertyOpsCounts {
  openWorkOrders: number
  unassignedTurnovers: number
  syncErrors: number
}

export function PropertiesGrid({
  properties,
  opsCountsByProperty,
}: Readonly<{
  properties: PropertyRow[]
  opsCountsByProperty: Record<string, PropertyOpsCounts>
}>) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return properties
    return properties.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.city ?? '').toLowerCase().includes(q) ||
      (p.address ?? '').toLowerCase().includes(q)
    )
  }, [properties, query])

  return (
    <div>
      {properties.length > 6 && (
        <div className="relative mb-5 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, city, or address…"
            className="pl-9 text-sm w-full"
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="text-sm text-center py-12" style={{ color: 'var(--text-muted)' }}>
          No properties match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filtered.map((p) => {
            const steps    = (p.setup_steps_completed as Record<string, boolean>) ?? {}
            const progress = calcSetupProgress(steps)
            const complete = progress === 100
            const ops      = opsCountsByProperty[p.id] ?? { openWorkOrders: 0, unassignedTurnovers: 0, syncErrors: 0 }
            const hasIssues = ops.openWorkOrders > 0 || ops.unassignedTurnovers > 0 || ops.syncErrors > 0

            return (
              <Card key={p.id} className="flex flex-col gap-4 hover:shadow-card-md transition-shadow">
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-primary-themed truncate">{p.name}</h3>
                    {p.address && (
                      <p className="text-xs text-muted-themed mt-0.5 truncate">{p.address}</p>
                    )}
                    {(p.city || p.state) && (
                      <p className="text-xs text-muted-themed truncate">
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

                <div className="flex gap-3 text-xs text-muted-themed">
                  <span className="capitalize">{p.property_type}</span>
                  <span>·</span>
                  <span>{p.bedrooms} bed</span>
                  <span>·</span>
                  <span>{p.bathrooms} bath</span>
                </div>

                {/* Operational health badges */}
                {hasIssues && (
                  <div className="flex flex-wrap gap-1.5">
                    {ops.openWorkOrders > 0 && (
                      <Badge tone="blue" className="text-xs flex items-center gap-1">
                        <Wrench className="w-3 h-3" />
                        {ops.openWorkOrders} open WO{ops.openWorkOrders !== 1 ? 's' : ''}
                      </Badge>
                    )}
                    {ops.unassignedTurnovers > 0 && (
                      <Badge tone="amber" className="text-xs flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        {ops.unassignedTurnovers} unassigned
                      </Badge>
                    )}
                    {ops.syncErrors > 0 && (
                      <Badge tone="red" className="text-xs flex items-center gap-1">
                        <RefreshCw className="w-3 h-3" />
                        Sync error
                      </Badge>
                    )}
                  </div>
                )}

                {/* Setup progress */}
                {!complete ? (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--accent-amber)' }}>
                        <AlertCircle className="w-3 h-3" />
                        Setup {progress}% complete
                      </span>
                      <Link
                        href={`/properties/${p.id}/setup/details`}
                        className="text-xs font-medium hover:underline"
                        style={{ color: 'var(--accent-gold)' }}
                      >
                        Continue →
                      </Link>
                    </div>
                    <div className="h-1.5 bg-raised-themed rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${progress}%`, background: 'var(--accent-amber)' }}
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
                    <CheckCircle2 className="w-3 h-3" />
                    Setup complete
                  </p>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-1 border-t border-themed">
                  <Link href={`/properties/${p.id}`} className={buttonVariantClass('secondary') + ' text-xs px-3 py-1.5 flex-1 justify-center'}>
                    View
                  </Link>
                  <Link href={`/properties/${p.id}/setup/details`} className={buttonVariantClass('ghost') + ' text-xs px-3 py-1.5'}>
                    Setup
                  </Link>
                  <CopyFromButton
                    targetProperty={{ id: p.id, name: p.name }}
                    otherProperties={properties.filter((other) => other.id !== p.id).map((other) => ({ id: other.id, name: other.name }))}
                  />
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
