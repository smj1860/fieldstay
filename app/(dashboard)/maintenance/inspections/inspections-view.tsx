'use client'

// The inspections list, and the control that starts a new one.
//
// ─────────────────────────────────────────────────────────────────────────────
// RENDERED FROM DEXIE, NOT FROM THE SERVER
//
// This page used to be a Server Component, and the reasoning at the time was
// sound: starting an inspection had to be online anyway, so there was nothing
// to gain from a cache. That stopped being true on 2026-08-23, when a walk
// became startable offline (20260823053931).
//
// The consequence is not optional. If you can start an inspection with no
// signal, you have to be able to SEE it — otherwise a PM starts a walk at a
// property, backgrounds the app, and finds an empty list with no way back to
// the inspection they are halfway through. And per public/sw.js the route can
// only join the offline allowlist once it renders from the local cache, since
// a cached server-rendered document is a roster from last Tuesday.
//
// So the properties and the inspections both come from the local cache, kept
// current by warmInspectionsForOffline.

import { useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLiveQuery } from 'dexie-react-hooks'
import { CalendarClock, ClipboardCheck, Plus, WifiOff } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Dialog } from '@/components/ui/Dialog'
import { getDashboardDb } from '@/lib/dexie/dashboard/schema'
import { startInspectionLocally } from '@/lib/dexie/dashboard/start-inspection-local'
import { warmInspectionsForOffline } from '@/lib/dexie/dashboard/warm-inspections'
import { dueLabel, selectDueSchedules, todayISO } from '@/lib/inspections/due-schedules'
import { parseFormSnapshot } from '@/lib/inspections/snapshots'

import { MaintenanceTabs } from '../maintenance-tabs'
import { SafetyCadenceCard } from './safety-cadence-card'

const FORM_LABELS: Record<string, string> = {
  safety:  'Safety & Risk Mitigation',
  indoor:  'Indoor Property & Inventory',
  outdoor: 'Outdoor Property & Grounds',
}

interface Props {
  userId: string
  orgId:  string
}

export function InspectionsView({ userId, orgId }: Readonly<Props>) {
  const router = useRouter()
  const db = useMemo(() => getDashboardDb(userId, orgId), [userId, orgId])

  const [starting, startTransition] = useTransition()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [propertyId, setPropertyId] = useState('')
  const [formKey, setFormKey]       = useState('safety')
  const [error, setError]           = useState<string | null>(null)
  /** Which due schedule is mid-start, so only its own button shows a spinner. */
  const [startingScheduleId, setStartingScheduleId] = useState<string | null>(null)
  // Its OWN error, not the dialog's. Sharing one made a failed dialog start
  // render its message twice — once in the dialog and once under a Due list it
  // had nothing to do with.
  const [scheduleError, setScheduleError] = useState<string | null>(null)

  // A warm on mount, forced past the throttle. This is the page a PM opens
  // before leaving, so it is the one place worth paying for a guaranteed
  // refresh of the form library rather than accepting a 15-minute-old copy.
  useEffect(() => { void warmInspectionsForOffline(userId, orgId, { force: true }) }, [userId, orgId])

  const properties  = useLiveQuery(() => db.properties.orderBy('name').toArray(), [db], [])
  const inspections = useLiveQuery(
    () => db.inspections.toArray().then((rows) =>
      rows.sort((a, b) => b.started_at.localeCompare(a.started_at))),
    [db],
    [],
  )
  const forms = useLiveQuery(
    () => db.inspection_forms.filter((f) => f.is_active).toArray(),
    [db],
    [],
  )
  const schedules = useLiveQuery(() => db.maintenance_schedules.toArray(), [db], [])

  const propertyName = (id: string) =>
    (properties ?? []).find((p) => p.id === id)?.name ?? 'Unknown property'

  // Computed here rather than filtered at fetch time: a horizon baked into the
  // query goes stale the moment the device loses signal, and a tablet that has
  // been offline for a week should still be able to tell that last Tuesday's
  // walk is now overdue.
  const dueSchedules = useMemo(
    () => selectDueSchedules(schedules ?? [], inspections ?? [], todayISO()),
    [schedules, inspections],
  )

  // The library is what makes a start possible with no signal. Its absence is
  // reported as its own state rather than as an empty property list, because
  // "you have no properties" and "this device has never synced" are different
  // problems with different fixes.
  const libraryReady = (forms?.length ?? 0) > 0 && (properties?.length ?? 0) > 0

  const begin = () => {
    setError(null)
    startTransition(async () => {
      const result = await startInspectionLocally(userId, orgId, { propertyId, formKey })
      if (!result.ok) { setError(result.error); return }
      setDialogOpen(false)
      router.push(`/maintenance/inspections/${result.inspectionId}`)
    })
  }

  /**
   * Starting the walk a schedule is asking for.
   *
   * The whole point of the link it carries: `source_schedule_id` is what lets
   * COMPLETION advance the schedule. Without it the due notification fires once
   * per occurrence, `next_due_date` never moves, and the schedule goes silent
   * forever — so a walk started here and one started from the dialog are not
   * interchangeable, even at the same property with the same form.
   *
   * `scheduledFor` records the date the schedule SAID it was due, which is not
   * the date the walk happened and is the one a report should cite.
   */
  const beginFromSchedule = (schedule: { id: string; property_id: string; inspection_form_id: string | null; next_due_date: string }) => {
    setScheduleError(null)
    setStartingScheduleId(schedule.id)
    startTransition(async () => {
      try {
        const key = (forms ?? []).find((f) => f.id === schedule.inspection_form_id)?.key
        if (!key) {
          // The schedule names a form this device does not hold — a re-seed
          // since the last warm, or a never-synced tablet. Named as its own
          // problem rather than surfacing as a generic start failure.
          setScheduleError('That schedule’s form isn’t on this device yet. Reconnect once, then try again.')
          return
        }
        const result = await startInspectionLocally(userId, orgId, {
          propertyId:       schedule.property_id,
          formKey:          key,
          sourceScheduleId: schedule.id,
          scheduledFor:     schedule.next_due_date,
        })
        if (!result.ok) { setScheduleError(result.error); return }
        router.push(`/maintenance/inspections/${result.inspectionId}`)
      } finally {
        setStartingScheduleId(null)
      }
    })
  }

  return (
    <div className="flex flex-col">
      <MaintenanceTabs />
      <div className="p-4 sm:p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Inspections
          </h1>
          <Button
            variant="cta"
            onClick={() => setDialogOpen(true)}
            disabled={!libraryReady}
            className="flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Start inspection
          </Button>
        </div>

        {/* ONLINE ONLY, and it renders itself away when there is no signal —
            see safety-cadence-card.tsx. A setting shown from a week-old cache
            is worse than a setting that is simply not there. */}
        <SafetyCadenceCard />

        {!libraryReady && (
          <Card>
            <p className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <WifiOff className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
              <span>
                This device hasn’t downloaded the inspection forms yet. Open this page
                once with a connection and they’ll stay available offline afterwards.
              </span>
            </p>
          </Card>
        )}

        {/* DUE FIRST. A schedule that came due is the reason a PM opened this
            page; an inspection already under way is something they can find by
            looking. Absent entirely when nothing is due — an empty "Due" card
            is a row of furniture on a page that has to work on a phone. */}
        {libraryReady && dueSchedules.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}>
              Due now
            </h2>
            <ul className="flex flex-col gap-2">
              {dueSchedules.map((s) => (
                <li key={s.id}>
                  <Card>
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold truncate"
                              style={{ color: 'var(--text-primary)' }}>
                          {propertyName(s.property_id)}
                        </span>
                        <span className="flex items-center gap-1.5 text-xs mt-0.5"
                              style={{ color: 'var(--text-muted)' }}>
                          <CalendarClock className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{s.name}</span>
                        </span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <Badge tone={s.overdue ? 'red' : 'amber'}>{dueLabel(s)}</Badge>
                        <Button
                          variant="cta"
                          onClick={() => beginFromSchedule(s)}
                          disabled={starting}
                        >
                          {startingScheduleId === s.id ? 'Starting…' : 'Start'}
                        </Button>
                      </span>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
            {scheduleError && (
              <p className="text-xs" style={{ color: 'var(--accent-red)' }} role="alert">
                {scheduleError}
              </p>
            )}
          </section>
        )}

        {libraryReady && (inspections?.length ?? 0) === 0 && (
          <Card>
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <ClipboardCheck className="w-8 h-8" style={{ color: 'var(--text-muted)' }} />
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                No inspections in progress
              </p>
              <p className="text-xs max-w-sm" style={{ color: 'var(--text-muted)' }}>
                An inspection records the condition of a property at a point in time, and
                the history builds into the record an insurer can be shown.
              </p>
            </div>
          </Card>
        )}

        {(inspections?.length ?? 0) > 0 && (
          <section className="flex flex-col gap-2">
            {/* Labelled only when there is a "Due now" section above it. On its
                own the h1 already names the list, and a lone subheading over
                the page's only content is noise. */}
            {dueSchedules.length > 0 && (
              <h2 className="text-xs font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}>
                Walks
              </h2>
            )}
            <ul className="flex flex-col gap-2">
              {(inspections ?? []).map((row) => (
                <li key={row.id}>
                  <Card>
                    <Link
                      href={`/maintenance/inspections/${row.id}`}
                      className="flex items-center justify-between gap-3 focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)] rounded-lg"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold truncate"
                              style={{ color: 'var(--text-primary)' }}>
                          {propertyName(row.property_id)}
                        </span>
                        <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {formLabel(row.form_snapshot)} &middot; v{row.form_version}
                          {' · '}
                          {new Date(row.started_at).toLocaleDateString()}
                          {row.inspector_name ? ` · ${row.inspector_name}` : ''}
                        </span>
                      </span>
                      <Badge tone={row.completed_at ? 'green' : 'amber'}>
                        {row.completed_at ? 'Complete' : 'In progress'}
                      </Badge>
                    </Link>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        )}

        {dialogOpen && (
          <Dialog
            open
            onClose={() => setDialogOpen(false)}
            title="Start an inspection"
            mobileSheet
            maxWidthClassName="max-w-md"
            footer={
              <div className="flex gap-2 w-full">
                <Button variant="secondary" onClick={() => setDialogOpen(false)} className="flex-1">
                  Cancel
                </Button>
                <Button
                  variant="cta"
                  onClick={begin}
                  disabled={!propertyId || starting}
                  className="flex-1"
                >
                  {starting ? 'Starting…' : 'Start'}
                </Button>
              </div>
            }
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="inspection-property" className="text-xs font-semibold"
                       style={{ color: 'var(--text-secondary)' }}>
                  Property
                </label>
                <select
                  id="inspection-property"
                  value={propertyId}
                  onChange={(e) => setPropertyId(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  <option value="">Select a property…</option>
                  {(properties ?? []).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="inspection-form" className="text-xs font-semibold"
                       style={{ color: 'var(--text-secondary)' }}>
                  Form
                </label>
                <select
                  id="inspection-form"
                  value={formKey}
                  onChange={(e) => setFormKey(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  {/* From the CACHED forms, not a hardcoded list — the options
                      have to be the forms this device can actually walk. */}
                  {(forms ?? []).map((f) => (
                    <option key={f.id} value={f.key}>{FORM_LABELS[f.key] ?? f.name}</option>
                  ))}
                </select>
              </div>

              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Works with no connection. The start time is taken from this device and
                corrected against the server clock when it syncs, and the report records
                that it was device-timed.
              </p>

              {error && (
                <p className="text-xs" style={{ color: 'var(--accent-red)' }} role="alert">
                  {error}
                </p>
              )}
            </div>
          </Dialog>
        )}
      </div>
    </div>
  )
}

/**
 * The form's identity from the SNAPSHOT, not from a join to the live form.
 * §5 freezes it precisely so a later re-seed cannot restate which form a
 * finished inspection was.
 */
function formLabel(snapshot: unknown): string {
  const parsed = parseFormSnapshot(snapshot)
  if (!parsed) return 'Unknown form'
  return FORM_LABELS[parsed.form_key] ?? parsed.form_key
}
