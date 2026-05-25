'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Camera, CheckCircle2, Circle } from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import Link from 'next/link'

export default function CrewTurnoverPage() {
  const { id } = useParams<{ id: string }>()
  const router  = useRouter()
  const db      = usePowerSync()

  const { data: turnovers } = usePowerSyncQuery(
    'SELECT * FROM turnovers WHERE id = ?', [id]
  )
  const turnover = turnovers?.[0]

  const { data: instances } = usePowerSyncQuery(
    'SELECT * FROM checklist_instances WHERE turnover_id = ?', [id]
  )
  const instance = instances?.[0]

  const { data: items } = usePowerSyncQuery(
    `SELECT * FROM checklist_instance_items WHERE instance_id = ?
     ORDER BY section_name, sort_order`,
    [instance?.id ?? '']
  )

  const completedCount = items?.filter((i) => i.is_completed).length ?? 0
  const totalCount     = items?.length ?? 0

  const sections = (items ?? []).reduce<Record<string, typeof items>>((acc, item) => {
    if (!acc[item.section_name]) acc[item.section_name] = []
    acc[item.section_name]!.push(item)
    return acc
  }, {})

  const toggleItem = async (itemId: string, current: number) => {
    await db.execute(
      'UPDATE checklist_instance_items SET is_completed = ? WHERE id = ?',
      [current ? 0 : 1, itemId]
    )
  }

  const markInProgress = async () => {
    await db.execute('UPDATE turnovers SET status = ? WHERE id = ?', ['in_progress', id])
  }

  const markComplete = async () => {
    await db.execute('UPDATE turnovers SET status = ? WHERE id = ?', ['completed', id])
    router.push('/crew')
  }

  if (!turnover) {
    return <div className="text-center py-20 text-accent-400">Loading…</div>
  }

  return (
    <div>
      <Link href="/crew" className="flex items-center gap-1.5 text-sm text-accent-400 hover:text-accent-600 mb-4">
        <ArrowLeft className="w-3.5 h-3.5" />
        Back
      </Link>

      {/* Header */}
      <div className="bg-white rounded-xl border border-accent-200 p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className={cn(
            'text-xs font-semibold px-2 py-0.5 rounded-full',
            turnover.priority === 'urgent' ? 'bg-red-50 text-red-600' :
            turnover.priority === 'high'   ? 'bg-amber-50 text-amber-700' :
            'bg-accent-100 text-accent-600'
          )}>
            {turnover.priority} priority
          </span>
          {turnover.window_minutes && (
            <span className="text-sm font-medium text-accent-600">
              {Math.floor(turnover.window_minutes / 60)}h{' '}
              {turnover.window_minutes % 60 > 0 ? `${turnover.window_minutes % 60}m` : ''} window
            </span>
          )}
        </div>
        <div className="text-sm text-accent-600 space-y-1">
          <p><span className="text-accent-400">Checkout:</span> {formatDateTime(turnover.checkout_datetime)}</p>
          <p><span className="text-accent-400">Check-in:</span> {formatDateTime(turnover.checkin_datetime)}</p>
        </div>
        {turnover.notes && (
          <p className="mt-2 text-sm text-accent-600 bg-amber-50 rounded-lg px-3 py-2">
            {turnover.notes}
          </p>
        )}
      </div>

      {/* Checklist progress */}
      {totalCount > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-semibold text-accent-700">
              Checklist — {completedCount}/{totalCount}
            </span>
            <span className="text-sm text-accent-500">
              {Math.round((completedCount / totalCount) * 100)}%
            </span>
          </div>
          <div className="h-2 bg-accent-100 rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                completedCount === totalCount ? 'bg-green-500' : 'bg-brand-600'
              )}
              style={{ width: `${Math.round((completedCount / totalCount) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Sections */}
      {Object.entries(sections).map(([section, sectionItems]) => (
        <div key={section} className="mb-4">
          <h3 className="text-xs font-semibold text-accent-500 uppercase tracking-wide mb-2">
            {section}
          </h3>
          <div className="bg-white rounded-xl border border-accent-200 divide-y divide-accent-100 overflow-hidden">
            {sectionItems!.map((item) => (
              <button
                key={item.id}
                onClick={() => toggleItem(item.id, item.is_completed)}
                className={cn(
                  'w-full flex items-start gap-3 px-4 py-3 text-left transition-colors',
                  item.is_completed ? 'bg-green-50' : 'hover:bg-accent-50'
                )}
              >
                {item.is_completed
                  ? <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
                  : <Circle className="w-5 h-5 text-accent-300 flex-shrink-0 mt-0.5" />
                }
                <span className={cn(
                  'text-sm',
                  item.is_completed ? 'text-green-700 line-through' : 'text-accent-800'
                )}>
                  {item.task}
                </span>
                {item.requires_photo && (
                  <Camera className={cn(
                    'w-4 h-4 flex-shrink-0 ml-auto',
                    item.photo_storage_path ? 'text-green-500' : 'text-accent-300'
                  )} />
                )}
              </button>
            ))}
          </div>
        </div>
      ))}

      {totalCount === 0 && (
        <div className="bg-white rounded-xl border border-accent-200 p-6 text-center text-accent-400 text-sm mb-4">
          No checklist for this turnover.
        </div>
      )}

      {/* Actions */}
      <div className="space-y-2 pb-8">
        {turnover.status === 'assigned' && (
          <button onClick={markInProgress} className="btn-secondary w-full py-3">
            Start Turnover
          </button>
        )}
        <button
          onClick={markComplete}
          disabled={turnover.status === 'completed'}
          className="btn-primary w-full py-3"
        >
          {turnover.status === 'completed' ? '✓ Complete' : 'Mark as Complete'}
        </button>
      </div>
    </div>
  )
}
