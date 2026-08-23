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
import { ClipboardCheck, Plus, WifiOff } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Dialog } from '@/components/ui/Dialog'
import { getDashboardDb } from '@/lib/dexie/dashboard/schema'
import { startInspectionLocally } from '@/lib/dexie/dashboard/start-inspection-local'
import { warmInspectionsForOffline } from '@/lib/dexie/dashboard/warm-inspections'
import { parseFormSnapshot } from '@/lib/inspections/snapshots'

import { MaintenanceTabs } from '../maintenance-tabs'

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

  const propertyName = (id: string) =>
    (properties ?? []).find((p) => p.id === id)?.name ?? 'Unknown property'

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
