'use client'

import { Loader2, Star } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { WorkOrderActions } from './use-work-order-actions'

export function VendorRatingPanel({ actions }: Readonly<{ actions: WorkOrderActions }>) {
  const {
    hoverRating, setHoverRating,
    savedRating, ratingNotes, setRatingNotes,
    ratingPending, ratingError, ratingSuccess,
    handleRating, handleRatingNotesSave,
  } = actions

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map(star => (
          <button
            key={star}
            type="button"
            onClick={() => handleRating(star)}
            onMouseEnter={() => setHoverRating(star)}
            onFocus={() => setHoverRating(star)}
            onMouseLeave={() => setHoverRating(0)}
            onBlur={() => setHoverRating(0)}
            disabled={ratingPending}
            className="p-0.5 transition-transform hover:scale-110"
          >
            <Star
              className="w-6 h-6"
              style={{
                color: star <= (hoverRating || savedRating || 0)
                  ? 'var(--accent-gold)'
                  : 'var(--border)',
                fill: star <= (hoverRating || savedRating || 0)
                  ? 'var(--accent-gold)'
                  : 'transparent',
              }}
            />
          </button>
        ))}
        {savedRating && (
          <span className="ml-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            {savedRating}/5
          </span>
        )}
        {ratingPending && <Loader2 className="w-4 h-4 ml-2 animate-spin" style={{ color: 'var(--text-muted)' }} />}
      </div>

      <div className="space-y-1.5">
        <textarea
          value={ratingNotes}
          onChange={e => setRatingNotes(e.target.value)}
          placeholder="Optional notes about the vendor's performance…"
          rows={2}
          className="input w-full text-sm resize-none"
        />
        <Button
          type="button"
          variant="secondary"
          onClick={handleRatingNotesSave}
          disabled={ratingPending || !savedRating}
          className="text-xs py-1 px-3"
        >
          Save Notes
        </Button>
      </div>

      {ratingSuccess && (
        <p className="text-xs" style={{ color: 'var(--accent-green)' }}>Rating saved.</p>
      )}
      {ratingError && (
        <p className="text-xs text-red-400">{ratingError}</p>
      )}
    </div>
  )
}
