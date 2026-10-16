'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { getPacketStatus, requestPacket } from './actions'

export interface PacketPhotoOption {
  id:    string
  label: string
}

const POLL_MS = 2_500
const MAX_POLLS = 60   // 2.5 minutes; the build itself is normally well under a minute

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'building'; packetId: string }
  | { kind: 'ready'; url: string }
  | { kind: 'failed'; message: string }

export function PacketBuilder({ propertyId, bookingId, photos }: Readonly<{
  propertyId: string
  bookingId:  string
  photos:     readonly PacketPhotoOption[]
}>) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(photos.map((p) => p.id)))
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const pollsRef = useRef(0)

  const packetId = phase.kind === 'building' ? phase.packetId : null
  useEffect(() => {
    if (!packetId) return
    pollsRef.current = 0
    const timer = setInterval(async () => {
      pollsRef.current += 1
      const res = await getPacketStatus(packetId)
      if (!res.success) { setPhase({ kind: 'failed', message: res.error }); clearInterval(timer); return }
      if (res.status === 'ready' && res.url) { setPhase({ kind: 'ready', url: res.url }); clearInterval(timer); return }
      if (res.status === 'failed') {
        setPhase({ kind: 'failed', message: 'The packet could not be built. Please try again.' })
        clearInterval(timer)
        return
      }
      if (pollsRef.current >= MAX_POLLS) {
        setPhase({ kind: 'failed', message: 'Still working. Check back in a few minutes and build it again if it does not appear.' })
        clearInterval(timer)
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [packetId])

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function build() {
    setPhase({ kind: 'starting' })
    const allSelected = selected.size === photos.length
    const res = await requestPacket({ propertyId, bookingId, eventIds: allSelected ? null : [...selected] })
    setPhase(res.success ? { kind: 'building', packetId: res.packetId } : { kind: 'failed', message: res.error })
  }

  const busy = phase.kind === 'starting' || phase.kind === 'building'
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Claim packet</h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          A PDF with before and after photos by room, capture times, and a chain of custody. Pick the photos to include.
        </p>
      </div>
      {photos.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No before or after photos are tied to this stay yet.</p>
      ) : (
        <ul className="max-h-48 overflow-auto space-y-1">
          {photos.map((p) => (
            <li key={p.id} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
              <Checkbox id={`pk-${p.id}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} disabled={busy} />
              <label htmlFor={`pk-${p.id}`}>{p.label}</label>
            </li>
          ))}
        </ul>
      )}
      {phase.kind === 'failed' && <InlineAlert tone="error">{phase.message}</InlineAlert>}
      <div className="flex items-center gap-3">
        <Button type="button" variant="primary" disabled={busy || selected.size === 0} onClick={build}>
          {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Building</> : 'Build claim packet'}
        </Button>
        {phase.kind === 'ready' && (
          <a href={phase.url} target="_blank" rel="noopener noreferrer" className="text-sm underline" style={{ color: 'var(--accent-gold)' }}>
            Download packet (link expires in 5 minutes)
          </a>
        )}
      </div>
    </Card>
  )
}
