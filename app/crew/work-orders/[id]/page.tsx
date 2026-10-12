'use client'

import { useEffect, useState }     from 'react'
import { useLiveQuery }            from 'dexie-react-hooks'
import { useDexieDb, useDexieUserId } from '@/lib/dexie/context'
import { completeWorkOrder, startWorkOrder, retryFailedMutation } from '@/lib/dexie/helpers'
import { useRouter }              from 'next/navigation'
import { ArrowLeft, Wrench, CheckCircle2, Check, Play } from 'lucide-react'
import type { PropertyRow } from '@/lib/dexie/schema'
import { CrewLoading } from '@/components/crew/CrewLoading'
import { workOrderDisplayDate } from '@/lib/work-orders/display-date'

export default function CrewWorkOrderPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const [id, setId]               = useState<string | null>(null)
  const [property, setProperty]   = useState<PropertyRow | null>(null)
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [notes, setNotes]         = useState('')
  const [done, setDone]           = useState(false)
  const db     = useDexieDb()
  const userId = useDexieUserId()
  const router = useRouter()

  useEffect(() => {
    params.then(({ id }) => setId(id))
  }, [params])

  const wo = useLiveQuery(
    () => id ? db.crew_work_orders.get(id) : undefined,
    [id, db]
  )

  useEffect(() => {
    if (!wo?.property_id) return
    db.properties.get(wo.property_id).then((p) => setProperty(p ?? null))
  }, [wo?.property_id, db])

  const syncFailed = useLiveQuery(
    () => id
      ? db.mutations.where('targetId').equals(id)
          .filter((m) => m.table === 'crew_work_orders' && !!m.failed)
          .first()
      : undefined,
    [id, db]
  )

  async function handleStart() {
    if (!id) return
    setStarting(true)
    setStartError(null)
    try {
      await startWorkOrder(userId, id)
    } catch {
      setStartError('Something went wrong saving that locally. Please try again.')
    } finally {
      setStarting(false)
    }
  }

  async function handleComplete() {
    if (!id) return
    setCompleting(true)
    setCompleteError(null)
    try {
      await completeWorkOrder(userId, id, notes)
      setDone(true)
    } catch {
      setCompleting(false)
      setCompleteError('Something went wrong saving that locally. Please try again.')
    }
  }

  if (!wo) return <CrewLoading />

  // Not a hook, so it is safe below the early return above. A vendor-confirmed
  // appointment outranks the PM's deadline, and the label says which it is.
  const displayDate = workOrderDisplayDate(wo)

  if (done) return (
    <div className="p-6 text-center">
      <CheckCircle2 className="w-10 h-10 mx-auto mb-4" style={{ color: 'var(--accent-green)' }} />
      <h2 className="font-bold text-primary-themed text-lg mb-2">Work Complete</h2>
      <p className="text-sm text-muted-themed mb-6">Your PM has been notified.</p>
      {syncFailed && (
        <div className="rounded-xl p-3 mb-4 text-left border" style={{ background: 'var(--accent-red-dim)', borderColor: 'var(--accent-red-dim)' }}>
          <p className="text-sm font-bold mb-1" style={{ color: 'var(--accent-red)' }}>Didn&apos;t sync yet</p>
          <p className="text-xs text-secondary-themed mb-2">This completion hasn&apos;t reached the server. It&apos;ll keep retrying, or tap below.</p>
          <button
            onClick={() => void retryFailedMutation(userId, 'crew_work_orders', id!)}
            className="text-xs font-semibold underline"
            style={{ color: 'var(--accent-red)' }}
          >
            Retry now
          </button>
        </div>
      )}
      <button
        onClick={() => router.push('/crew')}
        className="text-sm font-semibold text-brand-600 underline"
      >
        Back to Dashboard
      </button>
    </div>
  )

  return (
    <div className="flex flex-col min-h-full">
      <div className="flex items-center gap-2 p-4 border-b border-themed">
        <button onClick={() => router.back()} aria-label="Back" className="p-2.5 -m-2.5">
          <ArrowLeft className="w-5 h-5 text-secondary-themed" />
        </button>
        <div className="flex items-center gap-2">
          <Wrench className="w-4 h-4" style={{ color: 'var(--accent-amber)' }} />
          <span className="font-bold text-sm text-primary-themed">Work Order</span>
          {wo.wo_number && (
            <span className="text-xs text-muted-themed">{wo.wo_number}</span>
          )}
        </div>
      </div>

      <div className="p-4 space-y-4">
        <div>
          <h1 className="font-bold text-primary-themed text-base">{wo.title}</h1>
          {property?.name && (
            <p className="text-sm text-secondary-themed mt-0.5">{property.name}</p>
          )}
          {displayDate && (
            <p className="text-xs text-muted-themed mt-0.5">
              {displayDate.kind === 'appointment' ? 'Scheduled' : 'Needed by'}:{' '}
              {new Date(displayDate.value).toLocaleDateString('en-US', {
                weekday: 'long', month: 'long', day: 'numeric',
              })}
            </p>
          )}
        </div>

        {wo.description && (
          <div>
            <h2 className="text-xs font-bold text-muted-themed uppercase tracking-wide mb-1">
              Description
            </h2>
            <p className="text-sm text-primary-themed whitespace-pre-wrap">{wo.description}</p>
          </div>
        )}

        {/* `cancelled` as well as `completed`: nothing removes a cancelled
            work order from the device — the crew sync pulls by
            assigned_crew_member_id with no status filter, and only the crew
            LIST filters cancelled out. This detail page offered the full
            completion form on one, and the server accepted it (its
            .neq('status','completed') matched a cancelled row), running the
            whole side-effect chain including the owner_transactions
            maintenance expense for work that was called off. */}
        {/* Start Work. A work order has no checklist to infer a start from
            (checklist_instances.turnover_id is NOT NULL, so checklists belong
            to turnovers), so without this tap a crew work order goes straight
            from assigned to completed and the PM never sees it in progress.
            Shown only before the work is under way; `in_progress` and beyond
            fall through to the chip below. Completing without starting stays
            allowed, because plenty of these are five-minute jobs. */}
        {(wo.status === 'assigned' || wo.status === 'pending') && (
          <div className="pt-4 border-t border-themed">
            <button
              onClick={handleStart}
              disabled={starting}
              className="w-full rounded-xl py-3 font-bold text-sm flex items-center justify-center gap-2 border disabled:opacity-60"
              style={{
                borderColor: 'var(--accent-gold)',
                color:       'var(--accent-gold)',
                background:  'transparent',
              }}
            >
              <Play className="w-4 h-4" />
              {starting ? 'Starting...' : 'Start Work'}
            </button>
            <p className="text-xs text-muted-themed text-center mt-2">
              Lets your manager see this is under way.
            </p>
            {startError && (
              <p className="text-sm text-center mt-2" style={{ color: 'var(--accent-red)' }}>
                {startError}
              </p>
            )}
          </div>
        )}

        {wo.status === 'in_progress' && (
          <div
            className="rounded-xl p-3 text-center border"
            style={{ background: 'var(--accent-gold-dim)', borderColor: 'var(--accent-gold-dim)' }}
          >
            <p className="text-sm font-bold" style={{ color: 'var(--accent-gold)' }}>
              In progress
            </p>
          </div>
        )}

        {wo.status !== 'completed' && wo.status !== 'cancelled' && (
          <div className="pt-4 border-t border-themed">
            <h2 className="text-xs font-bold text-muted-themed uppercase tracking-wide mb-2">
              Completion Notes (optional)
            </h2>
            <textarea
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Describe what was done, any issues found..."
              rows={3}
              className="w-full rounded-lg border border-themed px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
            />
            <button
              onClick={handleComplete}
              disabled={completing}
              className="mt-3 w-full rounded-xl py-3 font-bold text-sm text-brand-900 disabled:opacity-60"
              style={{ background: 'var(--accent-gold)' }}
            >
              {completing ? 'Marking Complete...' : 'Mark Work Complete'}
            </button>
            {completeError && (
              <p className="text-sm text-center mt-2" style={{ color: 'var(--accent-red)' }}>
                {completeError}
              </p>
            )}
          </div>
        )}

        {wo.status === 'cancelled' && (
          <div
            className="rounded-xl p-3 text-center border"
            style={{ background: 'var(--accent-red-dim)', borderColor: 'var(--accent-red)' }}
            role="alert"
          >
            <p className="text-sm font-bold" style={{ color: 'var(--accent-red)' }}>
              This work order was cancelled
            </p>
            <p className="text-sm mt-0.5" style={{ color: 'var(--accent-red)' }}>
              No need to do this one. Check with your manager before doing any more work on it.
            </p>
          </div>
        )}

        {wo.status === 'completed' && (
          <div className="rounded-xl p-3 text-center border" style={{ background: 'var(--accent-green-dim)', borderColor: 'var(--accent-green-dim)' }}>
            <p className="text-sm font-bold flex items-center justify-center gap-1" style={{ color: 'var(--accent-green)' }}><Check className="w-4 h-4" /> Completed</p>
          </div>
        )}
      </div>
    </div>
  )
}
