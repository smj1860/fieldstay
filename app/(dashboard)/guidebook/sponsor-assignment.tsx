'use client'

import { useMemo, useState, useTransition } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Badge } from '@/components/ui/Badge'
import { distanceMiles } from '@/lib/geocoding'
import {
  setSponsorProperties,
  setPropertySponsors,
  resetPropertyToAutomatic,
} from '@/app/actions/sponsor-assignments'
import { MAX_SPONSORS_PER_PROPERTY } from '@/lib/guidebook/assignment-constants'
import type { GuidebookSponsor, GuidebookSlotType } from '@/types/database'

/**
 * Per-property sponsor assignment.
 *
 * Two paths, deliberately not a grid:
 *
 *   * PRIMARY — sponsor-side bulk. Open a sponsor, tick properties, save. A
 *     thirty-property org is configured in about six interactions.
 *   * SECONDARY — per-property override, for the one cabin where the automatic
 *     pick is wrong.
 *
 * A property x sponsor matrix would be 360 cells of tedium at 30 properties,
 * and a shorthand letter-entry field gives no confirmation of what was set.
 * Both are the opposite of what this product promises.
 */

/** Radius offered by the one-click bulk action. */
const NEARBY_RADIUS_MILES = 10

/**
 * How many rows `SponsorPropertiesDialog` renders before a "Show more" click.
 *
 * `properties` here is the WHOLE org's list — up to `MAX_SELF_SERVE_PROPERTIES`
 * (150, see `lib/stripe/brackets.ts`) — rendered fully unpaginated with a
 * per-row distance computation. Simple client-side pagination rather than a
 * virtualization library (none is in the repo, and CLAUDE.md's "never
 * introduce unnecessary tooling" rules one out for a list that tops out at
 * 150 rows). `PropertySponsorsDialog`'s own list (sponsors, not properties)
 * needs neither: `guidebook_sponsors.slot_number` CHECKs 1..6, so it never
 * exceeds six rows regardless of org size.
 */
const PROPERTIES_PAGE_SIZE = 50

export interface AssignmentProperty {
  id:   string
  name: string
  lat:  number | null
  lng:  number | null
  mode: 'auto' | 'manual'
  /** What the property currently shows, resolved server-side. */
  sponsors: {
    id:            string
    business_name: string
    slot_type:     GuidebookSlotType
    assignedBy:    'manual' | 'nearest'
    distanceMiles: number | null
  }[]
}

const SLOT_LABEL: Record<GuidebookSlotType, string> = {
  morning_brew:      'Morning Brew',
  dinner_pints:      'Dinner & Pints',
  rainy_day:         'Rainy Day',
  outdoor_adventure: 'Outdoor Adventure',
  general:           'Local Favorite',
  other:             'Local Favorite',
}

/** "3.1 mi" — one decimal is as much precision as a straight-line estimate earns. */
function formatMiles(mi: number | null): string | null {
  return mi === null ? null : `${mi.toFixed(1)} mi`
}

/**
 * Why a sponsor is on this property, in the manager's words.
 *
 * An automatic property must show what was picked AND why, so the manager can
 * see the system working and knows they only need to intervene where it is
 * wrong. "Nearest, 3.1 mi" does that; a bare list does not.
 */
function assignmentReason(s: AssignmentProperty['sponsors'][number]): string {
  if (s.assignedBy === 'manual') return 'You chose this'
  const miles = formatMiles(s.distanceMiles)
  return miles ? `Nearest, ${miles}` : 'Nearest'
}

/** Does this property currently show this sponsor because proximity chose it? */
function showsAutomatically(p: AssignmentProperty, sponsorId: string): boolean {
  return p.mode === 'auto' && p.sponsors.some((s) => s.id === sponsorId)
}

// ── Sponsor-side bulk assignment ────────────────────────────────────────────

export function SponsorPropertiesDialog({
  sponsor,
  properties,
  onClose,
}: Readonly<{
  sponsor:    GuidebookSponsor
  properties: AssignmentProperty[]
  onClose:    () => void
}>) {
  const initiallyOn = useMemo(
    () => new Set(
      properties.filter((p) => p.sponsors.some((s) => s.id === sponsor.id && s.assignedBy === 'manual'))
                .map((p) => p.id),
    ),
    [properties, sponsor.id],
  )

  const [selected, setSelected] = useState<Set<string>>(initiallyOn)
  const [error, setError]       = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [visibleCount, setVisibleCount] = useState(PROPERTIES_PAGE_SIZE)

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /**
   * Distance from this sponsor to every property, computed ONCE per
   * (sponsor, properties) pair rather than per render. Every keystroke/toggle
   * in this dialog re-renders the whole list — up to 150 rows at the
   * self-serve ceiling — and without memoizing this, each of those renders
   * recomputed a haversine distance for every property all over again for no
   * reason: neither the sponsor's coordinates nor the property list change
   * while the dialog is just being clicked around in.
   */
  const milesById = useMemo(() => {
    const map = new Map<string, number | null>()
    for (const p of properties) {
      const mi =
        sponsor.lat === null || sponsor.lng === null || p.lat === null || p.lng === null
          ? null
          : distanceMiles(sponsor.lat, sponsor.lng, p.lat, p.lng)
      map.set(p.id, mi)
    }
    return map
  }, [properties, sponsor.lat, sponsor.lng])

  const nearby = useMemo(
    () => properties.filter((p) => {
      const mi = milesById.get(p.id) ?? null
      return mi !== null && mi <= NEARBY_RADIUS_MILES
    }),
    [properties, milesById],
  )

  const selectNearby = () => {
    setSelected((prev) => new Set([...prev, ...nearby.map((p) => p.id)]))
  }

  // Pagination is purely a RENDER concern — selection, "select nearby", and
  // the initially-checked set above all operate over the full `properties`
  // array regardless of how much of it is currently visible, so ticking a
  // box then scrolling never loses a selection that happens to be off-page.
  const visibleProperties = properties.slice(0, visibleCount)
  const remaining = properties.length - visibleProperties.length

  const save = () => {
    setError(null)
    startTransition(async () => {
      const res = await setSponsorProperties(sponsor.id, [...selected])
      if (res.success) onClose()
      else setError(res.error)
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Where does ${sponsor.business_name} appear?`}
      mobileSheet
      footer={
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={pending}>
            {pending ? 'Saving…' : `Save (${selected.size})`}
          </Button>
        </div>
      }
    >
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '0 0 12px' }}>
        Tick the properties whose guidebook and guest texts should feature this
        business. Properties marked <em>Automatic</em> already show it because
        it is the nearest in its category — ticking one pins it there, and any
        property you change stops being assigned automatically.
      </p>

      {nearby.length > 0 && (
        <div style={{ marginBottom: '12px' }}>
          <Button variant="secondary" onClick={selectNearby} disabled={pending}>
            Select all within {NEARBY_RADIUS_MILES} miles ({nearby.length})
          </Button>
        </div>
      )}

      {error && (
        <p style={{ fontSize: '13px', color: 'var(--accent-red)', margin: '0 0 12px' }}>{error}</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {visibleProperties.map((p) => {
          const inputId = `sponsor-prop-${p.id}`
          const miles   = formatMiles(milesById.get(p.id) ?? null)
          return (
            <label
              key={p.id}
              htmlFor={inputId}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 8px', borderRadius: 'var(--radius)', cursor: 'pointer',
              }}
            >
              <Checkbox
                id={inputId}
                checked={selected.has(p.id)}
                onChange={() => toggle(p.id)}
                disabled={pending}
              />
              <span style={{ flex: 1, minWidth: 0, fontSize: '14px', color: 'var(--text-primary)' }}>
                {p.name}
              </span>
              {miles && (
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{miles}</span>
              )}
              {showsAutomatically(p, sponsor.id) && (
                // Without this the dialog opens all-unchecked for an org that
                // has never assigned anything, which reads as "this sponsor
                // appears nowhere" when in fact it appears on every property
                // the automatic pick puts it on. The checkbox means "pinned
                // here"; this says "already showing here".
                <Badge tone="slate">Automatic</Badge>
              )}
            </label>
          )
        })}
      </div>

      {remaining > 0 && (
        <div style={{ marginTop: '12px', textAlign: 'center' }}>
          <Button
            variant="secondary"
            onClick={() => setVisibleCount((n) => n + PROPERTIES_PAGE_SIZE)}
            disabled={pending}
          >
            Show {Math.min(remaining, PROPERTIES_PAGE_SIZE)} more ({remaining} remaining)
          </Button>
        </div>
      )}
    </Dialog>
  )
}

// ── Per-property override ───────────────────────────────────────────────────

export function PropertySponsorsDialog({
  property,
  sponsors,
  onClose,
}: Readonly<{
  property: AssignmentProperty
  sponsors: GuidebookSponsor[]
  onClose:  () => void
}>) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(property.sponsors.map((s) => s.id)),
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const atCap = selected.size >= MAX_SPONSORS_PER_PROPERTY

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_SPONSORS_PER_PROPERTY) next.add(id)
      return next
    })
  }

  const save = () => {
    setError(null)
    startTransition(async () => {
      const res = await setPropertySponsors(property.id, [...selected])
      if (res.success) onClose()
      else setError(res.error)
    })
  }

  const reset = () => {
    setError(null)
    startTransition(async () => {
      const res = await resetPropertyToAutomatic(property.id)
      if (res.success) onClose()
      else setError(res.error)
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Sponsors on ${property.name}`}
      mobileSheet
      footer={
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between', width: '100%' }}>
          <Button variant="ghost" onClick={reset} disabled={pending}>
            Reset to automatic
          </Button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      }
    >
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '0 0 12px' }}>
        Up to {MAX_SPONSORS_PER_PROPERTY} sponsors, and only one per named
        category. Saving an empty list is allowed — this property will show no
        sponsors and stay that way.
      </p>

      {error && (
        <p style={{ fontSize: '13px', color: 'var(--accent-red)', margin: '0 0 12px' }}>{error}</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {sponsors.map((s) => {
          const inputId = `prop-sponsor-${s.id}`
          const checked = selected.has(s.id)
          return (
            <label
              key={s.id}
              htmlFor={inputId}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 8px', borderRadius: 'var(--radius)', cursor: 'pointer',
                opacity: !checked && atCap ? 0.5 : 1,
              }}
            >
              <Checkbox
                id={inputId}
                checked={checked}
                onChange={() => toggle(s.id)}
                disabled={pending || (!checked && atCap)}
              />
              <span style={{ flex: 1, minWidth: 0, fontSize: '14px', color: 'var(--text-primary)' }}>
                {s.business_name}
              </span>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {SLOT_LABEL[s.slot_type]}
              </span>
            </label>
          )
        })}
      </div>
    </Dialog>
  )
}

// ── The per-property summary row ────────────────────────────────────────────

export function PropertyAssignmentSummary({
  property,
  onEdit,
}: Readonly<{ property: AssignmentProperty; onEdit: () => void }>) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: '16px',
        padding: '14px 20px', borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <span style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
            {property.name}
          </span>
          <Badge tone={property.mode === 'manual' ? 'gold' : 'slate'}>
            {property.mode === 'manual' ? 'Manual' : 'Automatic'}
          </Badge>
        </div>

        {property.sponsors.length === 0 ? (
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {property.mode === 'manual'
              ? 'No sponsors — set deliberately'
              : 'No sponsors yet'}
          </span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
            {property.sponsors.map((s) => (
              <span key={s.id} style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                <span style={{ color: 'var(--text-primary)' }}>{s.business_name}</span>
                {' · '}{SLOT_LABEL[s.slot_type]}
                {' · '}{assignmentReason(s)}
              </span>
            ))}
          </div>
        )}
      </div>

      <Button variant="secondary" onClick={onEdit}>Edit</Button>
    </div>
  )
}
