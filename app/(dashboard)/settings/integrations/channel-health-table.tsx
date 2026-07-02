'use client'

import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react'
import { formatDate } from '@/lib/utils'

interface FeedRow {
  id: string
  property_id: string
  name: string
  source: string
  last_synced_at: string | null
  last_sync_status: string
  last_sync_error: string | null
  properties: { name: string } | { name: string }[] | null
}

const STATUS_RANK: Record<string, number> = { error: 0, pending: 1, success: 2 }

export function ChannelHealthTable({ feeds }: Readonly<{ feeds: FeedRow[] }>) {
  if (feeds.length === 0) return null

  const sorted = [...feeds].sort(
    (a, b) => (STATUS_RANK[a.last_sync_status] ?? 3) - (STATUS_RANK[b.last_sync_status] ?? 3)
  )

  const propertyName = (f: FeedRow) =>
    Array.isArray(f.properties) ? f.properties[0]?.name : f.properties?.name

  return (
    <div className="mt-8">
      <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
        Channel Health ({feeds.length} feed{feeds.length !== 1 ? 's' : ''})
      </h2>
      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        {sorted.map((f, i) => (
          <Link key={f.id} href={`/properties/${f.property_id}/setup/ical`}>
            <div
              className={`flex items-center gap-3 px-4 py-3 transition-colors ${i > 0 ? 'border-t' : ''}`}
              style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
            >
              {f.last_sync_status === 'success' && <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />}
              {f.last_sync_status === 'error'   && <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-red)' }} />}
              {f.last_sync_status === 'pending' && <Clock className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                  {propertyName(f) ?? 'Unknown property'} — {f.name}
                </p>
                <p className="text-xs truncate" style={{ color: f.last_sync_status === 'error' ? 'var(--accent-red)' : 'var(--text-muted)' }}>
                  {f.last_sync_status === 'error' && f.last_sync_error
                    ? f.last_sync_error
                    : f.last_synced_at
                      ? `Last synced ${formatDate(f.last_synced_at)}`
                      : 'Never synced'}
                </p>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 capitalize" style={{
                background: f.last_sync_status === 'error' ? 'var(--accent-red-dim)' : 'var(--bg-raised)',
                color:      f.last_sync_status === 'error' ? 'var(--accent-red)'     : 'var(--text-muted)',
              }}>
                {f.source}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
