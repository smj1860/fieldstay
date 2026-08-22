'use client'

// The single dead-letter surface for the crew PWA.
//
// Retry affordances used to exist for exactly three mutation types
// (checklist_instances confirm, the inventory-confirm turnovers payload,
// and crew_work_orders). Everything else — checklist ITEM ticks and notes
// (by far the highest-volume crew write), inventory quantities, availability,
// work-order reports, asset captures, turnover start/complete, and every
// queued photo — dead-lettered completely silently: the write vanished from
// the outbox's pending set and nothing anywhere told the crew member their
// work never left the phone.
//
// This banner is rendered by CrewShell, so it covers every mutation type on
// every crew screen by construction. MUTATION_LABELS must therefore stay
// exhaustive over MutationTable — enforced by
// unit/guardrails/crew-dead-letter-coverage.test.ts.
//
// The PRESENTATION lives in components/sync/sync-failure-panel.tsx, shared with
// the dashboard's banner: two copies of "a stalled queue is not a failure and
// gets no discard button" is two places to lose that rule. What stays here is
// what genuinely differs — the queries, the labels, and the retry/discard
// wiring.

import { useLiveQuery } from 'dexie-react-hooks'
import { SyncFailurePanel, type SyncFailureEntry } from '@/components/sync/sync-failure-panel'
import { useDexieDb } from '@/lib/dexie/context'
import { createClient } from '@/lib/supabase/client'
import type { MutationTable } from '@/lib/dexie/schema'
import { retryAllFailedMutations, discardFailedMutation } from '@/lib/dexie/helpers'
import { retryFailedPhotoUploads, discardPendingPhoto } from '@/lib/dexie/photo-sync'
import { STALLED_NETWORK_ATTEMPTS } from '@/lib/dexie/net'

/** Human label for every mutation type that can dead-letter. Exhaustive over MutationTable. */
const MUTATION_LABELS: Record<MutationTable, string> = {
  checklist_instance_items: 'Checklist task update',
  checklist_instances:      'Checklist completion confirmation',
  turnovers:                'Turnover update',
  inventory_counts:         'Inventory count',
  work_order_reports:       'Work order request',
  property_assets:          'Appliance details',
  crew_work_orders:         'Work order completion',
  messages:                 'Message to your operations team',
}

function mutationLabel(table: string): string {
  return MUTATION_LABELS[table as MutationTable] ?? 'Saved change'
}

export function FailedSyncBanner({ userId }: Readonly<{ userId: string }>) {
  const db = useDexieDb()

  // Index-backed (`failed` is stored 0/1 — IndexedDB cannot index a boolean).
  // These are live queries on tables that are written on every checklist tick
  // and every drain step, so as `.filter()` full scans they re-deserialized
  // the whole outbox, three times, on each of those writes.
  const failedMutations = useLiveQuery(
    () => db.mutations.where('failed').equals(1).toArray(),
    [],
  ) ?? []

  const failedPhotos = useLiveQuery(
    () => db.pending_photo_uploads.where('failed').equals(1).toArray(),
    [],
  ) ?? []

  // Transport failures deliberately never dead-letter — losing a crew
  // member's work because their signal is bad would be worse than the bug
  // this surfaces. But the drain STOPS at a blocked head, so every later
  // change on the device queues behind it. Previously that state was
  // completely invisible: `failed` is never set on the network path, this
  // banner filters on `failed`, and the only trace anywhere was the pending
  // count in the logout dialog. A crew member could work a whole shift, sync
  // nothing, and find out at logout.
  const stalledMutations = useLiveQuery(
    () => db.mutations
      .filter((m) => !m.failed && (m.networkRetryCount ?? 0) >= STALLED_NETWORK_ATTEMPTS)
      .toArray(),
    [],
  ) ?? []

  // Photos stall the same way and were covered by NEITHER surface: a transport
  // failure never sets `failed` (by design — a bad signal must not destroy
  // crew work), so they fell out of failedPhotos above, and the stalled notice
  // only ever looked at db.mutations. A whole shift of verification photos
  // could retry forever against a captive portal with nothing on screen.
  const stalledPhotos = useLiveQuery(
    () => db.pending_photo_uploads
      .filter((p) => !p.failed && (p.network_retry_count ?? 0) >= STALLED_NETWORK_ATTEMPTS)
      .toArray(),
    [],
  ) ?? []

  const entries: SyncFailureEntry[] = [
    ...failedMutations.map((m) => ({
      key:     `mutation-${m.id}`,
      label:   mutationLabel(m.table),
      detail:  m.lastError ?? '',
      discard: () => discardFailedMutation(userId, m.id as number),
    })),
    ...failedPhotos.map((p) => ({
      key:     `photo-${p.id}`,
      label:   'Photo',
      detail:  p.last_error ?? '',
      discard: () => discardPendingPhoto(userId, p),
    })),
  ]

  const retryAll = async () => {
    await retryAllFailedMutations(userId)
    await retryFailedPhotoUploads(createClient(), userId)
  }

  return (
    <SyncFailurePanel
      entries={entries}
      stalledCount={stalledMutations.length + stalledPhotos.length}
      onRetryAll={retryAll}
      stalledHint={
        'Your work is saved on this phone and will keep retrying on its own. ' +
        'If this stays here, move somewhere with better signal before you finish for the day.'
      }
      failedHint={
        'This work is saved on your phone but hasn’t reached FieldStay. ' +
        'Tap retry once you have signal.'
      }
    />
  )
}
