'use client'

// The inspections list, and the one control that starts a new one.
//
// Starting is a Server Action call rather than a link, because
// docs/INSPECTIONS_SPEC.md §8 requires the row — and its SERVER-CLOCK
// `started_at` — to exist before any filling happens. A page that let you begin
// answering and created the row later would be trusting a device clock for the
// one timestamp whose value is being believed.

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ClipboardCheck, Plus } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Dialog } from '@/components/ui/Dialog'

import { startInspection } from './actions'

interface PropertyOption { id: string; name: string }

interface InspectionRow {
  id:            string
  propertyId:    string
  startedAt:     string
  completedAt:   string | null
  inspectorName: string | null
  formKey:       string
  formVersion:   number
}

const FORM_LABELS: Record<string, string> = {
  safety:  'Safety & Risk Mitigation',
  indoor:  'Indoor Property & Inventory',
  outdoor: 'Outdoor Property & Grounds',
}

const FORM_KEYS = ['safety', 'indoor', 'outdoor'] as const

interface Props {
  properties:  PropertyOption[]
  inspections: InspectionRow[]
  /** True when a query ERRORED, which is not the same as having no inspections. */
  loadFailed:  boolean
}

export function InspectionsView({ properties, inspections, loadFailed }: Readonly<Props>) {
  const router = useRouter()
  const [starting, startTransition] = useTransition()
  const [dialogOpen, setDialogOpen]   = useState(false)
  const [propertyId, setPropertyId]   = useState('')
  const [formKey, setFormKey]         = useState<(typeof FORM_KEYS)[number]>('safety')
  const [error, setError]             = useState<string | null>(null)

  const propertyName = (id: string) => properties.find((p) => p.id === id)?.name ?? 'Unknown property'

  const begin = () => {
    setError(null)
    startTransition(async () => {
      const result = await startInspection({ propertyId, formKey })
      if (!result.ok || !result.inspectionId) {
        setError(result.error ?? 'Could not start the inspection.')
        return
      }
      setDialogOpen(false)
      // refresh(), NOT a push to /maintenance/inspections/[id] — that route does
      // not exist yet, and navigating to it would 404 a PM who has just
      // successfully created an inspection. The row is real and appears in the
      // list below as In progress; the fill screen replaces this line.
      router.refresh()
    })
  }

  return (
    <div className="p-4 sm:p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Inspections
        </h1>
        <Button
          variant="cta"
          onClick={() => setDialogOpen(true)}
          disabled={properties.length === 0}
          className="flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Start inspection
        </Button>
      </div>

      {loadFailed && (
        <Card>
          <p className="text-sm" style={{ color: 'var(--accent-red)' }}>
            Some of this page didn&rsquo;t load. What you see below may be incomplete —
            reload before relying on it.
          </p>
        </Card>
      )}

      {inspections.length === 0 && !loadFailed && (
        <Card>
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <ClipboardCheck className="w-8 h-8" style={{ color: 'var(--text-muted)' }} />
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              No inspections yet
            </p>
            <p className="text-xs max-w-sm" style={{ color: 'var(--text-muted)' }}>
              An inspection records the condition of a property at a point in time, and
              the history builds into the record an insurer can be shown.
            </p>
          </div>
        </Card>
      )}

      {inspections.length > 0 && (
        <ul className="flex flex-col gap-2">
          {inspections.map((row) => (
            <li key={row.id}>
              <Card>
                <a
                  href={`/maintenance/inspections/${row.id}`}
                  className="flex items-center justify-between gap-3 focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)] rounded-lg"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold truncate"
                          style={{ color: 'var(--text-primary)' }}>
                      {propertyName(row.propertyId)}
                    </span>
                    <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {FORM_LABELS[row.formKey] ?? row.formKey} &middot; v{row.formVersion}
                      {' · '}
                      {new Date(row.startedAt).toLocaleDateString()}
                      {row.inspectorName ? ` · ${row.inspectorName}` : ''}
                    </span>
                  </span>
                  <Badge tone={row.completedAt ? 'green' : 'amber'}>
                    {row.completedAt ? 'Complete' : 'In progress'}
                  </Badge>
                </a>
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
                {properties.map((p) => (
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
                onChange={(e) => setFormKey(e.target.value as (typeof FORM_KEYS)[number])}
                className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              >
                {FORM_KEYS.map((key) => (
                  <option key={key} value={key}>{FORM_LABELS[key]}</option>
                ))}
              </select>
            </div>

            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              The start time is recorded now, from the server. Once started, the
              inspection can be filled in without a connection.
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
  )
}
