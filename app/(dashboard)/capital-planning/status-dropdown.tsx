'use client'

import { useState, useTransition } from 'react'
import { updateReplacementStatus }  from './actions'
import type { ReplacementStatus }   from './actions'

const OPTIONS: { value: ReplacementStatus; label: string }[] = [
  { value: 'projected', label: 'Projected' },
  { value: 'budgeted',  label: 'Budgeted'  },
  { value: 'approved',  label: 'Approved'  },
  { value: 'deferred',  label: 'Deferred'  },
]

const STATUS_STYLES: Record<ReplacementStatus, string> = {
  projected: 'text-muted-themed',
  budgeted:  'text-[var(--accent-amber)]',
  approved:  'text-[var(--accent-green)]',
  deferred:  'text-muted-themed line-through',
}

export function StatusDropdown({
  assetId,
  currentStatus,
}: Readonly<{
  assetId:       string
  currentStatus: ReplacementStatus
}>) {
  const [status, setStatus]    = useState<ReplacementStatus>(currentStatus)
  const [pending, startUpdate] = useTransition()

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as ReplacementStatus
    setStatus(next)
    startUpdate(() => void updateReplacementStatus(assetId, next))
  }

  return (
    <select
      value={status}
      onChange={handleChange}
      disabled={pending}
      className={`text-xs rounded px-1.5 py-0.5 border border-themed bg-transparent
        cursor-pointer transition-opacity ${pending ? 'opacity-50' : ''} ${STATUS_STYLES[status]}`}
      aria-label="Replacement status"
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}
