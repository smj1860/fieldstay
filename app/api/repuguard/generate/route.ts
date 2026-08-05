import { NextRequest, NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/lib/supabase/server'
import { repuguardLimiter, checkLimit, retryAfterSeconds } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/audit'
import { generateReviewResponse } from '@/lib/repuguard/generate-response'

import { reportError } from '@/lib/observability/report-error'
type AdminClient = ReturnType<typeof createServiceClient>

/** Session + daily spend ceiling. Returns the caller, or the response to send. */
async function authorizeCaller(): Promise<
  { user: User } | { response: NextResponse }
> {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  // H-1: Rate limit — 50 generations per user per day (sliding window).
  // Spend ceiling → fails CLOSED: each generation is a billed LLM call.
  // Previously this had no catch at all.
  const rl = await checkLimit(repuguardLimiter, user.id, {
    onError: 'deny',
    site:    'route.repuguard.generate.POST',
  })
  if (!rl.allowed) {
    return {
      response: NextResponse.json(
        { error: 'Daily generation limit reached. Try again tomorrow.' },
        { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(rl)) } }
      ),
    }
  }

  return { user }
}

/** Resolves the caller's org and confirms RepuGuard is enabled for it. */
async function resolveEntitledOrg(
  admin:  AdminClient,
  userId: string,
): Promise<{ orgId: string } | { response: NextResponse }> {
  const { data: membership } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', userId)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!membership) {
    return { response: NextResponse.json({ error: 'No organization found' }, { status: 403 }) }
  }

  const orgId = membership.org_id as string

  // No repuguard_status gate. RepuGuard ships with every plan — the standalone
  // subscription was dropped long ago — but this check survived it, and the
  // column DEFAULTs to 'inactive'. The only thing that ever set it to 'active'
  // was the OwnerRez initial-sync auto-activate step, so any org that never
  // connected OwnerRez got a 403 on a feature included in their plan. On
  // production that was 6 of 8 orgs. Org membership is the entitlement now.

  return { orgId }
}

const MAX_REGENERATIONS = 2

/**
 * Regeneration policy. Manually-pasted reviews are edit-only; synced reviews
 * get MAX_REGENERATIONS re-rolls after the first draft.
 */
function regenerationRefusal(
  isRegeneration: boolean,
  isManual:       boolean,
  regenCount:     number,
): NextResponse | null {
  if (!isRegeneration) return null

  if (isManual) {
    return NextResponse.json(
      { error: 'Manually added reviews cannot be regenerated. Edit the response directly.' },
      { status: 403 }
    )
  }

  if (regenCount >= MAX_REGENERATIONS) {
    return NextResponse.json(
      { error: 'Maximum regenerations reached. Edit the response directly.' },
      { status: 429 }
    )
  }

  return null
}

type GenerateInput = Parameters<typeof generateReviewResponse>[0]
type GeneratedResponse = Awaited<ReturnType<typeof generateReviewResponse>>

/** Wraps the LLM call so its failure mapping lives outside the request flow. */
async function generateOrFail(
  input: GenerateInput,
): Promise<{ parsed: GeneratedResponse } | { response: NextResponse }> {
  try {
    return { parsed: await generateReviewResponse(input) }
  } catch (err) {
    // Log the REAL error server-side — this is what let the June 15 model
    // retirement run undiagnosed for a month behind a generic message.
    // Never collapse this back to a bare `catch {}`.
    console.error('[RepuGuard] Response generation failed:', err instanceof Error ? err.message : err)
    reportError(err, { site: 'route.repuguard.generate.RepuGuard' })
    const message = err instanceof Error && err.message.toLowerCase().includes('json')
      ? 'The AI response could not be parsed. Try regenerating.'
      : 'Response generation failed. Please try again in a moment.'
    return { response: NextResponse.json({ error: message }, { status: 500 }) }
  }
}

export async function POST(request: NextRequest) {
  const authorized = await authorizeCaller()
  if ('response' in authorized) return authorized.response
  const { user } = authorized

  const body = await request.json().catch(() => null)
  const reviewId = typeof body?.review_id === 'string' ? body.review_id : null
  if (!reviewId) {
    return NextResponse.json({ error: 'Missing review_id' }, { status: 400 })
  }

  const admin = createServiceClient({ authenticatedUser: user })

  const entitled = await resolveEntitledOrg(admin, user.id)
  if ('response' in entitled) return entitled.response
  const { orgId } = entitled

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

  const refusal = regenerationRefusal(
    isRegeneration,
    isManual,
    existingResponse?.regeneration_count ?? 0,
  )
  if (refusal) return refusal

  const propertyData  = review.properties as { name?: string } | null
  const propertyName  = propertyData?.name ?? 'the property'
  const guestName     = (review.guest_name as string | null) ?? 'Guest'
  const reviewText    = review.review_text as string
  const starRating    = review.rating as number
  // Always null — see lib/inngest/functions/repuguard-batch-generate.ts. There
  // is no internal_notes column on `reviews`. This path selected `*` rather
  // than naming the column, so unlike the batch cron it never errored: the
  // property was simply always undefined and `?? null` made that invisible.
  // The `as string | null` cast is what let a field that cannot exist read as
  // a field that is merely empty.
  const internalNotes: string | null = null

  const generated = await generateOrFail({
    reviewText, starRating, propertyName, guestName, internalNotes,
  })
  if ('response' in generated) return generated.response
  const { parsed } = generated

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
