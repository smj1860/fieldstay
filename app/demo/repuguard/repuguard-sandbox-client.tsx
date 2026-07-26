'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, ShieldAlert, Star, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import {
  SANDBOX_REVIEWS, THINKING_MS, TICK_MS,
  revealedLength, type SandboxReview,
} from '@/lib/demo/repuguard-sandbox'

type Phase = 'idle' | 'thinking' | 'streaming' | 'done'

/**
 * RepuGuard sandbox. Everything below runs client-side with no network call —
 * see lib/demo/repuguard-sandbox.ts for why the booth demo replays authored
 * responses instead of hitting the model live.
 */
export function RepuGuardSandboxClient() {
  const [selectedId, setSelectedId] = useState<string>(SANDBOX_REVIEWS[0]!.id)
  const selected = SANDBOX_REVIEWS.find((r) => r.id === selectedId) ?? SANDBOX_REVIEWS[0]!

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-5">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5" style={{ color: 'var(--accent-gold)' }} aria-hidden="true" />
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            RepuGuard — Sandbox
          </h1>
        </div>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Six real-world review scenarios. Pick one and generate the reply.
        </p>
      </header>

      <div className="grid gap-5 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <ReviewList selectedId={selectedId} onSelect={setSelectedId} />
        {/* key remounts the panel on selection change, resetting the reveal
            state — otherwise a half-streamed response would bleed across. */}
        <ResponsePanel key={selected.id} review={selected} />
      </div>
    </div>
  )
}

function ReviewList({
  selectedId, onSelect,
}: Readonly<{ selectedId: string; onSelect: (id: string) => void }>) {
  return (
    <ul className="space-y-2">
      {SANDBOX_REVIEWS.map((review) => {
        const isSelected = review.id === selectedId
        return (
          <li key={review.id}>
          <button
            type="button"
            onClick={() => onSelect(review.id)}
            aria-current={isSelected}
            className="w-full text-left rounded-lg p-3 transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
            style={{
              background: isSelected ? 'var(--bg-raised)' : 'var(--bg-card)',
              border: `1px solid ${isSelected ? 'var(--accent-gold)' : 'var(--border)'}`,
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <StarRating rating={review.starRating} />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {review.source}
              </span>
            </div>
            <p className="text-sm font-medium mt-1.5" style={{ color: 'var(--text-primary)' }}>
              {review.guestName}
            </p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {review.propertyName}
            </p>
            <p className="text-xs mt-1.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
              {review.reviewText}
            </p>
            {review.generated.flags.length > 0 && (
              <span className="inline-flex items-center gap-1 mt-2">
                <ShieldAlert className="w-3 h-3" style={{ color: 'var(--accent-amber)' }} aria-hidden="true" />
                <span className="text-xs" style={{ color: 'var(--accent-amber)' }}>
                  will be held
                </span>
              </span>
            )}
          </button>
          </li>
        )
      })}
    </ul>
  )
}

function StarRating({ rating }: Readonly<{ rating: number }>) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="sr-only">{rating} out of 5 stars</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className="w-3.5 h-3.5"
          aria-hidden="true"
          style={{
            color: n <= rating ? 'var(--accent-gold)' : 'var(--border-strong)',
            fill:  n <= rating ? 'var(--accent-gold)' : 'transparent',
          }}
        />
      ))}
    </span>
  )
}

function ResponsePanel({ review }: Readonly<{ review: SandboxReview }>) {
  const [phase, setPhase]     = useState<Phase>('idle')
  const [shown, setShown]     = useState('')
  const timers                = useRef<ReturnType<typeof setTimeout>[]>([])
  const interval              = useRef<ReturnType<typeof setInterval> | null>(null)

  const full = review.generated.response

  const clearAll = useCallback(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    if (interval.current !== null) {
      clearInterval(interval.current)
      interval.current = null
    }
  }, [])

  // Every timer this component starts is torn down on unmount — the panel is
  // remounted on each selection change, so a leaked interval would keep
  // writing into a dead component's state.
  useEffect(() => clearAll, [clearAll])

  const reset = useCallback(() => {
    clearAll()
    setShown('')
    setPhase('idle')
  }, [clearAll])

  const skip = useCallback(() => {
    clearAll()
    setShown(full)
    setPhase('done')
  }, [clearAll, full])

  const generate = useCallback(() => {
    clearAll()
    setShown('')
    setPhase('thinking')

    // Respect the OS reduced-motion setting: a character-by-character reveal
    // is exactly the kind of motion that setting exists to suppress. Show the
    // response immediately after the thinking pause instead.
    const reducedMotion =
      typeof globalThis.matchMedia === 'function' &&
      globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches

    timers.current.push(setTimeout(() => {
      if (reducedMotion) {
        setShown(full)
        setPhase('done')
        return
      }

      setPhase('streaming')
      const startedAt = Date.now()
      interval.current = setInterval(() => {
        const n = revealedLength(Date.now() - startedAt, full.length)
        setShown(full.slice(0, n))
        if (n >= full.length) {
          clearAll()
          setPhase('done')
        }
      }, TICK_MS)
    }, THINKING_MS))
  }, [clearAll, full])

  const isHeld = review.generated.flags.length > 0

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <StarRating rating={review.starRating} />
              <p className="text-sm font-medium mt-1" style={{ color: 'var(--text-primary)' }}>
                {review.guestName} · {review.propertyName}
              </p>
            </div>
            <span className="text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
              {review.daysAgo === 1 ? '1 day ago' : `${review.daysAgo} days ago`}
            </span>
          </div>

          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {review.reviewText}
          </p>

          {review.internalNotes !== null && (
            <div
              className="rounded-md p-2.5 text-xs"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
            >
              <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                Internal note (never shown to the guest):{' '}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>{review.internalNotes}</span>
            </div>
          )}
        </div>
      </Card>

      {phase === 'idle' ? (
        <Button variant="cta" onClick={generate} className="w-full">
          <span className="inline-flex items-center justify-center gap-2">
            <Sparkles className="w-4 h-4" aria-hidden="true" />
            Generate response
          </span>
        </Button>
      ) : (
        <Card>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {phase === 'thinking' ? 'Analyzing review…' : 'Suggested response'}
              </span>
              <div className="flex items-center gap-2">
                {phase === 'streaming' && (
                  <button
                    type="button"
                    onClick={skip}
                    className="text-xs underline focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)] rounded"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Skip
                  </button>
                )}
                {phase === 'done' && (
                  <button
                    type="button"
                    onClick={reset}
                    className="inline-flex items-center gap-1 text-xs underline focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)] rounded"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <RotateCcw className="w-3 h-3" aria-hidden="true" />
                    Run again
                  </button>
                )}
              </div>
            </div>

            {phase === 'thinking' ? (
              <ThinkingSkeleton />
            ) : (
              <div aria-busy={phase === 'streaming'}>
                {/* Hidden from assistive tech mid-stream: announcing a
                    partial string on every tick would be unusable. The
                    completed text is exposed as a status region below. */}
                <p
                  className="text-sm leading-relaxed whitespace-pre-wrap"
                  style={{ color: 'var(--text-primary)' }}
                  aria-hidden={phase === 'streaming'}
                >
                  {shown}
                  {phase === 'streaming' && (
                    <span className="inline-block w-1.5 h-4 align-text-bottom ml-0.5 animate-pulse"
                          style={{ background: 'var(--accent-gold)' }} aria-hidden="true" />
                  )}
                </p>
                {phase === 'done' && <span className="sr-only" role="status">Response generated.</span>}
              </div>
            )}

            {phase === 'done' && <ResponseMeta review={review} />}
          </div>
        </Card>
      )}

      {phase === 'done' && isHeld && <HeldNotice reason={review.generated.flag_reason} />}

      {phase === 'done' && (
        <p className="text-xs italic leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {review.demoNote}
        </p>
      )}
    </div>
  )
}

function ThinkingSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {['92%', '100%', '78%'].map((w) => (
        <div
          key={w}
          className="h-3 rounded animate-pulse"
          style={{ width: w, background: 'var(--bg-raised)' }}
        />
      ))}
    </div>
  )
}

function ResponseMeta({ review }: Readonly<{ review: SandboxReview }>) {
  const { word_count, tone_used, flags } = review.generated
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <Badge tone="slate">{word_count} words</Badge>
      <Badge tone="blue">tone: {tone_used}</Badge>
      {flags.length === 0
        ? <Badge tone="green">ready to post</Badge>
        : flags.map((f) => <Badge key={f} tone="amber">flagged: {f}</Badge>)}
    </div>
  )
}

function HeldNotice({ reason }: Readonly<{ reason: string | null }>) {
  return (
    <div
      className="rounded-lg p-3 flex items-start gap-3"
      style={{ background: 'var(--bg-raised)', border: '1px solid var(--accent-amber)' }}
      role="note"
    >
      <ShieldAlert className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-amber)' }} aria-hidden="true" />
      <div>
        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Held in the moderation queue — not auto-posted
        </p>
        {reason !== null && (
          <p className="text-sm mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {reason}
          </p>
        )}
      </div>
    </div>
  )
}
