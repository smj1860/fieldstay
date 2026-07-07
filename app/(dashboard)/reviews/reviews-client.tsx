'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { requestBatchGeneration, submitManualReview } from './actions'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Star, Flag, Check } from 'lucide-react'

interface ReviewResponseRow {
  id: string
  review_id: string
  org_id: string
  generated_response: string | null
  edited_response: string | null
  word_count: number | null
  tone_used: string | null
  flags: string[]
  flag_reason: string | null
  generated_at: string | null
  regeneration_count: number
  created_at: string
  updated_at: string
}

interface ReviewRow {
  id: string
  org_id: string
  property_id: string | null
  external_id: string
  external_source: string
  guest_name: string | null
  rating: number
  review_text: string
  review_date: string | null
  response_status: string
  external_url: string | null
  created_at: string
  updated_at: string
  days_remaining: number | null
  review_responses: ReviewResponseRow | null
  properties: { name: string } | null
}

interface Props {
  reviews: ReviewRow[]
  manualUsedThisWeek: number
}

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className="w-3.5 h-3.5"
          fill={i < rating ? '#FCD116' : 'none'}
          style={{ color: i < rating ? '#FCD116' : 'var(--border)' }}
        />
      ))}
    </span>
  )
}

function DeadlineBadge({
  daysRemaining,
  status,
}: {
  daysRemaining: number | null
  status:        string
}) {
  if (status === 'posted' || daysRemaining === null) return null

  const [bg, color, text]: [string, string, string] =
    daysRemaining < 0  ? ['rgba(127,29,29,0.15)',    '#991b1b',              'Overdue']                  :
    daysRemaining <= 3 ? ['var(--accent-red-dim)',   'var(--accent-red)',    `${daysRemaining}d left`]   :
    daysRemaining <= 7 ? ['var(--accent-amber-dim)', 'var(--accent-amber)', `${daysRemaining}d left`]   :
                         ['var(--accent-green-dim)', 'var(--accent-green)', `${daysRemaining}d left`]

  return (
    <span
      className="text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{ background: bg, color }}
    >
      {text}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; bg: string; color: string }> = {
    pending: { label: 'No Response',  bg: 'rgba(107,114,128,0.15)', color: 'var(--text-muted)' },
    draft:   { label: 'Draft',        bg: 'rgba(251,191,36,0.15)',  color: '#D97706' },
    ready:   { label: 'Ready',        bg: 'rgba(16,185,129,0.15)',  color: '#059669' },
    posted:  { label: 'Posted',       bg: 'rgba(59,130,246,0.15)',  color: '#2563EB' },
  }
  const s = map[status] ?? map['pending']!
  return (
    <span
      className="text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{ background: s.bg, color: s.color }}
    >
      {s.label}
    </span>
  )
}

export function ReviewsClient({ reviews: initialReviews, manualUsedThisWeek }: Props) {
  const [reviews, setReviews]           = useState<ReviewRow[]>(initialReviews)
  const [selected, setSelected]         = useState<ReviewRow | null>(null)
  const [editedResponse, setEdited]     = useState('')
  const [generating, setGenerating]     = useState(false)
  const [savingStatus, setSavingStatus] = useState<string | null>(null)
  const [postConfirm, setPostConfirm]   = useState(false)
  const [batchRequesting, setBatchRequesting] = useState(false)
  const [batchMessage, setBatchMessage]       = useState<string | null>(null)

  // Manual review paste
  const [showManualModal, setShowManualModal] = useState(false)
  const [manualForm, setManualForm] = useState({
    reviewText: '',
    starRating: 5,
    guestName:  '',
    propertyId: null as string | null,
    platform:   'airbnb',
  })
  const [manualSubmitting, setManualSubmitting] = useState(false)
  const [manualError, setManualError]           = useState<string | null>(null)
  const [manualUsed, setManualUsed]             = useState(manualUsedThisWeek)

  const MANUAL_LIMIT = 2
  const manualLeft   = MANUAL_LIMIT - manualUsed

  const pendingCount = reviews.filter(r => r.response_status === 'pending').length

  useEffect(() => {
    if (!batchMessage) return
    const t = setTimeout(() => setBatchMessage(null), 4000)
    return () => clearTimeout(t)
  }, [batchMessage])

  const openPanel = (review: ReviewRow) => {
    setSelected(review)
    setEdited(review.review_responses?.edited_response ?? review.review_responses?.generated_response ?? '')
    setPostConfirm(false)
  }

  const closePanel = () => {
    setSelected(null)
    setPostConfirm(false)
  }

  const updateReviewInList = (updated: ReviewRow) => {
    setReviews(prev => prev.map(r => r.id === updated.id ? updated : r))
    setSelected(updated)
  }

  const generate = async () => {
    if (!selected) return
    setGenerating(true)
    try {
      const res  = await fetch('/api/repuguard/generate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ review_id: selected.id }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
        alert(`Failed to generate: ${err.error ?? res.statusText}`)
        return
      }
      const { response } = await res.json() as { response: ReviewResponseRow }
      const updatedReview: ReviewRow = {
        ...selected,
        response_status:  response.flags?.length > 0 ? 'draft' : 'ready',
        review_responses: response,
      }
      setEdited(response.generated_response ?? '')
      updateReviewInList(updatedReview)
    } finally {
      setGenerating(false)
    }
  }

  const markReady = async () => {
    if (!selected) return
    setSavingStatus('saving')
    const supabase = createClient()

    const wordCount = editedResponse.trim().split(/\s+/).filter(Boolean).length

    // Upsert response
    const { data: updated, error: respErr } = await supabase
      .from('review_responses')
      .upsert({
        review_id:       selected.id,
        org_id:          selected.org_id,
        edited_response: editedResponse,
        word_count:      wordCount,
        ...(selected.review_responses ?? {}),
        generated_response: selected.review_responses?.generated_response,
        flags:           selected.review_responses?.flags ?? [],
      }, { onConflict: 'review_id' })
      .select()
      .single()

    if (respErr) {
      alert('Failed to save: ' + respErr.message)
      setSavingStatus(null)
      return
    }

    // Update review status
    await supabase
      .from('reviews')
      .update({ response_status: 'ready', updated_at: new Date().toISOString() })
      .eq('id', selected.id)

    const updatedReview: ReviewRow = {
      ...selected,
      response_status:  'ready',
      review_responses: updated as ReviewResponseRow,
    }
    updateReviewInList(updatedReview)
    setSavingStatus('saved')
    setTimeout(() => setSavingStatus(null), 2000)
  }

  const confirmPosted = async () => {
    if (!selected) return
    const supabase = createClient()
    const { error } = await supabase
      .from('reviews')
      .update({ response_status: 'posted', updated_at: new Date().toISOString() })
      .eq('id', selected.id)

    if (error) {
      console.error('[reviews] Failed to mark as posted:', error)
      alert('Failed to mark as posted. Please try again.')
      return
    }

    const updatedReview: ReviewRow = { ...selected, response_status: 'posted' }
    updateReviewInList(updatedReview)
    setPostConfirm(false)
  }

  const wordCount = editedResponse.trim().split(/\s+/).filter(Boolean).length

  // Regeneration limit state for the selected review
  const regenCount = selected?.review_responses?.regeneration_count ?? 0
  const isManual   = selected?.external_source === 'manual'
  const MAX_REGENS = 2
  const regenLeft  = MAX_REGENS - regenCount
  const canRegen   = !isManual && regenLeft > 0

  return (
    <div className="relative">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1
            className="font-black text-2xl tracking-tight"
            style={{ color: 'var(--text-primary)', letterSpacing: '-0.75px' }}
          >
            Reviews
          </h1>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => setShowManualModal(true)}
            disabled={manualLeft <= 0}
            className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            style={{
              background: manualLeft > 0 ? 'var(--accent-gold)' : 'var(--bg-raised)',
              color:      manualLeft > 0 ? 'var(--text-inverse)' : 'var(--text-muted)',
            }}
          >
            + Add Review
            <span
              className="text-xs px-1.5 py-0.5 rounded-full ml-1"
              style={{
                background: 'rgba(0,0,0,0.15)',
                color:      manualLeft > 0 ? 'var(--text-inverse)' : 'var(--text-muted)',
              }}
            >
              {manualLeft}/{MANUAL_LIMIT} this week
            </span>
          </button>
          {pendingCount > 0 && (
            <Button
              variant="secondary"
              onClick={async () => {
                setBatchRequesting(true)
                const result = await requestBatchGeneration()
                setBatchMessage(
                  result.error ?? `Drafting ${Math.min(pendingCount, 25)} review${pendingCount !== 1 ? 's' : ''} — we'll email you when it's done.`
                )
                setBatchRequesting(false)
              }}
              disabled={batchRequesting}
              className="text-sm"
            >
              {batchRequesting ? 'Starting…' : `Generate All Drafts (${pendingCount})`}
            </Button>
          )}
          <span
            className="text-xs font-semibold px-3 py-1 rounded-full"
            style={{ background: 'rgba(252,209,22,0.15)', color: '#D97706' }}
          >
            Powered by RepuGuard
          </span>
        </div>
      </div>

      {batchMessage && (
        <div
          className="mb-4 text-sm rounded-xl px-4 py-3 border"
          style={{ color: 'var(--text-muted)', background: 'var(--bg-canvas)', borderColor: 'var(--border)' }}
        >
          {batchMessage}
        </div>
      )}

      {/* Reviews list */}
      {reviews.length === 0 ? (
        <div className="max-w-lg mx-auto py-16 text-center">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-5"
            style={{ background: 'var(--accent-gold-dim)' }}
          >
            <Star className="w-6 h-6" fill="var(--accent-gold)" style={{ color: 'var(--accent-gold)' }} />
          </div>
          <h2 className="font-black text-xl mb-2 tracking-tight" style={{ color: 'var(--text-primary)' }}>
            No reviews yet
          </h2>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Reviews sync automatically from OwnerRez every 6 hours. They&apos;ll appear
            here once your first review lands — or use <strong>+ Add Review</strong> above
            to paste one from another platform.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map(review => {
            const flagged = (review.review_responses?.flags?.length ?? 0) > 0
            const truncated = review.review_text.length > 120
              ? review.review_text.slice(0, 120) + '…'
              : review.review_text

            return (
              <button
                key={review.id}
                onClick={() => openPanel(review)}
                className="w-full text-left rounded-2xl p-5 transition-all"
                style={{
                  background:  selected?.id === review.id ? 'var(--bg-raised)' : 'var(--bg-base)',
                  border:      `1px solid ${selected?.id === review.id ? 'var(--accent-gold)' : 'var(--border)'}`,
                  cursor:      'pointer',
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                      <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                        {review.guest_name ?? 'Guest'}
                      </span>
                      <StarRating rating={review.rating} />
                      {review.properties?.name && (
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {review.properties.name}
                        </span>
                      )}
                      {review.review_date && (
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {new Date(review.review_date).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      {truncated}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {flagged && (
                      <span
                        className="text-xs font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                        style={{ background: 'rgba(239,68,68,0.15)', color: '#DC2626' }}
                      >
                        <Flag className="w-3 h-3" /> Flagged
                      </span>
                    )}
                    <DeadlineBadge
                      daysRemaining={review.days_remaining}
                      status={review.response_status}
                    />
                    <StatusBadge status={review.response_status} />
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Side panel */}
      {selected && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(0,0,0,0.4)' }}
            role="button"
            tabIndex={0}
            aria-label="Close review panel"
            onClick={closePanel}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closePanel() } }}
          />

          {/* Drawer */}
          <aside
            className="fixed right-0 top-0 h-full z-50 flex flex-col overflow-y-auto"
            style={{
              width:       'min(520px, 95vw)',
              background:  'var(--bg-base)',
              borderLeft:  '1px solid var(--border)',
              boxShadow:   '-8px 0 40px rgba(0,0,0,0.25)',
            }}
          >
            {/* Panel header */}
            <div
              className="flex items-center justify-between px-6 py-5 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <div>
                <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
                  {selected.guest_name ?? 'Guest'} · <StarRating rating={selected.rating} />
                </h2>
                {selected.properties?.name && (
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {selected.properties.name}
                    {selected.review_date && ` · ${new Date(selected.review_date).toLocaleDateString()}`}
                  </p>
                )}
              </div>
              <button
                onClick={closePanel}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-xl"
                style={{ color: 'var(--text-muted)', background: 'var(--bg-raised)' }}
              >
                ×
              </button>
            </div>

            <div className="flex-1 px-6 py-5 space-y-5">
              {/* Review text */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
                  Guest Review
                </p>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                  {selected.review_text}
                </p>
              </div>

              {/* Flagged warning */}
              {(selected.review_responses?.flags?.length ?? 0) > 0 && (
                <div
                  className="rounded-xl px-4 py-3 text-sm"
                  style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#DC2626' }}
                >
                  <strong className="inline-flex items-center gap-1"><Flag className="w-3.5 h-3.5" /> Flagged:</strong>{' '}
                  {selected.review_responses?.flags.join(', ')}
                  {selected.review_responses?.flag_reason && (
                    <span className="block mt-1 text-xs opacity-80">{selected.review_responses.flag_reason}</span>
                  )}
                </div>
              )}

              {/* Generate button */}
              {!selected.review_responses?.generated_response && (
                <button
                  onClick={generate}
                  disabled={generating}
                  className="w-full rounded-xl font-bold text-sm py-3.5 transition-opacity hover:opacity-90"
                  style={{
                    background: generating ? 'var(--bg-raised)' : 'var(--accent-gold)',
                    color:      generating ? 'var(--text-muted)' : 'var(--text-inverse)',
                    border:     'none',
                    cursor:     generating ? 'not-allowed' : 'pointer',
                  }}
                >
                  {generating ? 'Generating response…' : 'Generate Response with RepuGuard →'}
                </button>
              )}

              {/* Response editor */}
              {selected.review_responses?.generated_response && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Response
                      {selected.review_responses.tone_used && (
                        <span className="ml-2 normal-case font-normal" style={{ color: 'var(--text-muted)' }}>
                          · tone: {selected.review_responses.tone_used}
                        </span>
                      )}
                    </p>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {wordCount} words
                    </span>
                  </div>
                  <textarea
                    value={editedResponse}
                    onChange={e => setEdited(e.target.value)}
                    rows={8}
                    className="w-full rounded-xl text-sm p-4 outline-none resize-none"
                    style={{
                      background:  'var(--bg-raised)',
                      border:      '1.5px solid var(--border)',
                      color:       'var(--text-primary)',
                      lineHeight:  1.6,
                    }}
                    onFocus={e  => (e.currentTarget.style.borderColor = 'var(--accent-gold)')}
                    onBlur={e   => (e.currentTarget.style.borderColor = 'var(--border)')}
                  />

                  <div className="flex gap-3 mt-3 flex-wrap">
                    <button
                      onClick={markReady}
                      className="flex-1 rounded-xl font-bold text-sm py-3 transition-opacity hover:opacity-90"
                      style={{ background: '#059669', color: '#fff', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                    >
                      {savingStatus === 'saving'
                        ? 'Saving…'
                        : savingStatus === 'saved'
                        ? <><Check className="w-4 h-4" /> Saved</>
                        : 'Mark as Ready'}
                    </button>

                    {canRegen && (
                      <button
                        onClick={generate}
                        disabled={generating}
                        className="px-4 rounded-xl font-semibold text-sm py-3 transition-opacity hover:opacity-80"
                        style={{
                          background: 'var(--bg-raised)',
                          color:      'var(--text-muted)',
                          border:     '1px solid var(--border)',
                          cursor:     generating ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {generating ? '…' : `Regenerate (${regenLeft} left)`}
                      </button>
                    )}

                    {!canRegen && !isManual && (
                      <p className="text-xs self-center" style={{ color: 'var(--text-muted)' }}>
                        Max regenerations reached — edit above
                      </p>
                    )}

                    {isManual && (
                      <p className="text-xs self-center" style={{ color: 'var(--text-muted)' }}>
                        Edit response above
                      </p>
                    )}
                  </div>

                  {/* Post to OwnerRez */}
                  {selected.response_status !== 'posted' && (
                    <div className="mt-4">
                      {!postConfirm ? (
                        <a
                          href={selected.external_url ?? `https://app.ownerrez.com/reviews/${selected.external_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => setTimeout(() => setPostConfirm(true), 500)}
                          className="block w-full text-center rounded-xl font-semibold text-sm py-3 transition-opacity hover:opacity-80"
                          style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                        >
                          Post to OwnerRez →
                        </a>
                      ) : (
                        <div
                          className="rounded-xl p-4 text-center"
                          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
                        >
                          <p className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>
                            Did you post your response on OwnerRez?
                          </p>
                          <div className="flex gap-3">
                            <button
                              onClick={confirmPosted}
                              className="flex-1 rounded-lg font-bold text-sm py-2.5"
                              style={{ background: '#059669', color: '#fff', border: 'none', cursor: 'pointer' }}
                            >
                              Yes, mark as posted
                            </button>
                            <button
                              onClick={() => setPostConfirm(false)}
                              className="flex-1 rounded-lg font-semibold text-sm py-2.5"
                              style={{ background: 'var(--border)', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }}
                            >
                              Not yet
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {selected.response_status === 'posted' && (
                    <p className="mt-3 text-center text-sm font-semibold inline-flex items-center justify-center gap-1 w-full" style={{ color: '#2563EB' }}>
                      <Check className="w-4 h-4" /> Posted to OwnerRez
                    </p>
                  )}
                </div>
              )}
            </div>
          </aside>
        </>
      )}

      {/* Manual review paste modal */}
      <Dialog
        open={showManualModal}
        onClose={() => setShowManualModal(false)}
        title="Add Review Manually"
      >
        <div className="space-y-4">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            For reviews from Airbnb, Vrbo, Google, or other platforms that don&apos;t sync
            automatically. AI response is generated once — edit the draft as needed.
          </p>

          {manualError && (
            <p className="text-sm font-medium" style={{ color: 'var(--accent-red)' }}>
              {manualError}
            </p>
          )}

          {/* Platform */}
          <div>
            <label className="label">Platform</label>
            <select
              value={manualForm.platform}
              onChange={(e) => setManualForm(f => ({ ...f, platform: e.target.value }))}
              className="input"
            >
              <option value="airbnb">Airbnb</option>
              <option value="vrbo">Vrbo</option>
              <option value="google">Google</option>
              <option value="booking">Booking.com</option>
              <option value="other">Other</option>
            </select>
          </div>

          {/* Star rating */}
          <div>
            <label className="label">Star Rating</label>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setManualForm(f => ({ ...f, starRating: n }))}
                  className="transition-transform active:scale-90"
                  style={{ color: n <= manualForm.starRating ? '#FCD116' : 'var(--border)' }}
                >
                  <Star className="w-6 h-6" fill={n <= manualForm.starRating ? '#FCD116' : 'none'} />
                </button>
              ))}
            </div>
          </div>

          {/* Guest name */}
          <div>
            <label className="label">Guest Name (optional)</label>
            <Input
              type="text"
              value={manualForm.guestName}
              onChange={(e) => setManualForm(f => ({ ...f, guestName: e.target.value }))}
              placeholder="First name or initials"
            />
          </div>

          {/* Review text */}
          <div>
            <label className="label">Review Text</label>
            <textarea
              value={manualForm.reviewText}
              onChange={(e) => setManualForm(f => ({ ...f, reviewText: e.target.value }))}
              rows={5}
              placeholder="Paste the review text here…"
              className="input resize-none"
            />
          </div>

          <button
            onClick={async () => {
              setManualSubmitting(true)
              setManualError(null)
              const result = await submitManualReview(manualForm)
              if ('error' in result) {
                setManualError(result.error)
                setManualSubmitting(false)
                return
              }
              // Immediately generate response
              await fetch('/api/repuguard/generate', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ review_id: result.reviewId }),
              })
              setManualUsed(u => u + 1)
              setShowManualModal(false)
              setManualSubmitting(false)
              setManualForm({ reviewText: '', starRating: 5, guestName: '', propertyId: null, platform: 'airbnb' })
              // Reload to show the new review with its generated response
              window.location.reload()
            }}
            disabled={manualSubmitting || !manualForm.reviewText.trim()}
            className="w-full rounded-xl font-bold text-sm py-3 transition-opacity disabled:opacity-50"
            style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)' }}
          >
            {manualSubmitting ? 'Generating response…' : 'Submit & Generate Response'}
          </button>
        </div>
      </Dialog>
    </div>
  )
}
