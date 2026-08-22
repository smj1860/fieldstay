'use client'

// The single dead-letter surface for the PM dashboard — the dashboard's
// counterpart to app/crew/_components/failed-sync-banner.tsx.
//
// It exists for the reason INSPECTIONS_SPEC §8 gives for widening offline
// support past inspections: "An evicted inspection draft is a wasted visit; an
// evicted work order is a repair nobody knows was requested." A queued write
// that dies where nobody can see it is work silently thrown away, and the crew
// audit found exactly that across almost the whole write surface.
//
// Rendered by the dashboard layout, so it covers every dashboard screen by
// construction — which is what lets the guardrail treat "has a banner entry" as
// "is visible to the PM". MUTATION_LABELS stays exhaustive over
// DashboardMutationKind by TYPE, not by convention.
//
// The PRESENTATION lives in components/sync/sync-failure-panel.tsx, shared with
// the crew banner. What stays here is what actually differs between the two
// surfaces — the queries, the labels, and the retry/discard wiring.

import { useLiveQuery } from 'dexie-react-hooks'

import { SyncFailurePanel, type SyncFailureEntry } from '@/components/sync/sync-failure-panel'
import { STALLED_NETWORK_ATTEMPTS } from '@/lib/dexie/net'
import { getDashboardDb, type DashboardMutationKind } from '@/lib/dexie/dashboard/schema'
import {
  discardFailedDashboardMutation,
  retryAllFailedDashboardMutations,
} from '@/lib/dexie/dashboard/syncService'

/**
 * Phrased for a PM, not an engineer: the label appears on a red pill next to
 * "didn't sync", so it has to name the thing they did.
 */
const MUTATION_LABELS: Record<DashboardMutationKind, string> = {
  'work_order.create': 'New work order',
  'inspection.submit': 'Completed inspection',
}

export function DashboardSyncBanner({ userId, orgId }: Readonly<{ userId: string; orgId: string }>) {
  const db = getDashboardDb(userId, orgId)

  // Index-backed on both outboxes. `failed` is stored 0/1 precisely so these
  // can use an index: as `.filter()` full scans they would re-read the whole
  // outbox on every write to it, live, on every dashboard screen.
  const failedMutations = useLiveQuery(
    () => db.mutations.where('failed').equals(1).toArray(),
    [userId, orgId],
  ) ?? []

  const failedPhotos = useLiveQuery(
    () => db.pending_photo_uploads.where('failed').equals(1).toArray(),
    [userId, orgId],
  ) ?? []

  // A TRANSPORT failure never sets `failed` — losing a PM's work because their
  // signal is bad would be worse than the gap that creates. But the drain stops
  // at a blocked head, so everything queued behind it waits invisibly. The
  // amber notice is that state's ONLY visible surface, which is why the
  // guardrail requires it on both outboxes rather than just the mutation one:
  // on the crew side, photos were covered by neither and a whole shift could
  // retry against a captive portal with nothing on screen.
  const stalledMutations = useLiveQuery(
    () => db.mutations
      .filter((m) => !m.failed && (m.networkRetryCount ?? 0) >= STALLED_NETWORK_ATTEMPTS)
      .toArray(),
    [userId, orgId],
  ) ?? []

  const stalledPhotos = useLiveQuery(
    () => db.pending_photo_uploads
      .filter((p) => !p.failed && (p.networkRetryCount ?? 0) >= STALLED_NETWORK_ATTEMPTS)
      .toArray(),
    [userId, orgId],
  ) ?? []

  const entries: SyncFailureEntry[] = [
    ...failedMutations.map((m) => ({
      key:     `mutation-${m.id}`,
      label:   MUTATION_LABELS[m.kind] ?? 'Saved change',
      detail:  m.lastError ?? '',
      discard: () => discardFailedDashboardMutation(userId, orgId, m.id as number),
    })),
    ...failedPhotos.map((p) => ({
      key:     `photo-${p.id}`,
      label:   'Photo',
      detail:  p.lastError ?? '',
      discard: async () => { await db.pending_photo_uploads.delete(p.id) },
    })),
  ]

  return (
    <SyncFailurePanel
      entries={entries}
      stalledCount={stalledMutations.length + stalledPhotos.length}
      onRetryAll={() => retryAllFailedDashboardMutations(userId, orgId)}
      stalledHint={
        'This work is saved on this device and will keep retrying on its own. ' +
        'If it stays here, move somewhere with better signal before you leave the property.'
      }
      failedHint={
        'This work is saved on this device but hasn’t reached FieldStay. ' +
        'Retry once you have a connection.'
      }
    />
  )
}
