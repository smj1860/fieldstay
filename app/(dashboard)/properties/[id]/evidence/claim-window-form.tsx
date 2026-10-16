'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { updateClaimWindow } from './actions'

export function ClaimWindowForm({ propertyId, initialDays }: Readonly<{ propertyId: string; initialDays: number }>) {
  const router = useRouter()
  const [days, setDays] = useState(String(initialDays))
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  function save() {
    startTransition(async () => {
      const res = await updateClaimWindow({ propertyId, days: Number(days) })
      setMessage(res.success ? { tone: 'success', text: 'Saved.' } : { tone: 'error', text: res.error })
      if (res.success) router.refresh()
    })
  }

  return (
    <Card className="space-y-2">
      <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Claim window</h2>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        How many days after checkout you can still file a damage claim on direct bookings and other sources with no
        platform deadline. Airbnb and VRBO stays use their own rules.
      </p>
      {message && <InlineAlert tone={message.tone}>{message.text}</InlineAlert>}
      <div className="flex items-end gap-2">
        <div>
          <label htmlFor="claim-window-days" className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Days</label>
          <Input id="claim-window-days" type="number" min={1} max={365} step={1} value={days} onChange={(e) => setDays(e.target.value)} className="w-28" />
        </div>
        <Button type="button" variant="secondary" disabled={pending} onClick={save}>Save</Button>
      </div>
    </Card>
  )
}
