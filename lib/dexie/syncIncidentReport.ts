// lib/dexie/syncIncidentReport.ts
//
// Flushes sync incidents ("Show me what happened" — Implementation
// Instructions, Workstream 3 — a monitoring/support signal for crew sync
// reliability, not part of any customer-facing promise) recorded locally by
// lib/dexie/syncService.ts's SyncEngine to app/api/crew/sync-incidents.
// Deliberately its own small module rather than folded into syncService.ts
// or helpers.ts — it has nothing to do with draining the mutation outbox
// itself, only with reporting the durable trace that outbox leaves behind
// when something dead-letters or stalls.
//
// Called from app/crew/crew-shell.tsx's existing outbox-drain tick (mount +
// `online` + 30s interval) — not a standalone timer of its own, so it shares
// the exact same "an attempt made with no connection never happened" gate
// every other crew send already has.

import { getDexieDb } from './schema'
import { isOnline } from './net'
import { reportError } from '@/lib/observability/report-error'

// Matches the route's hard cap (the implementation doc's section 3.3) —
// bounded, not truncated silently.
const BATCH_SIZE = 50

/**
 * Sends up to BATCH_SIZE unreported incidents in one request and marks them
 * reported on success. Never dead-letters an incident on a transport
 * failure — same reasoning as the outbox itself: it simply retries on the
 * next tick, and the row stays in place either way (see
 * pruneReportedSyncIncidents in lib/dexie/prune.ts for the only thing that
 * ever removes one, and only once it IS reported).
 */
export async function reportSyncIncidents(userId: string): Promise<void> {
  if (!isOnline()) return

  const db = getDexieDb(userId)
  const pending = await db.sync_incidents.where('reported').equals(0).limit(BATCH_SIZE).toArray()
  if (pending.length === 0) return

  let res: Response
  try {
    res = await fetch('/api/crew/sync-incidents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        incidents: pending.map((incident) => ({
          clientIncidentId: incident.clientIncidentId,
          surface:          incident.surface,
          kind:             incident.kind,
          table:            incident.table,
          entityId:         incident.entityId,
          reason:           incident.reason,
          occurredAt:       incident.occurredAt,
          mutationQueuedAt: incident.mutationQueuedAt,
        })),
      }),
    })
  } catch (err) {
    // Transport failure — indistinguishable from "the device is offline
    // again"; the next drain tick tries the same unreported rows.
    console.warn('[syncIncidentReport] could not reach the server:', err)
    return
  }

  if (!res.ok) {
    console.warn(`[syncIncidentReport] server rejected the batch (HTTP ${res.status})`)
    reportError(new Error(`sync-incidents POST failed: HTTP ${res.status}`), {
      site: 'lib.dexie.syncIncidentReport.reportSyncIncidents',
    })
    return
  }

  await db.sync_incidents.bulkUpdate(
    pending.map((incident) => ({ key: incident.id as number, changes: { reported: 1 } })),
  )
}
