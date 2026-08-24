import Link from 'next/link'

import { Badge } from '@/components/ui/Badge'
import { upcomingLabel } from '@/lib/inspections/due-schedules'
import type { UpcomingInspection } from '@/lib/inspections/upcoming-for-dashboard'

// The dashboard's Upcoming Inspections section.
//
// §9: "an Upcoming Inspections section, hidden until an inspection is within
// 30 days. Overdue stays visible and is styled as overdue."
//
// HIDDEN, NOT EMPTY. An org with nothing scheduled in the next month should see
// the dashboard it had before this feature existed, not a card announcing that
// nothing is happening. Every other section on this page earns its space the
// same way.
//
// No Start button here on purpose. Starting a walk stamps `started_at` from the
// server and is the moment the inspection row is created (§7) — it belongs on
// the surface that can then hand you the form, which is
// /maintenance/inspections. A Start on the dashboard would create a walk and
// then navigate you somewhere else to fill it in, and a mis-tap would leave an
// open inspection nobody meant to begin.

export function UpcomingInspections({
  inspections,
}: Readonly<{ inspections: UpcomingInspection[] }>) {
  if (inspections.length === 0) return null

  const overdueCount = inspections.filter((i) => i.overdue).length

  return (
    <div
      className="rounded-xl p-4 mb-6"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <p
          className="text-xs font-semibold uppercase tracking-wide"
          style={{ color: 'var(--text-muted)' }}
        >
          Upcoming inspections
          {/* The overdue count is in the heading rather than only in the rows:
              a PM scanning the dashboard should not have to read a list to find
              out something is late. */}
          {overdueCount > 0 && (
            <span style={{ color: 'var(--accent-red)' }}>
              {' '}· {overdueCount} overdue
            </span>
          )}
        </p>
        <Link
          href="/maintenance/inspections"
          className="text-xs font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)] rounded"
          style={{ color: 'var(--accent-gold)' }}
        >
          View all
        </Link>
      </div>

      <ul className="space-y-2">
        {inspections.map((inspection) => (
          <InspectionRow key={inspection.id} inspection={inspection} />
        ))}
      </ul>
    </div>
  )
}

function InspectionRow({ inspection }: Readonly<{ inspection: UpcomingInspection }>) {
  return (
    <li className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
          {inspection.name}
        </p>
        {inspection.propertyName && (
          <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
            {inspection.propertyName}
          </p>
        )}
      </div>

      {/* Red for overdue, amber for due today, slate for merely upcoming. The
          three tones are the whole point of the section — a list where next
          week and three weeks late look identical is a list nobody reads. */}
      <Badge tone={rowTone(inspection)}>{upcomingLabel(inspection)}</Badge>
    </li>
  )
}

function rowTone(inspection: UpcomingInspection): 'red' | 'amber' | 'slate' {
  if (inspection.overdue)         return 'red'
  if (inspection.daysUntil === 0) return 'amber'
  return 'slate'
}
