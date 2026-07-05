'use client'

import { useEffect, useState }     from 'react'
import { useLiveQuery }            from 'dexie-react-hooks'
import { useDexieDb }              from '@/lib/dexie/context'
import { useRouter }              from 'next/navigation'
import { ArrowLeft, Wrench, CheckCircle2, Check } from 'lucide-react'
import type { PropertyRow } from '@/lib/dexie/schema'

export default function CrewWorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId]               = useState<string | null>(null)
  const [property, setProperty]   = useState<PropertyRow | null>(null)
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)
  const [notes, setNotes]         = useState('')
  const [done, setDone]           = useState(false)
  const db     = useDexieDb()
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

  async function handleComplete() {
    if (!id) return
    setCompleting(true)
    setCompleteError(null)
    try {
      const res = await fetch(`/api/crew/work-orders/${id}/complete`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ notes }),
      })
      if (!res.ok) throw new Error('Failed to mark complete')
      setDone(true)
      // Update local Dexie record so it drops off the home page immediately
      await db.crew_work_orders.update(id, { status: 'completed' })
    } catch {
      setCompleting(false)
      setCompleteError('Something went wrong. Please check your connection and try again.')
    }
  }

  if (!wo) return (
    <div className="p-4 text-sm text-muted-themed">Loading...</div>
  )

  if (done) return (
    <div className="p-6 text-center">
      <CheckCircle2 className="w-10 h-10 mx-auto mb-4" style={{ color: 'var(--accent-green)' }} />
      <h2 className="font-bold text-primary-themed text-lg mb-2">Work Complete</h2>
      <p className="text-sm text-muted-themed mb-6">Your PM has been notified.</p>
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
        <button onClick={() => router.back()}>
          <ArrowLeft className="w-5 h-5 text-secondary-themed" />
        </button>
        <div className="flex items-center gap-2">
          <Wrench className="w-4 h-4 text-amber-600" />
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
          {wo.scheduled_date && (
            <p className="text-xs text-muted-themed mt-0.5">
              Scheduled: {new Date(wo.scheduled_date).toLocaleDateString('en-US', {
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

        {wo.status !== 'completed' && (
          <div className="pt-4 border-t border-themed">
            <h2 className="text-xs font-bold text-muted-themed uppercase tracking-wide mb-2">
              Completion Notes (optional)
            </h2>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Describe what was done, any issues found..."
              rows={3}
              className="w-full rounded-lg border border-themed px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <button
              onClick={handleComplete}
              disabled={completing}
              className="mt-3 w-full rounded-xl py-3 font-bold text-sm text-brand-900 disabled:opacity-60"
              style={{ background: '#FCD116' }}
            >
              {completing ? 'Marking Complete...' : 'Mark Work Complete'}
            </button>
            {completeError && (
              <p className="text-sm text-center mt-2 text-red-600">
                {completeError}
              </p>
            )}
          </div>
        )}

        {wo.status === 'completed' && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-center">
            <p className="text-sm font-bold text-green-700 flex items-center justify-center gap-1"><Check className="w-4 h-4" /> Completed</p>
          </div>
        )}
      </div>
    </div>
  )
}
