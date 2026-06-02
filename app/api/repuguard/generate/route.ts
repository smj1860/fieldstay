import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

const SYSTEM_PROMPT = `You are RepuGuard, a professional reputation management AI for short-term rental property managers.

Your job is to generate a calm, professional, and personalized response to a guest review. The response should:
- Thank the guest by name for their feedback
- Acknowledge any concerns raised without being defensive
- Highlight positives where appropriate
- Be warm but professional in tone
- Be concise (2–4 short paragraphs, under 200 words)
- Sound like it was written by a thoughtful property manager, not a robot
- Never sound defensive, dismissive, or sycophantic

You must respond with a JSON object in this exact shape:
{
  "response": "<the full response text>",
  "tone": "<one of: appreciative | empathetic | professional | warm>",
  "word_count": <integer>,
  "flags": [],
  "flag_reason": null
}

If the review contains anything that warrants caution (legal threats, extreme hostility, defamation, requests for refunds, sensitive personal situations), set flags to an array of relevant strings from: ["legal_threat","refund_request","defamatory","hostile","sensitive"] and set flag_reason to a brief explanation. Still generate a calm, safe response.

Return only the JSON object — no markdown fences, no explanation.`

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

  const body = await request.json().catch(() => null)
  const reviewId = typeof body?.review_id === 'string' ? body.review_id : null
  if (!reviewId) {
    return NextResponse.json({ error: 'Missing review_id' }, { status: 400 })
  }

  const admin = createServiceClient()

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

  if (!org || (org.repuguard_status !== 'trial' && org.repuguard_status !== 'active')) {
    return NextResponse.json({ error: 'RepuGuard not active' }, { status: 403 })
  }

  // Fetch review
  const { data: review } = await admin
    .from('reviews')
    .select('*, properties(name)')
    .eq('id', reviewId)
    .eq('org_id', orgId)
    .single()

  if (!review) {
    return NextResponse.json({ error: 'Review not found' }, { status: 404 })
  }

  const propertyData = review.properties as { name?: string } | null
  const propertyName = propertyData?.name ?? 'the property'
  const guestName    = (review.guest_name as string | null) ?? 'Guest'
  const reviewText   = review.review_text as string
  const starRating   = review.rating as number

  // Call Anthropic
  const client = new Anthropic()

  const userMessage = [
    `review_text: ${reviewText}`,
    `star_rating: ${starRating}`,
    `property_name: ${propertyName}`,
    `guest_name: ${guestName}`,
  ].join('\n')

  const message = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userMessage }],
  })

  const rawText = message.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('')

  // Strip markdown code fences if present
  const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()

  let parsed: {
    response:    string
    tone:        string
    word_count:  number
    flags:       string[]
    flag_reason: string | null
  }

  try {
    parsed = JSON.parse(cleaned) as typeof parsed
  } catch {
    console.error('[RepuGuard] Failed to parse Anthropic response:', cleaned)
    return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 })
  }

  const hasFlags = parsed.flags.length > 0
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
      tone_used:          parsed.tone,
      flags:              parsed.flags,
      flag_reason:        parsed.flag_reason ?? null,
      generated_at:       new Date().toISOString(),
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

  return NextResponse.json({ ok: true, response: savedResponse })
}
