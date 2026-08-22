'use client'

// The single dead-letter surface for the PM dashboard — the dashboard's
// counterpart to app/crew/_components/failed-sync-banner.tsx.
//
// It exists for the reason INSPECTIONS_SPEC §8 gives for widening offline
// support past inspections: "An evicted inspection draft is a wasted visit; an
// evicted work order is a repair nobody knows was requested." A queued write
// that dies where nobody can see it is work silently thrown away, and the crew
// audit found exactly that across almost the whole write surface before the
// crew banner was built.
//
// Rendered by the dashboard layout, so it covers every dashboard screen by
// construction — which is what lets the guardrail treat "has a banner entry" as
// "is visible to the PM". MUTATION_LABELS stays exhaustive over
// DashboardMutationKind by TYPE, not by convention.

import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { STALLED_NETWORK_ATTEMPTS } from '@/lib/dexie/net'
import { getDashboardDb, type DashboardMutationKind } from '@/lib/dexie/dashboard/schema'
import {
  discardFailedDashboardMutation,
  retryAllFailedDashboardMutations,
} from '@/lib/dexie/dashboard/syncService'

/**
 * Phrased for a PM, not an engineer: the label is what appears on a red pill
 * next to "didn't sync", so it has to name the thing they did.
 */
const MUTATION_LABELS: Record<DashboardMutationKind, string> = {
  'work_order.create': 'New work order',
  'inspection.submit': 'Completed inspection',
}

interface FailedEntry {
  key:     string
  label:   string
  detail:  string
  discard: () => Promise<void>
}

export function DashboardSyncBanner({ userId, orgId }: Readonly<{ userId: string; orgId: string }>) {
  const [retrying, setRetrying] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState<FailedEntry | null>(null)

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
  // at a blocked head, so everything queued behind it waits invisibly. This
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

  const stalledCount = stalledMutations.length + stalledPhotos.length

  const entries: FailedEntry[] = [
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

  if (entries.length === 0 && stalledCount === 0) return null

  // A stalled queue is NOT a failure: the work is intact and still retrying. It
  // gets its own amber notice with no discard affordance, rather than being
  // folded into the red list and inviting a PM to throw away work that was
  // going to arrive.
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
            This work is saved on this device and will keep retrying on its own.
            If it stays here, move somewhere with better signal before you leave
            the property.
          </p>
        </div>
      </div>
    </div>
  )

  if (entries.length === 0) return <>{stalledNotice}</>

  const retryAll = async () => {
    setRetrying(true)
    try {
      await retryAllFailedDashboardMutations(userId, orgId)
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
              This work is saved on this device but hasn&rsquo;t reached FieldStay.
              Retry once you have a connection.
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
                    className="ml-auto p-1.5 -m-1 rounded-lg shrink-0 focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
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
            removes it from this device for good.
          </p>
        </Dialog>
      )}
    </>
  )
}
