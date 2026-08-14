'use client'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, AlertCircle, MapPin, StickyNote } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPropertyDateTime } from '@/lib/utils/timezone'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { CrewLoading } from '@/components/crew/CrewLoading'
import { acknowledgeDatesChanged } from '@/lib/dexie/helpers'
import { useTurnoverActions } from './use-turnover-actions'
import { TurnoverHub } from './TurnoverHub'
import { ChecklistView } from './ChecklistView'
import { InventoryView } from './InventoryView'
import { TurnoverSummaryModal } from './TurnoverSummaryModal'

export default function CrewTurnoverPage() {
  const { id }   = useParams<{ id: string }>()
  const router   = useRouter()

  const [showFlagModal, setShowFlagModal] = useState(false)
  const [view, setView] = useState<'hub' | 'checklist' | 'inventory'>('hub')

  const actions = useTurnoverActions(id)
  const { turnover, property, instance, userId, uploadError, pendingConfirm, setPendingConfirm, isCancelled, turnoverMissing } = actions

  // "Gone" and "still loading" were the same branch, so a turnover that left
  // the device — reconcileRemovedTurnovers() drops anything no longer in the
  // crew member's assigned set — left them staring at a spinner that would
  // never resolve. turnoverMissing is only true once a turnovers pull has
  // actually landed, so a cold cache still reads as loading rather than as a
  // reassignment that did not happen.
  if (turnoverMissing) {
    return (
      <div className="min-h-screen p-4" style={{ background: 'var(--bg-page)' }}>
        <button
          onClick={() => router.push('/crew')}
          className="flex items-center justify-center rounded-lg text-muted-themed hover:text-secondary-themed hover:bg-raised-themed transition-colors mb-4"
          style={{ width: 44, height: 44 }}
          aria-label="Back to assignments"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div
          className="flex items-start gap-2 rounded-xl px-4 py-3"
          style={{ background: 'var(--accent-amber-dim)', border: '1px solid var(--accent-amber)' }}
          role="alert"
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-amber)' }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--accent-amber)' }}>
              This turnover is no longer assigned to you
            </p>
            <p className="text-sm mt-0.5" style={{ color: 'var(--accent-amber)' }}>
              It may have been reassigned or removed. Check with your manager if
              you were expecting to work it.
            </p>
          </div>
        </div>
        <Button variant="secondary" onClick={() => router.push('/crew')} className="w-full mt-4">
          Back to my assignments
        </Button>
      </div>
    )
  }

  if (!turnover) {
    return <CrewLoading />
  }

  const fullAddress = [property?.address, property?.city, property?.state].filter(Boolean).join(', ')

  return (
    <div className="min-h-screen pb-24" style={{ background: 'var(--bg-page)' }}>
      {/* Back button — always visible */}
      <button
        onClick={() => view === 'hub' ? router.push('/crew') : setView('hub')}
        className="flex items-center justify-center rounded-lg text-muted-themed hover:text-secondary-themed hover:bg-raised-themed transition-colors mb-4"
        style={{ width: 44, height: 44 }}
        aria-label={view === 'hub' ? 'Back to assignments' : 'Back to turnover'}
      >
        <ArrowLeft className="w-4 h-4" />
      </button>

      {/*
        A cancelled turnover stays on the device — see the note on isCancelled
        in use-turnover-actions.ts. The crew LIST filters cancelled out, so the
        only way to be looking at one is to have been on this page already when
        the guest cancelled, which is exactly the case where nobody would
        otherwise notice. Same wording as the push notification that fires from
        crew-turnover-cancelled.ts, so the two agree.
      */}
      {isCancelled && (
        <div
          className="flex items-start gap-2 rounded-xl px-4 py-3 mb-4"
          style={{ background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.25)' }}
          role="alert"
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-red)' }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--accent-red)' }}>
              This turnover was cancelled
            </p>
            <p className="text-sm mt-0.5" style={{ color: 'var(--accent-red)' }}>
              A cancelled booking removed this turnover — no need to go. Check with
              your manager before doing any more work on it.
            </p>
          </div>
        </div>
      )}

      {/* Property info card — always visible across all views */}
      <div className="bg-card-themed rounded-xl border border-themed p-4 mb-4">
        <p className="font-bold text-primary-themed text-lg leading-tight">
          {property?.name ?? 'Loading property…'}
        </p>
        {fullAddress && (
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(fullAddress)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-brand-700 flex items-center gap-1 mt-1 hover:underline"
          >
            <MapPin className="w-3 h-3 flex-shrink-0" />
            {fullAddress}
          </a>
        )}

        <div className="mt-3 pt-3 border-t border-themed flex items-center justify-between flex-wrap gap-2">
          <span
            className={cn(
              'text-xs font-semibold px-2 py-0.5 rounded-full',
              turnover.priority !== 'urgent' && turnover.priority !== 'high' && 'bg-raised-themed text-secondary-themed'
            )}
            style={
              turnover.priority === 'urgent'
                ? { background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }
                : turnover.priority === 'high'
                ? { background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)' }
                : undefined
            }
          >
            {turnover.priority} priority
          </span>
          {turnover.prev_booking_id && turnover.window_minutes ? (
            <span className="text-sm font-semibold text-secondary-themed">
              {Math.floor(turnover.window_minutes / 60)}h
              {turnover.window_minutes % 60 > 0 ? ` ${turnover.window_minutes % 60}m` : ''} window
            </span>
          ) : null}
        </div>

        <div className="mt-2 space-y-1 text-sm">
          <div className="flex gap-3">
            <span className="text-muted-themed w-20 flex-shrink-0">Checkout</span>
            <span className="font-medium text-primary-themed">
              {formatPropertyDateTime(turnover.checkout_datetime, property?.timezone ?? 'America/Chicago')}
            </span>
          </div>
          {/* No outgoing booking recorded means this is a standalone turnover:
              nobody is arriving after this checkout that we know of. The
              generator still stores checkout + 4h as checkin_datetime so the
              row has a working window, but showing that as "Next In" tells a
              cleaner to hurry for a guest who does not exist. */}
          <div className="flex gap-3">
            <span className="text-muted-themed w-20 flex-shrink-0">Next In</span>
            <span className="font-medium text-primary-themed">
              {turnover.prev_booking_id
                ? formatPropertyDateTime(turnover.checkin_datetime, property?.timezone ?? 'America/Chicago')
                : 'No next booking'}
            </span>
          </div>
        </div>

        {/* Checkout/check-in time changed while this turnover was already
            in progress — see lib/turnovers/generator.ts's
            refreshExistingPairDates(). The real checkout_datetime/
            checkin_datetime above are intentionally NOT updated; this only
            informs the crew member so they aren't blindsided, and gives
            them a way to dismiss it once seen. */}
        {turnover.dates_changed_at && !turnover.dates_change_acknowledged_at && (
          <div
            className="mt-3 flex items-start gap-2 rounded-xl px-4 py-3"
            style={{ background: 'var(--accent-amber-dim)', border: '1px solid rgba(245,158,11,0.25)' }}
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-amber)' }} />
            <div className="flex-1">
              <p className="text-sm font-medium" style={{ color: 'var(--accent-amber)' }}>Checkout time changed</p>
              <p className="text-sm mt-0.5" style={{ color: 'var(--accent-amber)' }}>
                The guest&apos;s reservation changed after this turnover started.
                {turnover.pending_checkout_datetime && (
                  <> New checkout: <span className="font-medium">
                    {formatPropertyDateTime(turnover.pending_checkout_datetime, property?.timezone ?? 'America/Chicago')}
                  </span>.</>
                )}
                {turnover.pending_checkin_datetime && (
                  <> New check-in: <span className="font-medium">
                    {formatPropertyDateTime(turnover.pending_checkin_datetime, property?.timezone ?? 'America/Chicago')}
                  </span>.</>
                )}
                {' '}The times above haven&apos;t been changed automatically — let your PM know if this affects your plan.
              </p>
              <button
                type="button"
                onClick={() => { void acknowledgeDatesChanged(userId, id) }}
                className="mt-2 text-sm font-medium underline"
                style={{ color: 'var(--accent-amber)' }}
              >
                Got it
              </button>
            </div>
          </div>
        )}

        {turnover.notes && (
          <p
            className="mt-3 text-sm rounded-lg px-3 py-2 flex items-start gap-1.5"
            style={{ color: 'var(--accent-amber)', background: 'var(--accent-amber-dim)' }}
          >
            <StickyNote className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{turnover.notes}</span>
          </p>
        )}
      </div>

      {/* Upload error banner */}
      {uploadError && (
        <div
          className="flex items-start gap-2 rounded-xl px-4 py-3 mb-4"
          style={{ background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-red)' }} />
          <p className="text-sm" style={{ color: 'var(--accent-red)' }}>{uploadError}</p>
        </div>
      )}

      {view === 'hub' && (
        <TurnoverHub
          turnover={turnover}
          actions={actions}
          onOpenChecklist={() => setView('checklist')}
          onOpenInventory={() => setView('inventory')}
          onOpenSummary={() => setShowFlagModal(true)}
          onMarkCompleteSuccess={() => router.push('/crew')}
        />
      )}

      {view === 'checklist' && (
        <ChecklistView
          turnover={turnover}
          instance={instance}
          actions={actions}
          onBack={() => setView('hub')}
        />
      )}

      {view === 'inventory' && (
        <InventoryView
          turnover={turnover}
          actions={actions}
          onBack={() => setView('hub')}
        />
      )}

      {/* Turnover summary notes modal — always available regardless of view */}
      {showFlagModal && (
        <TurnoverSummaryModal
          turnoverId={turnover.id}
          initialNotes={turnover.completion_notes}
          userId={userId}
          onClose={() => setShowFlagModal(false)}
        />
      )}

      {/* Missing photos/assets confirmation — replaces native confirm() */}
      {pendingConfirm && (
        <Dialog
          open
          onClose={() => setPendingConfirm(null)}
          title="Continue anyway?"
          maxWidthClassName="max-w-sm"
          mobileSheet
          footer={
            <>
              <Button variant="secondary" onClick={() => setPendingConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="cta"
                onClick={() => {
                  pendingConfirm.onConfirm()
                  setPendingConfirm(null)
                }}
              >
                Confirm
              </Button>
            </>
          }
        >
          <p className="text-sm text-secondary-themed">{pendingConfirm.message}</p>
        </Dialog>
      )}
    </div>
  )
}
