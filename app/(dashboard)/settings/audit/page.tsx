import Link from 'next/link'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { Shield, Download } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import type { AuditEvent } from '@/types/database'

const PAGE_SIZE = 50

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: { page?: string }
}) {
  const { membership } = await requireOrgMember()

  const page   = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  // Use service client — audit_events RLS restricts to owner role only,
  // but admin/managers should also be able to view for SOC2 purposes.
  const supabase = createServiceClient()

  // Fetch one extra row to detect a next page without a separate count query.
  const { data: events } = await supabase
    .from('audit_events')
    .select('id, action, actor_id, target_type, target_id, metadata, created_at')
    .eq('org_id', membership.org_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE)

  const fetched = (events ?? []) as Pick<AuditEvent, 'id' | 'action' | 'actor_id' | 'target_type' | 'target_id' | 'metadata' | 'created_at'>[]
  const hasMore = fetched.length > PAGE_SIZE
  const rows    = hasMore ? fetched.slice(0, PAGE_SIZE) : fetched

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--accent-gold-dim)' }}
          >
            <Shield className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
          </div>
          <div>
            <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Audit Log</h1>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Admin actions, access changes, financial mutations
            </p>
          </div>
        </div>
        <a
          href="/api/gdpr/export"
          download
          className="btn-secondary text-sm flex items-center gap-1.5"
        >
          <Download className="w-4 h-4" />
          Export My Data
        </a>
      </div>

      {rows.length === 0 ? (
        <Card className="text-center py-12">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No audit events recorded yet.</p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Timestamp
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Action
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Target
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Actor
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event, i) => (
                  <tr
                    key={event.id}
                    style={{
                      borderBottom: i < rows.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                    }}
                  >
                    <td className="px-4 py-3 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                      {new Date(event.created_at).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', hour12: false,
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="font-mono text-xs px-2 py-0.5 rounded"
                        style={{
                          background: actionBg(event.action),
                          color:      actionColor(event.action),
                        }}
                      >
                        {event.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {event.target_type && (
                        <span>
                          {event.target_type}
                          {event.target_id && (
                            <span className="font-mono ml-1 opacity-60">
                              {event.target_id.slice(0, 8)}…
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                      {event.actor_id ? event.actor_id.slice(0, 8) + '…' : '—'}
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
                <Link href={`/settings/audit?page=${page - 1}`} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
                  ← Previous
                </Link>
              ) : <span />}
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Page {page}</span>
              {hasMore ? (
                <Link href={`/settings/audit?page=${page + 1}`} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
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

function actionBg(action: string): string {
  if (action.includes('deleted') || action.includes('cancelled') || action.includes('archived') || action.includes('deactivated')) {
    return 'var(--accent-red-dim)'
  }
  if (action.includes('created') || action.includes('connected')) {
    return 'var(--accent-green-dim)'
  }
  return 'var(--bg-raised)'
}

function actionColor(action: string): string {
  if (action.includes('deleted') || action.includes('cancelled') || action.includes('archived') || action.includes('deactivated')) {
    return 'var(--accent-red)'
  }
  if (action.includes('created') || action.includes('connected')) {
    return 'var(--accent-green)'
  }
  return 'var(--text-secondary)'
}
