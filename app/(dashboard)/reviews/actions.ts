'use server'

import { randomUUID } from 'crypto'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

const MANUAL_WEEKLY_LIMIT = 2

export async function requestBatchGeneration(): Promise<{ success: boolean; error?: string }> {
  const { user, supabase, membership } = await requireOrgMember()

  const { data: org } = await supabase
    .from('organizations')
    .select('repuguard_status')
    .eq('id', membership.org_id)
    .single()

  if (org?.repuguard_status !== 'active') {
    return { success: false, error: 'RepuGuard is not enabled for this account.' }
  }

  await inngest.send({
    name: 'repuguard/batch_generate.requested',
    data: { org_id: membership.org_id, requested_by: user.id },
  })

  return { success: true }
}

// Monday 00:00 local for the week containing `now`
function startOfWeekMonday(now: Date): Date {
  const dayOfWeek    = now.getDay()            // 0 = Sunday, 1 = Monday
  const daysSinceMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const monday       = new Date(now)
  monday.setDate(now.getDate() - daysSinceMon)
  monday.setHours(0, 0, 0, 0)
  return monday
}

export async function submitManualReview(input: {
  reviewText:   string
  starRating:   number
  guestName:    string
  propertyId:   string | null
  platform:     string  // 'airbnb' | 'vrbo' | 'google' | 'booking' | 'other'
}): Promise<{ reviewId: string } | { error: string }> {
  const { membership } = await requireOrgMember()
  const supabase       = createServiceClient()

  // Validate
  if (!input.reviewText?.trim()) return { error: 'Review text is required.' }
  if (!input.starRating || input.starRating < 1 || input.starRating > 5) {
    return { error: 'Star rating must be between 1 and 5.' }
  }

  // Weekly limit check — resets every Monday
  const monday = startOfWeekMonday(new Date())

  const { count } = await supabase
    .from('reviews')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', membership.org_id)
    .eq('external_source', 'manual')
    .gte('created_at', monday.toISOString())

  if ((count ?? 0) >= MANUAL_WEEKLY_LIMIT) {
    const nextMonday = new Date(monday)
    nextMonday.setDate(monday.getDate() + 7)
    const resetDate = nextMonday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return { error: `You've used both manual reviews for this week. Resets ${resetDate} (Monday).` }
  }

  // Verify property belongs to this org if supplied
  if (input.propertyId) {
    const { data: prop } = await supabase
      .from('properties')
      .select('id')
      .eq('id', input.propertyId)
      .eq('org_id', membership.org_id)
      .single()
    if (!prop) return { error: 'Property not found.' }
  }

  // Insert review with external_source = 'manual'
  const { data: review, error: insertErr } = await supabase
    .from('reviews')
    .insert({
      org_id:          membership.org_id,
      property_id:     input.propertyId ?? null,
      external_id:     randomUUID(),
      external_source: 'manual',
      guest_name:      input.guestName?.trim() || null,
      rating:          input.starRating,
      review_text:     input.reviewText.trim(),
      review_date:     new Date().toISOString().split('T')[0],
      response_status: 'pending',
      // Store platform in external_url as a label — no schema change needed
      external_url:    input.platform !== 'other' ? input.platform : null,
    })
    .select('id')
    .single()

  if (insertErr || !review) {
    return { error: 'Failed to save review. Please try again.' }
  }

  return { reviewId: review.id }
}

export async function getManualReviewsUsedThisWeek(orgId: string): Promise<number> {
  const supabase = createServiceClient()
  const monday   = startOfWeekMonday(new Date())

  const { count } = await supabase
    .from('reviews')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('external_source', 'manual')
    .gte('created_at', monday.toISOString())

  return count ?? 0
}
