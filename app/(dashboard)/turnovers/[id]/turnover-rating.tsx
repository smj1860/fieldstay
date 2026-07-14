'use client'

import { useState, useTransition } from 'react'
import { Star } from 'lucide-react'
import { rateTurnoverCompletion } from '../actions'

export function TurnoverRating({
  turnoverId,
  initialRating,
}: Readonly<{ turnoverId: string; initialRating: number | null }>) {
  const [rating, setRating]   = useState(initialRating)
  const [hovered, setHovered] = useState<number | null>(null)
  const [saving, startSaving] = useTransition()
  const [saved, setSaved]     = useState(false)

  const handleRate = (value: number) => {
    setRating(value)
    setSaved(false)
    startSaving(async () => {
      const result = await rateTurnoverCompletion(turnoverId, value)
      if (!result.error) setSaved(true)
    })
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>How did this turnover go?</span>
      <div className="flex items-center gap-0.5" onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}>
        {[1, 2, 3, 4, 5].map((value) => {
          const filled = (hovered ?? rating ?? 0) >= value
          return (
            <button
              key={value}
              type="button"
              onClick={() => handleRate(value)}
              onMouseOver={() => setHovered(value)}
              onFocus={() => setHovered(value)}
              disabled={saving}
              aria-label={`Rate ${value} out of 5`}
              className="p-0.5 disabled:opacity-50"
            >
              <Star
                className="w-4 h-4"
                fill={filled ? 'var(--accent-gold)' : 'none'}
                style={{ color: filled ? 'var(--accent-gold)' : 'var(--border)' }}
              />
            </button>
          )
        })}
      </div>
      {saved && <span className="text-xs" style={{ color: 'var(--accent-green)' }}>Saved</span>}
    </div>
  )
}
