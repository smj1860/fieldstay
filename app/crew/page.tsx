'use client'
import { usePowerSyncQuery } from '@powersync/react'
import Link from 'next/link'
import { CalendarCheck, Clock, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export default function CrewDashboardPage() {
  const today   = new Date().toISOString().split('T')[0]
  const weekOut = new Date(Date.now() + 7 * 86_400_000).toISOString().split('T')[0]

  type TurnoverRow = { id: string; status: string; priority: string; checkout_datetime: string; window_minutes: number | null }
  const turnovers = usePowerSyncQuery<TurnoverRow>(
    `SELECT * FROM turnovers
     WHERE date(checkout_datetime) >= ? AND date(checkout_datetime) <= ?
       AND status != 'completed' AND status != 'cancelled'
     ORDER BY checkout_datetime ASC`,
    [today, weekOut]
  )

  if (!turnovers?.length) {
    return (
      <div className="text-center py-20">
        <CalendarCheck className="w-10 h-10 text-accent-300 mx-auto mb-3" />
        <p className="font-semibold text-accent-700">No upcoming assignments</p>
        <p className="text-sm text-accent-400 mt-1">You're all caught up.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold text-accent-900">My Assignments</h2>
      {turnovers.map((t) => {
        const checkout = new Date(t.checkout_datetime)
        const isToday  = checkout.toDateString() === new Date().toDateString()
        const isUrgent = t.priority === 'urgent' || t.priority === 'high'

        return (
          <Link
            key={t.id}
            href={`/crew/turnovers/${t.id}`}
            className={cn(
              'block bg-white rounded-xl border p-4 transition-shadow hover:shadow-md',
              isUrgent ? 'border-amber-300' : 'border-accent-200'
            )}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className={cn(
                'text-xs font-semibold px-2 py-0.5 rounded-full',
                t.status === 'assigned'    ? 'bg-blue-50 text-blue-700' :
                t.status === 'in_progress' ? 'bg-purple-50 text-purple-700' :
                'bg-accent-100 text-accent-600'
              )}>
                {t.status === 'assigned' ? 'Assigned' :
                 t.status === 'in_progress' ? 'In Progress' : t.status}
              </span>
              {isUrgent && (
                <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
              )}
            </div>
            <div className="flex items-center gap-2 text-sm text-accent-600">
              <span className="font-medium text-accent-800">
                {isToday
                  ? 'Today'
                  : checkout.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
              <span>·</span>
              <span>{checkout.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
              {t.window_minutes && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    {Math.floor(t.window_minutes / 60)}h
                    {t.window_minutes % 60 > 0 ? ` ${t.window_minutes % 60}m` : ''}
                  </span>
                </>
              )}
            </div>
          </Link>
        )
      })}
    </div>
  )
}
