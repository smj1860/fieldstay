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

  const failedMutations = useLiveQuery(
    () => db.mutations.filter((m) => !!m.failed).toArray(),
    [],
  ) ?? []

  const failedPhotos = useLiveQuery(
    () => db.pending_photo_uploads.filter((p) => !!p.failed).toArray(),
    [],
  ) ?? []

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

  if (entries.length === 0) return null

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
