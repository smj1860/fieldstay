import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/lib/supabase/server'
import { repuguardLimiter } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/audit'
import { generateReviewResponse } from '@/lib/repuguard/generate-response'

export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // H-1: Rate limit — 50 generations per user per day (sliding window)
  const { success, reset } = await repuguardLimiter.limit(user.id)
  if (!success) {
    return NextResponse.json(
      { error: 'Daily generation limit reached. Try again tomorrow.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)) } }
    )
  }

  const body = await request.json().catch(() => null)
  const reviewId = typeof body?.review_id === 'string' ? body.review_id : null
  if (!reviewId) {
    return NextResponse.json({ error: 'Missing review_id' }, { status: 400 })
  }

  const admin = createServiceClient({ authenticatedUser: user })

  // Get org membership
  const { data: membership } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  const orgId = membership.org_id as string

  // Check repuguard_status
  const { data: org } = await admin
    .from('organizations')
    .select('repuguard_status')
    .eq('id', orgId)
    .single()

  if (!org || org.repuguard_status !== 'active') {
    return NextResponse.json({ error: 'RepuGuard is not enabled for this account.' }, { status: 403 })
  }

  // Fetch review with property name
  const { data: review } = await admin
    .from('reviews')
    .select('*, properties(name)')
    .eq('id', reviewId)
    .eq('org_id', orgId)
    .single()

  if (!review) {
    return NextResponse.json({ error: 'Review not found' }, { status: 404 })
  }

  const isManual = (review.external_source as string) === 'manual'

  // Fetch the existing response (if any) to enforce regeneration limits
  const { data: existingResponse } = await admin
    .from('review_responses')
    .select('id, regeneration_count, generated_response')
    .eq('review_id', reviewId)
    .maybeSingle()

  const isRegeneration = !!existingResponse?.generated_response

  // Manually-pasted reviews are edit-only — never regenerate them
  if (isRegeneration && isManual) {
    return NextResponse.json(
      { error: 'Manually added reviews cannot be regenerated. Edit the response directly.' },
      { status: 403 }
    )
  }

  // Synced reviews: cap regeneration at MAX_REGENERATIONS after the first draft
  const MAX_REGENERATIONS = 2
  if (isRegeneration && !isManual) {
    const regenCount = existingResponse?.regeneration_count ?? 0
    if (regenCount >= MAX_REGENERATIONS) {
      return NextResponse.json(
        { error: 'Maximum regenerations reached. Edit the response directly.' },
        { status: 429 }
      )
    }
  }

  const propertyData  = review.properties as { name?: string } | null
  const propertyName  = propertyData?.name ?? 'the property'
  const guestName     = (review.guest_name as string | null) ?? 'Guest'
  const reviewText    = review.review_text as string
  const starRating    = review.rating as number
  const internalNotes = (review.internal_notes as string | null) ?? null

  let parsed
  try {
    parsed = await generateReviewResponse({
      reviewText:    reviewText,
      starRating:    starRating,
      propertyName:  propertyName,
      guestName:     guestName,
      internalNotes: internalNotes,
    })
  } catch (err) {
    // Log the REAL error server-side — this is what let the June 15 model
    // retirement run undiagnosed for a month behind a generic message.
    // Never collapse this back to a bare `catch {}`.
    console.error('[RepuGuard] Response generation failed:', err instanceof Error ? err.message : err)
    const message = err instanceof Error && err.message.toLowerCase().includes('json')
      ? 'The AI response could not be parsed. Try regenerating.'
      : 'Response generation failed. Please try again in a moment.'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const hasFlags     = Array.isArray(parsed.flags) && parsed.flags.length > 0
  const responseStatus = hasFlags ? 'draft' : 'ready'

  // Upsert into review_responses
  const { data: savedResponse, error: upsertErr } = await admin
    .from('review_responses')
    .upsert({
      review_id:          reviewId,
      org_id:             orgId,
      generated_response: parsed.response,
      edited_response:    null,
      word_count:         parsed.word_count,
      tone_used:          parsed.tone_used,
      flags:              parsed.flags ?? [],
      flag_reason:        parsed.flag_reason ?? null,
      generated_at:       new Date().toISOString(),
      // Increment on regeneration; leave at 0 on the first generation
      regeneration_count: isRegeneration
        ? ((existingResponse?.regeneration_count ?? 0) + 1)
        : 0,
    }, { onConflict: 'review_id' })
    .select()
    .single()

  if (upsertErr) {
    console.error('[RepuGuard] Failed to save response:', upsertErr)
    return NextResponse.json({ error: 'Failed to save response' }, { status: 500 })
  }

  // Update review status
  await admin
    .from('reviews')
    .update({ response_status: responseStatus, updated_at: new Date().toISOString() })
    .eq('id', reviewId)

  await logAuditEvent({
    orgId:      orgId,
    actorId:    user.id,
    action:     'repuguard.response.generated',
    targetType: 'review',
    targetId:   reviewId,
    metadata: {
      flags:      parsed.flags,
      word_count: parsed.word_count,
      status:     responseStatus,
    },
  })

  return NextResponse.json({ ok: true, response: savedResponse })
}
