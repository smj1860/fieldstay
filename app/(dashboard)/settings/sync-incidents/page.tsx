// app/(dashboard)/settings/sync-incidents/page.tsx
//
// The admin lookup RECORD_GUARANTEE_IMPLEMENTATION.md section 1.5 calls "the
// actual deliverable" — crew_sync_incidents alone doesn't adjudicate a
// Record Guarantee claim, this page answering "what failed for this org
// between date A and B" does. Modeled directly on ../audit/page.tsx (same
// requireOrgRole gate, same offset pagination via one extra row).

import { requireOrgRole } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { AlertTriangle } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import Link from 'next/link'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { GUARANTEE_NAME } from '@/lib/guarantee'
import type { CrewSyncIncident, CrewMember } from '@/types/database'

const PAGE_SIZE = 50

type IncidentRow = Pick<
  CrewSyncIncident,
  'id' | 'occurred_at' | 'kind' | 'table_name' | 'reason' | 'entity_id' | 'crew_member_id'
> & { crew_members: Pick<CrewMember, 'name'> | null }

export default async function SyncIncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  // requireOrgRole, not requireOrgMember — same reasoning as ../audit: this
  // bypasses crew_sync_incidents' org-scoped RLS with the service client so
  // admin/managers get a stable, joined view, so the role gate has to happen
  // here rather than relying on RLS to also double as an authorization check.
  const { membership } = await requireOrgRole(['admin', 'manager'])

  const { page: pageParam } = await searchParams
  const page   = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  const supabase = createServiceClient({ authorizedBy: membership })

  const { data: incidents, error: incidentsError } = await supabase
    .from('crew_sync_incidents')
    .select('id, occurred_at, kind, table_name, reason, entity_id, crew_member_id, crew_members(name)')
    .eq('org_id', membership.org_id)
    .order('occurred_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE)

  throwIfAnyQueryFailed({ site: 'page.settings.sync-incidents', orgId: membership.org_id }, incidentsError)
  const fetched = (incidents ?? []) as unknown as IncidentRow[]
  const hasMore = fetched.length > PAGE_SIZE
  const rows    = hasMore ? fetched.slice(0, PAGE_SIZE) : fetched

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-2">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--accent-gold-dim)' }}
        >
          <AlertTriangle className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
        </div>
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Sync Incidents</h1>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Work that was saved on a crew device but did not reach FieldStay
          </p>
        </div>
      </div>
      <p className="text-xs mb-6" style={{ color: 'var(--text-muted)' }}>
        Backs{' '}
        <Link href="/guarantee" className="underline">{GUARANTEE_NAME}</Link>
        &apos;s adjudication — every row here is a device-reported dead-letter or
        stalled sync, never something a person entered by hand.
      </p>

      {rows.length === 0 ? (
        <Card className="text-center py-12">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No sync incidents recorded.</p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Occurred
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Kind
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Table
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Reason
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Crew Member
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((incident, i) => (
                  <tr
                    key={incident.id}
                    style={{
                      borderBottom: i < rows.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                    }}
                  >
                    <td className="px-4 py-3 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                      {new Date(incident.occurred_at).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', hour12: false,
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={incident.kind === 'dead_letter' ? 'red' : 'amber'}>
                        {incident.kind === 'dead_letter' ? 'Dead letter' : 'Stalled'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {incident.table_name}
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {incident.reason ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {incident.crew_members?.name ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(page > 1 || hasMore) && (
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderTop: '1px solid var(--border)' }}
            >
              {page > 1 ? (
                <Link href={`/settings/sync-incidents?page=${page - 1}`} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
                  ← Previous
                </Link>
              ) : <span />}
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Page {page}</span>
              {hasMore ? (
                <Link href={`/settings/sync-incidents?page=${page + 1}`} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
                  Next →
                </Link>
              ) : <span />}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
