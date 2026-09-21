'use client'

// The "a cap that applies must SAY SO in the output" convention (CLAUDE.md's
// Report and export caps section), applied to the two offline caches that
// used to truncate silently: warmMaintenanceBoardForOffline's open-work-order
// fetch (WORK_ORDER_LIMIT) and warmInspectionsForOffline's inspection-schedule
// fetch (SCHEDULE_LIMIT). Both warms now pair their bounded row fetch with a
// `count: 'exact', head: true` aggregate and write the difference to
// `sync_meta`; this reads it back.
//
// A separate small component rather than folded into DashboardSyncBanner:
// that banner's guardrail (unit/guardrails/dashboard-dead-letter-coverage.
// test.ts) parses its source with position-sensitive regexes for the
// dead-letter/stalled queries, and this notice is about a DIFFERENT failure
// mode entirely — a cache that is correct but incomplete, not a write that
// never reached the server — so it does not belong inside that surface's
// guarded shape.

import { useLiveQuery } from 'dexie-react-hooks'
import { AlertTriangle } from 'lucide-react'

import { getDashboardDb } from '@/lib/dexie/dashboard/schema'
import { WORK_ORDER_OMITTED_KEY } from '@/lib/dexie/dashboard/warm-maintenance-board'
import { SCHEDULES_OMITTED_KEY } from '@/lib/dexie/dashboard/warm-inspections'

async function omittedCount(
  db: ReturnType<typeof getDashboardDb>,
  key: string,
): Promise<number> {
  const row = await db.sync_meta.get(key)
  const value = row ? Number(row.value) : 0
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function OfflineCacheCapNotice({ userId, orgId }: Readonly<{ userId: string; orgId: string }>) {
  const db = getDashboardDb(userId, orgId)

  const workOrdersOmitted = useLiveQuery(
    () => omittedCount(db, WORK_ORDER_OMITTED_KEY),
    [userId, orgId],
  ) ?? 0
  const schedulesOmitted = useLiveQuery(
    () => omittedCount(db, SCHEDULES_OMITTED_KEY),
    [userId, orgId],
  ) ?? 0

  if (workOrdersOmitted === 0 && schedulesOmitted === 0) return null

  const parts: string[] = []
  if (workOrdersOmitted > 0) {
    parts.push(`${workOrdersOmitted} open work order${workOrdersOmitted === 1 ? '' : 's'}`)
  }
  if (schedulesOmitted > 0) {
    parts.push(`${schedulesOmitted} inspection schedule${schedulesOmitted === 1 ? '' : 's'}`)
  }
  const verb = parts.length === 1 ? "isn't" : "aren't"

  return (
    <output
      className="block mx-4 mt-3 rounded-xl p-3"
      style={{ background: 'var(--accent-amber-dim)', border: '1px solid var(--accent-amber-dim)' }}
    >
      <span className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--accent-amber)' }} />
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {parts.join(' and ')} {verb} cached for offline use — this device only keeps the most
          recent set. Connect to see the rest.
        </span>
      </span>
    </output>
  )
}
