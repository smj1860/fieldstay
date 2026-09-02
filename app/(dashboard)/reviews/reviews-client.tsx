'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/observability/report-error'
import { requestBatchGeneration, submitManualReview } from './actions'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Star, Flag, Check } from 'lucide-react'
// TYPE-ONLY, deliberately: this is a client component and lib/integrations/
// registry.ts pulls in every provider adapter (API clients, webhook
// verification, node crypto). A type import is erased at compile time, so the
// exhaustiveness check below costs nothing in the browser bundle.
import type { PmsProviderId } from '@/lib/integrations/registry'

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

// Keyed by PmsProviderId rather than string ON PURPOSE. Hostaway reviews have
// been syncing since Phase 5 and landed here with no label at all, so a PM saw
// "Response posted" where every other provider says "Posted to <PMS>" — the
// hand-maintained-copy drift that PMS_PROVIDER_IDS was consolidated to stop,
// arriving in the one surface that still kept its own list. Typed this way the
// NEXT provider added to PMS_PROVIDER_IDS fails the build here instead.
const REVIEW_SOURCE_LABELS: Record<PmsProviderId, string> = {
  ownerrez:   'OwnerRez',
  hospitable: 'Hospitable',
  hostex:     'Hostex',
  hostaway:   'Hostaway',
}

/**
 * Display name for a review's source, or null when there isn't one.
 *
 * Null is a real case, not a gap: `manual` entries have no PMS behind them, and
 * the UI deliberately says "Response posted" rather than naming a platform for
 * those. The widening cast is sound — it only loosens the key type for lookup,
 * and an unrecognised source falls through to null.
 */
function reviewSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null
  return (REVIEW_SOURCE_LABELS as Record<string, string>)[source] ?? null
}

// Only OwnerRez has a confirmed working fallback URL when the sync didn't
// populate external_url. Don't fabricate one for other sources.
function getReviewPostUrl(review: Pick<ReviewRow, 'external_url' | 'external_source' | 'external_id'>): string | null {
  if (review.external_url) return review.external_url
  if (review.external_source === 'ownerrez') {
    return `https://app.ownerrez.com/reviews/${review.external_id}`
  }
  return null
}

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className="w-3.5 h-3.5"
          fill={i < rating ? 'var(--accent-gold)' : 'none'}
          style={{ color: i < rating ? 'var(--accent-gold)' : 'var(--border)' }}
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

  const { bg, color, text } = deadlineTone(daysRemaining)

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
    pending: { label: 'No Response',  bg: 'var(--border)',           color: 'var(--text-muted)' },
    draft:   { label: 'Draft',        bg: 'var(--accent-amber-dim)', color: 'var(--accent-amber)' },
    ready:   { label: 'Ready',        bg: 'var(--accent-green-dim)', color: 'var(--accent-green)' },
    posted:  { label: 'Posted',       bg: 'var(--accent-blue-dim)',  color: 'var(--accent-blue)' },
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



interface DeadlineTone { bg: string; color: string; text: string }

/** Colour band and label for the response-deadline pill. */
function deadlineTone(daysRemaining: number): DeadlineTone {
  if (daysRemaining < 0) {
    return { bg: 'var(--accent-red-dim)', color: 'var(--accent-red)', text: 'Overdue' }
  }
  const text = `${daysRemaining}d left`
  if (daysRemaining <= 3) return { bg: 'var(--accent-red-dim)',   color: 'var(--accent-red)',   text }
  if (daysRemaining <= 7) return { bg: 'var(--accent-amber-dim)', color: 'var(--accent-amber)', text }
  return { bg: 'var(--accent-green-dim)', color: 'var(--accent-green)', text }
}

/** The Mark-as-Ready button's contents, which double as its save state. */
function markReadyLabel(savingStatus: string | null): React.ReactNode {
  if (savingStatus === 'saving') return 'Saving…'
  if (savingStatus === 'saved')  return <><Check className="w-4 h-4" /> Saved</>
  return 'Mark as Ready'
}

type Failure = { ok: false; message: string }

/** Asks RepuGuard for a draft response to one review. */
async function requestGeneratedResponse(
  reviewId: string,
): Promise<{ ok: true; response: ReviewResponseRow } | Failure> {
  const res = await fetch('/api/repuguard/generate', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ review_id: reviewId }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
    return { ok: false, message: err.error ?? res.statusText }
  }

  const { response } = await res.json() as { response: ReviewResponseRow }
  return { ok: true, response }
}

/**
 * Saves the edited response and flips the review to `ready` — two writes, so a
 * failure in either is surfaced rather than leaving the pair disagreeing.
 */
async function persistReadyResponse(
  review:         ReviewRow,
  editedResponse: string,
): Promise<{ ok: true; response: ReviewResponseRow } | Failure> {
  const supabase  = createClient()
  const wordCount = editedResponse.trim().split(/\s+/).filter(Boolean).length

  // The stored row is spread FIRST so the fields this function computes win.
  // It used to come LAST, which meant a review that already had a response row
  // overwrote the PM's freshly typed text and its word count with the stored
  // values — `edited_response` is a column on that row, so the edit silently
  // never reached the database and reappeared as the generated text on reopen.
  //
  // The spread itself is still load-bearing and must not simply be dropped: it
  // carries tone_used, flag_reason, generated_at and regeneration_count, which
  // this upsert would otherwise reset to their defaults on conflict.
  const existing = review.review_responses ?? undefined

  const { data: updated, error: respErr } = await supabase
    .from('review_responses')
    .upsert({
      ...existing,
      review_id:          review.id,
      org_id:             review.org_id,
      generated_response: existing?.generated_response,
      flags:              existing?.flags ?? [],
      edited_response:    editedResponse,
      word_count:         wordCount,
    }, { onConflict: 'review_id' })
    .select()
    .single()

  if (respErr) return { ok: false, message: respErr.message }

  const { error: statusErr } = await supabase
    .from('reviews')
    .update({ response_status: 'ready', updated_at: new Date().toISOString() })
    .eq('id', review.id)

  if (statusErr) {
    console.error('[reviews] Failed to update review status:', statusErr)
    reportError(statusErr, { site: 'client.reviews.markReady', orgId: review.org_id })
    return { ok: false, message: statusErr.message }
  }

  return { ok: true, response: updated as ReviewResponseRow }
}


/** The per-review side panel: the guest's review, the drafted response, and
 *  the ready / post-to-PMS actions. */
function ReviewPanel({
  selected, onClose,
  editedResponse, setEditedResponse, wordCount,
  generating, generate, canRegen, regenLeft, isManual,
  savingStatus, markReady,
  postUrl, sourceLabel, postConfirm, setPostConfirm, confirmPosted,
}: Readonly<{
  selected:          ReviewRow
  onClose:           () => void
  editedResponse:    string
  setEditedResponse: (v: string) => void
  wordCount:         number
  generating:        boolean
  generate:          () => Promise<void>
  canRegen:          boolean
  regenLeft:         number
  isManual:          boolean
  savingStatus:      string | null
  markReady:         () => Promise<void>
  postUrl:           string | null
  sourceLabel:       string | null
  postConfirm:       boolean
  setPostConfirm:    (v: boolean) => void
  confirmPosted:     () => Promise<void>
}>) {
  return (
        <Dialog
          open
          onClose={onClose}
          title={selected.guest_name ?? 'Guest'}
          maxWidthClassName="max-w-lg"
          mobileSheet
        >
            {/* Panel header details — rating / property / date */}
            <div className="flex items-center gap-1 mb-1">
              <StarRating rating={selected.rating} />
            </div>
            {selected.properties?.name && (
              <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                {selected.properties.name}
                {selected.review_date && ` · ${new Date(selected.review_date).toLocaleDateString()}`}
              </p>
            )}

            <div className="space-y-5">
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
                  style={{ background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)', color: 'var(--accent-red)' }}
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
                    onChange={e => setEditedResponse(e.target.value)}
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
                      style={{ background: 'var(--accent-green)', color: 'var(--text-inverse)', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                    >
                      {markReadyLabel(savingStatus)}
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

                  {/* Post to PMS */}
                  {selected.response_status !== 'posted' && (
                    <div className="mt-4">
                      {postConfirm && (
                        <div
                          className="rounded-xl p-4 text-center"
                          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
                        >
                          <p className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>
                            {postUrl
                              ? `Did you post your response on ${sourceLabel ?? 'your PMS'}?`
                              : 'Did you post your response?'}
                          </p>
                          <div className="flex gap-3">
                            <button
                              onClick={confirmPosted}
                              className="flex-1 rounded-lg font-bold text-sm py-2.5"
                              style={{ background: 'var(--accent-green)', color: 'var(--text-inverse)', border: 'none', cursor: 'pointer' }}
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

                      {!postConfirm && (
                        postUrl ? (
                          <a
                            href={postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => setTimeout(() => setPostConfirm(true), 500)}
                            className="block w-full text-center rounded-xl font-semibold text-sm py-3 transition-opacity hover:opacity-80"
                            style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                          >
                            Post to {sourceLabel ?? 'your PMS'} →
                          </a>
                        ) : (
                          // Manual entries, or a source with no confirmed reply URL — no
                          // link to give, just let them confirm once they've replied
                          // wherever the review actually lives.
                          <button
                            onClick={() => setPostConfirm(true)}
                            className="block w-full text-center rounded-xl font-semibold text-sm py-3 transition-opacity hover:opacity-80"
                            style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)', border: '1px solid var(--border)', cursor: 'pointer' }}
                          >
                            Mark as Posted
                          </button>
                        )
                      )}
                    </div>
                  )}

                  {selected.response_status === 'posted' && (
                    <p className="mt-3 text-center text-sm font-semibold inline-flex items-center justify-center gap-1 w-full" style={{ color: 'var(--accent-blue)' }}>
                      <Check className="w-4 h-4" /> {sourceLabel ? `Posted to ${sourceLabel}` : 'Response posted'}
                    </p>
                  )}
                </div>
              )}
            </div>
        </Dialog>
  )
}

/** Page header: the manual-paste button with its weekly allowance, the
 *  batch-generate action, and the transient batch status message. */
function ReviewsHeader({
  manualLeft, manualLimit, onAddReview,
  pendingCount, batchRequesting, setBatchRequesting,
  batchMessage, setBatchMessage,
}: Readonly<{
  manualLeft:         number
  manualLimit:        number
  onAddReview:        () => void
  pendingCount:       number
  batchRequesting:    boolean
  setBatchRequesting: (v: boolean) => void
  batchMessage:       string | null
  setBatchMessage:    (v: string | null) => void
}>) {
  return (
    <>
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
            onClick={() => onAddReview()}
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
              {manualLeft}/{manualLimit} this week
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
            style={{ background: 'var(--accent-gold-dim)', color: 'var(--accent-gold-text)' }}
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
    </>
  )
}

/** The review list, or the first-run empty state when there is nothing yet. */
function ReviewsList({
  reviews, selectedId, onOpen,
}: Readonly<{
  reviews:    ReviewRow[]
  selectedId: string | null
  onOpen:     (review: ReviewRow) => void
}>) {
  return (
    <>
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
            Reviews sync automatically from your connected PMS every 6 hours. They&apos;ll appear
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
                onClick={() => onOpen(review)}
                className="w-full text-left rounded-2xl p-5 transition-all"
                style={{
                  background:  selectedId === review.id ? 'var(--bg-raised)' : 'var(--bg-base)',
                  border:      `1px solid ${selectedId === review.id ? 'var(--accent-gold)' : 'var(--border)'}`,
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
                        style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}
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
    </>
  )
}

export function ReviewsClient({ reviews: initialReviews, manualUsedThisWeek }: Props) {
  const [reviews, setReviews]           = useState<ReviewRow[]>(initialReviews)
  const [selected, setSelected]         = useState<ReviewRow | null>(null)
  const [editedResponse, setEditedResponse]     = useState('')
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
    setEditedResponse(review.review_responses?.edited_response ?? review.review_responses?.generated_response ?? '')
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
      const result = await requestGeneratedResponse(selected.id)
      if (!result.ok) {
        alert(`Failed to generate: ${result.message}`)
        return
      }
      const { response } = result
      setEditedResponse(response.generated_response ?? '')
      updateReviewInList({
        ...selected,
        response_status:  response.flags?.length > 0 ? 'draft' : 'ready',
        review_responses: response,
      })
    } finally {
      setGenerating(false)
    }
  }

  const markReady = async () => {
    if (!selected) return
    setSavingStatus('saving')

    const result = await persistReadyResponse(selected, editedResponse)
    if (!result.ok) {
      alert('Failed to save: ' + result.message)
      setSavingStatus(null)
      return
    }

    updateReviewInList({
      ...selected,
      response_status:  'ready',
      review_responses: result.response,
    })
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

  // Post-to-PMS state for the selected review
  const postUrl     = selected ? getReviewPostUrl(selected) : null
  const sourceLabel = reviewSourceLabel(selected?.external_source)

  return (
    <div className="relative">
      <ReviewsHeader
        manualLeft={manualLeft}
        manualLimit={MANUAL_LIMIT}
        onAddReview={() => setShowManualModal(true)}
        pendingCount={pendingCount}
        batchRequesting={batchRequesting}
        setBatchRequesting={setBatchRequesting}
        batchMessage={batchMessage}
        setBatchMessage={setBatchMessage}
      />

      <ReviewsList reviews={reviews} selectedId={selected?.id ?? null} onOpen={openPanel} />

      {selected && (
        <ReviewPanel
          selected={selected}
          onClose={closePanel}
          editedResponse={editedResponse}
          setEditedResponse={setEditedResponse}
          wordCount={wordCount}
          generating={generating}
          generate={generate}
          canRegen={canRegen}
          regenLeft={regenLeft}
          isManual={isManual}
          savingStatus={savingStatus}
          markReady={markReady}
          postUrl={postUrl}
          sourceLabel={sourceLabel}
          postConfirm={postConfirm}
          setPostConfirm={setPostConfirm}
          confirmPosted={confirmPosted}
        />
      )}

      {/* Manual review paste modal */}
      <Dialog
        open={showManualModal}
        onClose={() => setShowManualModal(false)}
        title="Add Review Manually"
        footer={
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
              globalThis.location.reload()
            }}
            disabled={manualSubmitting || !manualForm.reviewText.trim()}
            className="w-full rounded-xl font-bold text-sm py-3 transition-opacity disabled:opacity-50"
            style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)' }}
          >
            {manualSubmitting ? 'Generating response…' : 'Submit & Generate Response'}
          </button>
        }
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
            <label htmlFor="reviews-client-platform" className="label">Platform</label>
            <select id="reviews-client-platform"
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
            {/* Labels a group of star buttons, not a single control. */}
            <span className="label" id="manual-review-rating-label">Star Rating</span>
            <div className="flex gap-2" role="group" aria-labelledby="manual-review-rating-label">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setManualForm(f => ({ ...f, starRating: n }))}
                  className="transition-transform active:scale-90"
                  style={{ color: n <= manualForm.starRating ? 'var(--accent-gold)' : 'var(--border)' }}
                >
                  <Star className="w-6 h-6" fill={n <= manualForm.starRating ? 'var(--accent-gold)' : 'none'} />
                </button>
              ))}
            </div>
          </div>

          {/* Guest name */}
          <div>
            <label htmlFor="reviews-client-guest-name-optional" className="label">Guest Name (optional)</label>
            <Input id="reviews-client-guest-name-optional"
              type="text"
              value={manualForm.guestName}
              onChange={(e) => setManualForm(f => ({ ...f, guestName: e.target.value }))}
              placeholder="First name or initials"
            />
          </div>

          {/* Review text */}
          <div>
            <label htmlFor="reviews-client-review-text" className="label">Review Text</label>
            <textarea id="reviews-client-review-text"
              value={manualForm.reviewText}
              onChange={(e) => setManualForm(f => ({ ...f, reviewText: e.target.value }))}
              rows={5}
              placeholder="Paste the review text here…"
              className="input resize-none"
            />
          </div>
        </div>
      </Dialog>
    </div>
  )
}
