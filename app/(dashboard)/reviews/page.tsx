import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { ReviewsClient } from './reviews-client'

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
  created_at: string
  updated_at: string
}

export default async function ReviewsPage() {
  const { membership } = await requireOrgMember()
  const admin = createServiceClient()

  // Check repuguard status
  const { data: org } = await admin
    .from('organizations')
    .select('repuguard_status, repuguard_trial_end')
    .eq('id', membership.org_id)
    .single()

  const repuguardStatus = org?.repuguard_status ?? 'inactive'

  if (repuguardStatus === 'inactive' || repuguardStatus === 'cancelled') {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div
          className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-6"
          style={{ background: 'var(--accent-gold-dim)' }}
        >
          <span style={{ fontSize: 28 }}>&#9733;</span>
        </div>
        <h1
          className="font-black text-3xl mb-3 tracking-tight"
          style={{ color: 'var(--text-primary)', letterSpacing: '-1px' }}
        >
          RepuGuard Reputation Engine
        </h1>
        <p
          className="text-base mb-4 leading-relaxed"
          style={{ color: 'var(--text-muted)', maxWidth: 480, margin: '0 auto 16px' }}
        >
          Every review deserves a professional response. RepuGuard reads the context of
          each guest review and generates calm, on-brand replies &mdash; automatically
          drafted and ready for your approval before anything posts.
        </p>
        <div
          className="inline-flex items-center gap-2 mb-8 px-4 py-2 rounded-full"
          style={{ background: 'rgba(61,139,79,0.12)', border: '1px solid rgba(61,139,79,0.3)' }}
        >
          <span
            className="text-white text-xs font-bold px-1.5 py-0.5 rounded"
            style={{ background: '#3D8B4F' }}
          >
            OR
          </span>
          <span className="text-sm font-medium" style={{ color: '#4ade80' }}>
            Included in your FieldStay subscription &middot; OwnerRez exclusive
          </span>
        </div>
        <form action="/api/repuguard/activate" method="POST">
          <button
            type="submit"
            className="inline-block rounded-xl font-bold text-sm px-8 py-3.5 transition-opacity hover:opacity-90"
            style={{
              background: 'var(--accent-gold)',
              color:      'var(--text-inverse)',
              border:     'none',
              cursor:     'pointer',
            }}
          >
            Enable RepuGuard &rarr;
          </button>
        </form>
        <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>
          Requires an active OwnerRez connection. No additional charge.
        </p>
      </div>
    )
  }

  // Fetch reviews with responses
  const { data: reviews } = await admin
    .from('reviews')
    .select(`
      *,
      review_responses (*),
      properties (name)
    `)
    .eq('org_id', membership.org_id)
    .order('review_date', { ascending: false })

  const RESPONSE_WINDOW_DAYS = 14

  const reviewsWithDeadline = (reviews ?? []).map(r => {
    const reviewDate = r.review_date ? new Date(r.review_date) : null
    const deadline   = reviewDate
      ? new Date(reviewDate.getTime() + RESPONSE_WINDOW_DAYS * 86_400_000)
      : null
    const daysRemaining = (deadline && r.response_status !== 'posted')
      ? Math.ceil((deadline.getTime() - Date.now()) / 86_400_000)
      : null

    return { ...r, days_remaining: daysRemaining }
  })

  reviewsWithDeadline.sort((a, b) => {
    const isPostedA = a.response_status === 'posted'
    const isPostedB = b.response_status === 'posted'
    if (isPostedA && !isPostedB) return 1
    if (isPostedB && !isPostedA) return -1
    const da = a.days_remaining ?? 999
    const db = b.days_remaining ?? 999
    return da - db
  })

  return (
    <ReviewsClient
      reviews={reviewsWithDeadline as ReviewRow[]}
      repuguardStatus={repuguardStatus as 'trial' | 'active'}
      orgId={membership.org_id}
    />
  )
}
