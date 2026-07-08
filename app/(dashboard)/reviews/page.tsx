import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { ReviewsClient } from './reviews-client'
import { getManualReviewsUsedThisWeek } from './actions'

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
  regeneration_count: number
  created_at: string
  updated_at: string
}

export default async function ReviewsPage() {
  const { membership } = await requireOrgMember()
  const admin = createServiceClient()

  const manualUsedThisWeek = await getManualReviewsUsedThisWeek()

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

  // Always render ReviewsClient (even with zero reviews) so the manual-paste
  // entry point stays reachable. ReviewsClient renders its own empty state.
  return (
    <ReviewsClient
      reviews={reviewsWithDeadline as ReviewRow[]}
      manualUsedThisWeek={manualUsedThisWeek}
    />
  )
}
