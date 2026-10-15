// app/(dashboard)/properties/[id]/evidence/page.tsx
//
// Stay evidence timeline: guest stays on the left, the sealed photos that
// bracket the selected stay on the right. Server component, RLS client; the
// ledger itself is append-only (see 20261014090000_evidence_ledger.sql).
import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { requireProperty } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { toStorageObjectPath } from '@/lib/storage/object-path'
import { unwrapList } from '@/lib/supabase/unwrap'
import { Card } from '@/components/ui/Card'
import { ClaimSpotsCard, type ClaimSpotView } from '../claim-spots-card'
import { Badge } from '@/components/ui/Badge'
import { StatusDot } from '@/components/ui/StatusDot'
import {
  MAX_STAYS, countByBooking, currentTimeMs, emptyCounts, formatInTimezone, loadBracketsForBookings,
  loadEventsByIds, loadUnbracketedEvents, loadWithdrawnOriginalIds,
  type StayBracketCounts, type TimelineEvent,
} from '@/lib/evidence/timeline'
import type { EvidenceBracketPosition } from '@/types/database'

export const metadata: Metadata = { title: 'Stay Evidence' }

const SIGNED_URL_TTL_SECONDS = 300

const POSITION_LABEL: Record<EvidenceBracketPosition, string> = {
  pre_stay:    'Before the stay',
  during_stay: 'During the stay',
  post_stay:   'After the stay',
}
const POSITIONS: readonly EvidenceBracketPosition[] = ['pre_stay', 'during_stay', 'post_stay']

interface StayRow {
  id: string
  guest_name: string | null
  checkin_date: string
  checkout_date: string
  source: string | null
}

async function signThumbnails(
  events: readonly TimelineEvent[],
  membership: { org_id: string; role: string },
): Promise<Map<string, string>> {
  const signed = new Map<string, string>()
  const byBucket = new Map<string, { id: string; path: string }[]>()
  for (const e of events) {
    if (e.kind !== 'photo_sealed') continue
    const path = toStorageObjectPath(e.bucket, e.storage_path)
    if (!path) continue
    byBucket.set(e.bucket, [...(byBucket.get(e.bucket) ?? []), { id: e.id, path }])
  }
  if (byBucket.size === 0) return signed

  // Signing needs the service role (storage RLS is org-prefix based and the
  // paths were just read through the session client for this org).
  const service = createServiceClient({ authorizedBy: membership })
  for (const [bucket, entries] of byBucket) {
    const { data, error } = await service.storage
      .from(bucket)
      .createSignedUrls(entries.map((x) => x.path), SIGNED_URL_TTL_SECONDS)
    if (error || !data) continue
    entries.forEach((x, i) => {
      const url = data[i]?.signedUrl
      if (url) signed.set(x.id, url)
    })
  }
  return signed
}

function EvidenceTile({ event, url, timeZone, withdrawn }: Readonly<{
  event: TimelineEvent; url: string | undefined; timeZone: string; withdrawn: boolean
}>) {
  const who = [event.captured_by_kind, event.captured_by_label].filter(Boolean).join(' · ')
  return (
    <figure className={`card p-2 space-y-2 ${withdrawn ? 'opacity-50' : ''}`}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not optimizable
        <img src={url} alt="Captured evidence" className="w-full h-40 object-cover rounded" loading="lazy" />
      ) : (
        <div className="w-full h-40 rounded bg-raised-themed" />
      )}
      <figcaption className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
        <div style={{ color: 'var(--text-primary)' }}>{formatInTimezone(event.captured_at, timeZone)}</div>
        <div>{who}</div>
        <div className="flex items-center gap-2">
          <StatusDot
            status={event.hash_verified ? 'good' : 'warning'}
            label={event.hash_verified ? 'Hash verified' : 'Hash not verified'}
          />
          <span title={event.hash_verified ? 'Hash verified' : 'Hash not verified'}>
            {event.hash_verified ? 'Verified' : 'Not verified'}
          </span>
          {event.captured_at_source === 'server' && <span>Server time</span>}
          {event.lat !== null && <span>GPS</span>}
          {withdrawn && <Badge tone="slate">Withdrawn</Badge>}
        </div>
      </figcaption>
    </figure>
  )
}

function CountBadges({ counts }: Readonly<{ counts: StayBracketCounts }>) {
  return (
    <span className="flex gap-1">
      <Badge tone="blue">{counts.pre_stay} before</Badge>
      <Badge tone="slate">{counts.during_stay} during</Badge>
      <Badge tone="green">{counts.post_stay} after</Badge>
    </span>
  )
}

interface Props {
  params:       Promise<{ id: string }>
  searchParams: Promise<{ stay?: string }>
}

export default async function PropertyEvidencePage({ params, searchParams }: Readonly<Props>) {
  const { id } = await params
  const { stay: stayParam } = await searchParams
  const { property, supabase, membership } = await requireProperty(id)
  const orgId = membership.org_id
  const nowMs = currentTimeMs()

  const twelveMonthsAgo = new Date(nowMs - 365 * 86_400_000).toISOString().slice(0, 10)
  const sixtyDaysOut    = new Date(nowMs + 60 * 86_400_000).toISOString().slice(0, 10)

  const staysRes = await supabase
    .from('bookings')
    .select('id, guest_name, checkin_date, checkout_date, source')
    .eq('org_id', orgId)
    .eq('property_id', id)
    .eq('is_block', false)
    .eq('stay_type', 'guest_stay')
    .in('status', ['confirmed', 'tentative'])
    .gte('checkout_date', twelveMonthsAgo)
    .lte('checkin_date', sixtyDaysOut)
    .order('checkin_date', { ascending: false })
    .limit(MAX_STAYS)
  const stays = unwrapList(staysRes, { site: 'page.properties.evidence.stays', orgId }) as StayRow[]

  const spotsRes = await supabase
    .from('property_evidence_spots')
    .select('id, section_name, label')
    .eq('org_id', orgId)
    .eq('property_id', id)
    .eq('is_active', true)
    .order('section_name', { ascending: true })
    .order('sort_order', { ascending: true })
    .limit(200)
  const spots = unwrapList(spotsRes, { site: 'page.properties.evidence.spots', orgId }) as ClaimSpotView[]
  const canEditSpots = ['owner', 'admin', 'manager'].includes(membership.role)

  const brackets = await loadBracketsForBookings(supabase, orgId, stays.map((s) => s.id))
  const counts   = countByBooking(brackets)

  const selected = stays.find((s) => s.id === stayParam) ?? null
  const selectedBrackets = selected ? brackets.filter((b) => b.booking_id === selected.id) : []
  const stayEvents = await loadEventsByIds(supabase, orgId, selectedBrackets.map((b) => b.evidence_event_id))
  const unbracketed = await loadUnbracketedEvents(supabase, orgId, id, nowMs)

  const allEvents = [...stayEvents, ...unbracketed]
  const withdrawn = await loadWithdrawnOriginalIds(supabase, orgId, allEvents.map((e) => e.id))
  const urls      = await signThumbnails(allEvents, membership)

  const positionOf = new Map(selectedBrackets.map((b) => [b.evidence_event_id, b.position]))

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <Link href={`/properties/${id}`} className="text-sm inline-flex items-center gap-1 text-muted-themed hover:text-secondary-themed">
          <ArrowLeft className="w-4 h-4" /> {property.name ?? 'Property'}
        </Link>
        <h1 className="text-xl font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>Stay evidence</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Every photo is sealed when it arrives: hashed, time stamped and tied to the guest stay it brackets.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-[320px_1fr]">
        <Card className="space-y-2 self-start">
          <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Guest stays</h2>
          {stays.length === 0 && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No guest stays in this window.</p>}
          <ul className="space-y-2">
            {stays.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/properties/${id}/evidence?stay=${s.id}`}
                  aria-current={s.id === selected?.id ? 'true' : undefined}
                  className="block rounded border p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
                  style={{ borderColor: s.id === selected?.id ? 'var(--accent-gold)' : 'var(--border)', color: 'var(--text-primary)' }}
                >
                  <div>{s.checkin_date} to {s.checkout_date}</div>
                  <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{s.guest_name ?? 'Guest'}{s.source ? ` · ${s.source}` : ''}</div>
                  <CountBadges counts={counts.get(s.id) ?? emptyCounts()} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-6">
          {selected ? (
            POSITIONS.map((pos) => {
              const group = stayEvents.filter((e) => positionOf.get(e.id) === pos)
              return (
                <section key={pos} className="space-y-2">
                  <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{POSITION_LABEL[pos]}</h2>
                  {group.length === 0 ? (
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No sealed photos.</p>
                  ) : (
                    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                      {group.map((e) => (
                        <EvidenceTile key={e.id} event={e} url={urls.get(e.id)} timeZone={property.timezone} withdrawn={withdrawn.has(e.id)} />
                      ))}
                    </div>
                  )}
                </section>
              )
            })
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Select a stay to see the photos that bracket it.</p>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Not tied to a stay (last 90 days)</h2>
            {unbracketed.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Nothing here.</p>
            ) : (
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                {unbracketed.map((e) => (
                  <EvidenceTile key={e.id} event={e} url={urls.get(e.id)} timeZone={property.timezone} withdrawn={withdrawn.has(e.id)} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {canEditSpots && <ClaimSpotsCard propertyId={id} spots={spots} />}
    </div>
  )
}
