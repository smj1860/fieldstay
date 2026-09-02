// app/(dashboard)/properties/[id]/history/page.tsx
//
// "Show me what happened" — Implementation Instructions, Workstream 1: the
// primary deliverable. Pick a property (already picked, via the route),
// pick a date range, read what happened in chronological order — checklist
// steps, photos inline, work order status changes, crew assignments,
// inspections, inventory counts. An assembly job over lib/history/
// loadPropertyHistory.ts, which already states its own read caps.
//
// requireProperty() both org-scopes and IDOR-checks the property id in one
// call (lib/auth.ts) — the same helper ../page.tsx uses.

import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import { requireProperty } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { toStorageObjectPath } from '@/lib/storage/object-path'
import { Card } from '@/components/ui/Card'
import { buttonVariantClass } from '@/components/ui/Button'
import { ArrowLeft, Download } from 'lucide-react'
import {
  loadPropertyHistory,
  type PropertyHistoryEvent,
  type PropertyHistoryEventType,
} from '@/lib/history/loadPropertyHistory'

export const metadata: Metadata = { title: 'Property History' }

const WORK_ORDER_PHOTO_BUCKET = 'work-order-photos'
const CHECKLIST_PHOTO_BUCKET  = 'turnover-photos'
const PHOTO_SIGNED_URL_TTL_SECONDS = 300 // 5 minutes — view-only, this page never links or embeds it elsewhere

const EVENT_LABELS: Record<PropertyHistoryEventType, string> = {
  checklist_step:        'Checklist',
  work_order_update:     'Work order',
  work_order_photo:      'Work order',
  crew_assignment:       'Crew',
  inspection_submitted:  'Inspection',
  inventory_count:       'Inventory',
}

/** `YYYY-MM-DD` N days before today, for the default range. */
function daysAgoDate(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

async function signPhotoUrls(
  paths: string[],
  bucket: string,
  membership: { org_id: string; role: string },
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const objectPaths = paths.flatMap((p) => {
    const path = toStorageObjectPath(bucket, p)
    return path ? [{ original: p, path }] : []
  })
  if (!objectPaths.length) return map

  // Signing needs service role — storage RLS is bypassed the same way
  // maintenance/actions.ts's getWorkOrderPhotoUrls() does it. The read that
  // found these paths already went through the session-scoped client and
  // requireProperty()'s org check above.
  const service = createServiceClient({ authorizedBy: membership })
  const { data: signed, error } = await service.storage
    .from(bucket)
    .createSignedUrls(objectPaths.map((p) => p.path), PHOTO_SIGNED_URL_TTL_SECONDS)

  if (error || !signed) return map
  objectPaths.forEach((p, i) => {
    const url = signed[i]?.signedUrl
    if (url) map.set(p.original, url)
  })
  return map
}

interface Props {
  params:       Promise<{ id: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}

export default async function PropertyHistoryPage({ params, searchParams }: Readonly<Props>) {
  const { id } = await params
  const { property, supabase, membership } = await requireProperty(id)

  const { from: fromParam, to: toParam } = await searchParams
  const from = fromParam || daysAgoDate(30)
  const to   = toParam   || daysAgoDate(0)

  const { events, totalCount, omittedCount } = await loadPropertyHistory({
    supabase,
    orgId:      membership.org_id,
    propertyId: id,
    from:       `${from}T00:00:00.000Z`,
    to:         `${to}T23:59:59.999Z`,
  })

  const checklistPaths = events.flatMap((e) => (e.type === 'checklist_step' && e.photoStoragePath ? [e.photoStoragePath] : []))
  const woPhotoPaths    = events.flatMap((e) => (e.type === 'work_order_photo' && e.photoStoragePath ? [e.photoStoragePath] : []))

  const [checklistPhotoUrls, woPhotoUrls] = await Promise.all([
    signPhotoUrls(checklistPaths, CHECKLIST_PHOTO_BUCKET, membership),
    signPhotoUrls(woPhotoPaths, WORK_ORDER_PHOTO_BUCKET, membership),
  ])

  const photoUrlFor = (event: PropertyHistoryEvent): string | null => {
    if (!event.photoStoragePath) return null
    if (event.type === 'checklist_step') return checklistPhotoUrls.get(event.photoStoragePath) ?? null
    if (event.type === 'work_order_photo') return woPhotoUrls.get(event.photoStoragePath) ?? null
    return null
  }

  const exportHref = `/api/properties/${id}/history/export?from=${from}&to=${to}`

  return (
    <div className="max-w-3xl">
      <Link
        href={`/properties/${id}`}
        className="text-sm inline-flex items-center gap-1 mb-4"
        style={{ color: 'var(--text-muted)' }}
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back to {property.name}
      </Link>

      <div className="flex items-center justify-between gap-4 mb-2 flex-wrap">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          What happened at {property.name}
        </h1>
        <a href={exportHref} className={buttonVariantClass('secondary') + ' text-sm flex items-center gap-1.5'}>
          <Download className="w-4 h-4" /> Export CSV
        </a>
      </div>
      <p className="text-xs mb-6" style={{ color: 'var(--text-muted)' }}>
        Every checklist step, photo, work order update, crew assignment, inspection, and inventory count
        recorded at this property, in order.
      </p>

      <form className="flex items-end gap-3 mb-6 flex-wrap" method="get">
        <div>
          <label htmlFor="from" className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>From</label>
          <input
            id="from" name="from" type="date" defaultValue={from} max={to}
            className="text-sm rounded-md px-2 py-1.5"
            style={{ border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
          />
        </div>
        <div>
          <label htmlFor="to" className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>To</label>
          <input
            id="to" name="to" type="date" defaultValue={to} min={from}
            className="text-sm rounded-md px-2 py-1.5"
            style={{ border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
          />
        </div>
        <button type="submit" className={buttonVariantClass('secondary') + ' text-sm'}>
          Update range
        </button>
      </form>

      {omittedCount > 0 && (
        <p className="text-xs mb-4 px-3 py-2 rounded-md" style={{ background: 'var(--accent-gold-dim)', color: 'var(--text-secondary)' }}>
          Showing {events.length} of {totalCount} events in this range. Narrow the date range to see the rest.
        </p>
      )}

      {events.length === 0 ? (
        <Card className="text-center py-12">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Nothing recorded for this property in this date range.</p>
        </Card>
      ) : (
        <ol className="space-y-4">
          {events.map((event, i) => {
            const photoUrl = photoUrlFor(event)
            return (
              <li key={`${event.type}-${event.occurredAt}-${i}`} className="flex gap-3">
                <div className="w-20 flex-shrink-0 text-right">
                  <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                    {new Date(event.occurredAt).toLocaleString('en-US', {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
                    })}
                  </span>
                </div>
                <Card className="flex-1 p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--bg-raised)', color: 'var(--text-muted)' }}
                    >
                      {EVENT_LABELS[event.type]}
                    </span>
                    {event.actorName && (
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{event.actorName}</span>
                    )}
                  </div>
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{event.title}</p>
                  {event.detail && (
                    <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{event.detail}</p>
                  )}
                  {photoUrl && (
                    <Image
                      src={photoUrl}
                      alt=""
                      width={240}
                      height={180}
                      unoptimized
                      className="mt-2 rounded-md object-cover"
                      style={{ maxWidth: 240, height: 'auto' }}
                    />
                  )}
                </Card>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
