'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { addEvidenceSpot, deactivateEvidenceSpot, renameEvidenceSpot } from './evidence-spots-actions'

export interface ClaimSpotView {
  id:           string
  section_name: string
  label:        string
}

const COMMON_ROOMS = ['Kitchen', 'Living Room', 'Dining Room', 'Master Bedroom', 'Bedroom', 'Bathroom']

function groupBySection(spots: readonly ClaimSpotView[]): [string, ClaimSpotView[]][] {
  const map = new Map<string, ClaimSpotView[]>()
  for (const s of spots) map.set(s.section_name, [...(map.get(s.section_name) ?? []), s])
  return [...map.entries()]
}

function SpotRow({ propertyId, spot, onError }: Readonly<{
  propertyId: string; spot: ClaimSpotView; onError: (msg: string | null) => void
}>) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(spot.label)
  const [pending, startTransition] = useTransition()

  function run(task: () => Promise<{ success: boolean; error?: string }>, after?: () => void) {
    startTransition(async () => {
      const res = await task()
      onError(res.success ? null : (res.error ?? 'Something went wrong.'))
      if (res.success) { after?.(); router.refresh() }
    })
  }

  if (editing) {
    return (
      <li className="flex items-center gap-2">
        <Input
          aria-label={`Label for ${spot.section_name} spot`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={120}
        />
        <Button type="button" variant="primary" disabled={pending}
          onClick={() => run(() => renameEvidenceSpot({ propertyId, spotId: spot.id, label }), () => setEditing(false))}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={() => { setLabel(spot.label); setEditing(false) }}>Cancel</Button>
      </li>
    )
  }
  return (
    <li className="flex items-center justify-between gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
      <span>{spot.label}</span>
      <span className="flex gap-1">
        <Button type="button" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
        <Button type="button" variant="ghost" disabled={pending}
          onClick={() => run(() => deactivateEvidenceSpot({ propertyId, spotId: spot.id }))}>
          Remove
        </Button>
      </span>
    </li>
  )
}

export function ClaimSpotsCard({ propertyId, spots }: Readonly<{ propertyId: string; spots: readonly ClaimSpotView[] }>) {
  const router = useRouter()
  const [section, setSection] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const rooms = [...new Set([...spots.map((s) => s.section_name), ...COMMON_ROOMS])]

  function add() {
    startTransition(async () => {
      const res = await addEvidenceSpot({ propertyId, section, label })
      if (res.success) { setError(null); setSection(''); setLabel(''); router.refresh() } else setError(res.error)
    })
  }

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Claim photo spots</h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          These spots get a required photo on every turnover. Keep the list short. Five to eight photos per home is
          the right number. Changes apply to the next turnover that is generated.
        </p>
      </div>
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {groupBySection(spots).map(([name, group]) => (
        <div key={name} className="space-y-1">
          <h3 className="text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>{name}</h3>
          <ul className="space-y-1">
            {group.map((s) => <SpotRow key={s.id} propertyId={propertyId} spot={s} onError={setError} />)}
          </ul>
        </div>
      ))}
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] items-end">
        <div>
          <label htmlFor="spot-section" className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Room</label>
          <Input id="spot-section" list="spot-rooms" value={section} onChange={(e) => setSection(e.target.value)} maxLength={80} />
          <datalist id="spot-rooms">{rooms.map((r) => <option key={r} value={r} />)}</datalist>
        </div>
        <div>
          <label htmlFor="spot-label" className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Spot</label>
          <Input id="spot-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="Mattress, cover pulled back" />
        </div>
        <Button type="button" variant="secondary" disabled={pending || !section.trim() || !label.trim()} onClick={add}>Add spot</Button>
      </div>
    </Card>
  )
}
