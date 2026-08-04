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

import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react'
import { useDexieDb } from '@/lib/dexie/context'
import { createClient } from '@/lib/supabase/client'
import type { MutationTable } from '@/lib/dexie/schema'
import { retryAllFailedMutations, discardFailedMutation } from '@/lib/dexie/helpers'
import { retryFailedPhotoUploads, discardPendingPhoto } from '@/lib/dexie/photo-sync'
import { STALLED_NETWORK_ATTEMPTS } from '@/lib/dexie/net'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Dialog } from '@/components/ui/Dialog'

/** Human label for every mutation type that can dead-letter. Exhaustive over MutationTable. */
const MUTATION_LABELS: Record<MutationTable, string> = {
  checklist_instance_items: 'Checklist task update',
  checklist_instances:      'Checklist completion confirmation',
  turnovers:                'Turnover update',
  inventory_items:          'Inventory count',
  crew_availability:        'Time-off request',
  work_order_reports:       'Work order request',
  property_assets:          'Appliance details',
  crew_work_orders:         'Work order completion',
  inventory_count_drafts:   'Inventory count submission',
}

interface FailedEntry {
  key:      string
  label:    string
  detail:   string
  discard:  () => Promise<void>
}

function mutationLabel(table: string): string {
  return MUTATION_LABELS[table as MutationTable] ?? 'Saved change'
}

export function FailedSyncBanner({ userId }: Readonly<{ userId: string }>) {
  const db = useDexieDb()
  const [retrying, setRetrying] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState<FailedEntry | null>(null)

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

  const stalledCount = stalledMutations.length + stalledPhotos.length

  const entries: FailedEntry[] = [
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

  if (entries.length === 0 && stalledCount === 0) return null

  // A stalled queue is NOT a failure — the work is intact and still retrying,
  // so it gets its own amber notice with no discard affordance rather than
  // being folded into the red "didn't sync" list.
  const stalledNotice = stalledCount > 0 && (
    <div
      className="mx-4 mt-3 rounded-xl p-4"
      style={{ background: 'var(--accent-amber-dim)', border: '1px solid var(--accent-amber-dim)' }}
      role="status"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--accent-amber)' }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>
            {stalledCount} change{stalledCount !== 1 ? 's' : ''} still trying to sync
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            Your work is saved on this phone and will keep retrying on its own.
            If this stays here, move somewhere with better signal before you
            finish for the day.
          </p>
        </div>
      </div>
    </div>
  )

  if (entries.length === 0) return <>{stalledNotice}</>

  const retryAll = async () => {
    setRetrying(true)
    try {
      await retryAllFailedMutations(userId)
      await retryFailedPhotoUploads(createClient(), userId)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <>
      {stalledNotice}
      <div
        className="mx-4 mt-3 rounded-xl p-4"
        style={{ background: 'var(--accent-red-dim)', border: '1px solid var(--accent-red-dim)' }}
        role="status"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--accent-red)' }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold" style={{ color: 'var(--accent-red)' }}>
              {entries.length} item{entries.length !== 1 ? 's' : ''} didn&rsquo;t sync
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              This work is saved on your phone but hasn&rsquo;t reached FieldStay.
              Tap retry once you have signal.
            </p>

            <ul className="mt-3 flex flex-col gap-2">
              {entries.map((entry) => (
                <li key={entry.key} className="flex items-center gap-2">
                  <Badge tone="red">{entry.label}</Badge>
                  {entry.detail && (
                    <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                      {entry.detail}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setConfirmDiscard(entry)}
                    aria-label={`Discard ${entry.label}`}
                    className="ml-auto p-1.5 -m-1 rounded-lg shrink-0"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>

            <Button
              variant="danger"
              onClick={() => void retryAll()}
              disabled={retrying}
              className="mt-3 w-full flex items-center justify-center gap-2 py-2.5"
            >
              <RefreshCw className="w-4 h-4" />
              {retrying ? 'Retrying…' : 'Retry all'}
            </Button>
          </div>
        </div>
      </div>

      {confirmDiscard && (
        <Dialog
          open
          onClose={() => setConfirmDiscard(null)}
          title="Discard this item?"
          mobileSheet
          maxWidthClassName="max-w-sm"
          footer={
            <div className="flex flex-col gap-2 w-full">
              <Button variant="secondary" onClick={() => setConfirmDiscard(null)} className="w-full py-3">
                Keep it
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const entry = confirmDiscard
                  setConfirmDiscard(null)
                  void entry.discard()
                }}
                className="w-full py-3"
              >
                Discard
              </Button>
            </div>
          }
        >
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            &ldquo;{confirmDiscard.label}&rdquo; never reached FieldStay. Discarding
            removes it from this device for good &mdash; your PM will never see it.
          </p>
        </Dialog>
      )}
    </>
  )
}
