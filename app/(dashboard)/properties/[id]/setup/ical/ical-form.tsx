'use client'

import { useActionState, useEffect, useState } from 'react'
import { addIcalFeed, deleteIcalFeed, completeIcalStep, triggerSingleFeedSync } from './actions'
import { Plus, Trash2, RefreshCw, Link as LinkIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { IcalFeed } from '@/types/database'

const SOURCES = [
  { value: 'airbnb',      label: 'Airbnb' },
  { value: 'vrbo',        label: 'VRBO' },
  { value: 'booking_com', label: 'Booking.com' },
  { value: 'direct',      label: 'Direct / Other' },
]

const SOURCE_INSTRUCTIONS: Record<string, string> = {
  airbnb:      'Airbnb → Calendar → Export Calendar → copy the .ics URL',
  vrbo:        'VRBO → Calendar → Export → copy the .ics URL',
  booking_com: 'Booking.com → Calendar → Sync/Export → copy the .ics link',
  direct:      'Paste the iCal (.ics) URL from your booking platform',
}

export function IcalManager({
  propertyId,
  feeds,
}: {
  propertyId: string
  feeds: IcalFeed[]
}) {
  const addAction = addIcalFeed.bind(null, propertyId)
  const [state, formAction, pending] = useActionState(addAction, null)
  const [showForm, setShowForm] = useState(feeds.length === 0)
  const [selectedSource, setSelectedSource] = useState('airbnb')
  const [completing, setCompleting] = useState(false)

  // Close form on successful submission
  useEffect(() => {
    if (state?.success) setShowForm(false)
  }, [state?.success])

  return (
    <div className="space-y-6">
      {/* Existing feeds */}
      {feeds.length > 0 && (
        <div className="space-y-3">
          {feeds.map((feed) => (
            <div
              key={feed.id}
              className="flex items-center gap-3 px-4 py-3 bg-canvas-themed rounded-lg border border-themed"
            >
              <LinkIcon className="w-4 h-4 text-muted-themed flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-primary-themed">{feed.name}</p>
                <p className="text-xs text-muted-themed truncate">{feed.url}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {feed.last_sync_status === 'success' && (
                  <span className="badge badge-green">Synced</span>
                )}
                {feed.last_sync_status === 'error' && (
                  <span className="badge badge-red">Error</span>
                )}
                {feed.last_sync_status === 'pending' && (
                  <span className="badge badge-slate">Pending</span>
                )}
                <button
                  onClick={async () => { await triggerSingleFeedSync(feed.id, propertyId) }}
                  className="text-muted-themed hover:text-secondary-themed transition-colors p-1"
                  title="Sync this feed now"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
                <form action={async () => {
                  await deleteIcalFeed(feed.id, propertyId)
                }}>
                  <button type="submit" className="text-muted-themed hover:text-red-500 transition-colors p-1">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add feed form */}
      {showForm ? (
        <div className="border border-themed rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-primary-themed">Add Calendar Feed</h3>

          {state?.error && (
            <div className="border text-sm rounded-lg px-3 py-2" style={{ background: 'var(--accent-red-dim)', borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}>
              {state.error}
            </div>
          )}

          <form action={(fd) => {
            const url = (fd.get('url') as string)?.trim()
            if (url && !url.startsWith('https://')) {
              alert('iCal feed URLs must start with https://')
              return
            }
            formAction(fd)
          }} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="ical-source" className="label">Platform</label>
                <select
                  id="ical-source"
                  name="source"
                  value={selectedSource}
                  onChange={(e) => setSelectedSource(e.target.value)}
                  className="input"
                >
                  {SOURCES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ical-name" className="label">Label</label>
                <input
                  id="ical-name"
                  name="name"
                  type="text"
                  defaultValue={SOURCES.find((s) => s.value === selectedSource)?.label}
                  className="input"
                  placeholder="e.g. Airbnb"
                />
              </div>
            </div>

            {SOURCE_INSTRUCTIONS[selectedSource] && (
              <p className="text-xs text-muted-themed bg-canvas-themed rounded-lg px-3 py-2">
                <span className="font-medium">How to find it: </span>
                {SOURCE_INSTRUCTIONS[selectedSource]}
              </p>
            )}

            <div>
              <label htmlFor="ical-url" className="label">Calendar URL (.ics)</label>
              <input
                id="ical-url"
                name="url"
                type="url"
                className="input font-mono text-xs"
                placeholder="https://www.airbnb.com/calendar/ical/..."
              />
            </div>

            <div className="flex gap-3">
              <button type="submit" disabled={pending} className="btn-primary">
                {pending ? 'Adding…' : 'Add Feed'}
              </button>
              {feeds.length > 0 && (
                <button type="button" onClick={() => setShowForm(false)} className="btn-ghost">
                  Cancel
                </button>
              )}
            </div>
          </form>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} className="btn-secondary w-full justify-center py-3 border-dashed">
          <Plus className="w-4 h-4" />
          Add Another Calendar
        </button>
      )}

      {/* Continue */}
      <div className="flex items-center gap-3 pt-4 border-t border-themed">
        <form action={async () => {
          setCompleting(true)
          await completeIcalStep(propertyId)
        }}>
          <button type="submit" disabled={completing} className="btn-primary">
            {completing ? 'Saving…' : feeds.length > 0 ? 'Save & Continue →' : 'Skip for now →'}
          </button>
        </form>
        <span className="text-xs text-muted-themed">
          {feeds.length === 0 && 'You can add calendars later'}
        </span>
      </div>
    </div>
  )
}
