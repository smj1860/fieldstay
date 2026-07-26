'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/Button'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { applyMasterChecklistToProperties } from './actions'

interface Props {
  propertyIds: string[]
}

export function ApplyToPropertiesButton({ propertyIds }: Readonly<Props>) {
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<{ error?: string; queued?: number } | null>(null)

  if (propertyIds.length === 0) return null

  function handleClick() {
    setResult(null)
    startTransition(async () => {
      const res = await applyMasterChecklistToProperties(propertyIds)
      setResult(res)
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Button variant="secondary" onClick={handleClick} disabled={isPending} className="text-sm">
          {isPending
            ? 'Applying…'
            : `Apply room library to all ${propertyIds.length} propert${propertyIds.length === 1 ? 'y' : 'ies'}`}
        </Button>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Pushes any auto-include rooms onto every active property&apos;s checklist —
          useful after adding or changing a room template.
        </span>
      </div>
      {result?.error && <InlineAlert tone="error">{result.error}</InlineAlert>}
      {result?.queued !== undefined && (
        <InlineAlert tone="success">
          Queued for {result.queued} propert{result.queued === 1 ? 'y' : 'ies'} — this runs in the background.
        </InlineAlert>
      )}
    </div>
  )
}
