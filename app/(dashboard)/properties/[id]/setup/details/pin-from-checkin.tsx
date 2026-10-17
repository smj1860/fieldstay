'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MapPin } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { formatDistance } from '@/lib/evidence/geo'
import { setPinFromLastCheckin } from './actions'

export interface PinState {
  /** Why the button is disabled, or null when it can be used. Computed by pinBlockedReason(). */
  blockedReason: string | null
  capturedAt:    string | null
  accuracyFt:    number | null
  /** Distance from the current pin to the last check-in, null when there is no pin or no check-in. */
  distanceFt:    number | null
  /** A PM already moved the pin by hand. */
  pinnedByPm:    boolean
}

function describeCheckin(pin: PinState): string {
  if (!pin.capturedAt) return ''
  const when = new Date(pin.capturedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const accuracy = pin.accuracyFt === null ? '' : `, accuracy ${formatDistance(pin.accuracyFt)}`
  return `Last check-in: ${when}${accuracy}.`
}

export function PinFromCheckin({ propertyId, pin }: Readonly<{ propertyId: string; pin: PinState }>) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  function confirm() {
    setError(null)
    startTransition(async () => {
      const res = await setPinFromLastCheckin(propertyId)
      if (res.error) {
        setError(res.error)
        return
      }
      setOpen(false)
      setDone(true)
      router.refresh()
    })
  }

  const disabled = pin.blockedReason !== null

  return (
    <div className="mt-2">
      <Button type="button" variant="secondary" onClick={() => setOpen(true)} disabled={disabled}>
        <MapPin className="w-4 h-4" /> Use last check-in as map pin
      </Button>
      <p className="text-xs text-accent-400 mt-1">
        {pin.blockedReason ?? `${describeCheckin(pin)} Fixes a pin that sits on the wrong road or the middle of town.`}
        {pin.pinnedByPm && !done && ' You moved this pin by hand; syncs will not overwrite it.'}
      </p>
      {done && <InlineAlert tone="success">The map pin now matches where your crew checked in. Past check-ins keep the distance recorded at the time.</InlineAlert>}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Move the map pin?"
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button type="button" variant="primary" onClick={confirm} disabled={pending}>
              {pending ? 'Moving...' : 'Move pin'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-secondary-themed">
          Move this property&apos;s map pin to where your crew last checked in?
          {pin.distanceFt !== null && ` The new pin is about ${formatDistance(pin.distanceFt)} from the current one.`}
        </p>
        <p className="text-sm text-muted-themed mt-2">
          Future check-ins are measured against the new pin. Past check-ins keep the distance recorded at the time.
        </p>
        {error && <div className="mt-3"><InlineAlert tone="error">{error}</InlineAlert></div>}
      </Dialog>
    </div>
  )
}
