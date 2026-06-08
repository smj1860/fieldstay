'use client'

import { useState } from 'react'
import { Star, X } from 'lucide-react'

// Replace with real Google Place ID once Business Profile is verified.
const REVIEW_URL = 'mailto:feedback@fieldstay.app?subject=FieldStay Feedback'

interface ReviewPromptProps {
  milestone: string
  message:   string
}

export function ReviewPrompt({ milestone, message }: ReviewPromptProps) {
  const [hidden, setHidden] = useState(false)

  if (hidden) return null

  async function handleReview() {
    await fetch('/api/milestones/review-clicked', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ milestone }),
    }).catch(() => {})
    window.open(REVIEW_URL, '_blank', 'noopener,noreferrer')
    setHidden(true)
  }

  async function handleDismiss() {
    await fetch('/api/milestones/dismiss', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ milestone }),
    }).catch(() => {})
    setHidden(true)
  }

  return (
    <div className="flex items-center gap-3 bg-gold-50 border border-gold-300 rounded-xl px-4 py-3 mb-6">
      <Star className="w-5 h-5 text-gold-400 flex-shrink-0 fill-gold-300" />
      <p className="text-sm text-brand-800 flex-1">
        <span className="font-semibold">🎉 {message}</span>
        {' '}Would you mind leaving us a quick review?
      </p>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button onClick={handleReview} className="btn-cta text-xs px-3 py-1.5">
          Leave a Review
        </button>
        <button
          onClick={handleDismiss}
          className="text-accent-400 hover:text-accent-600 transition-colors p-1"
          title="Maybe later"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
