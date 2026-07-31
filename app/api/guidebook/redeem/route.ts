import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { guidebookRedeemLimiter, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import { reportError } from '@/lib/observability/report-error'

/**
 * POST /api/guidebook/redeem
 *
 * Called by a guest tapping a sponsor offer on their guidebook page. No
 * session by definition — reachability comes from proxy.ts's '/api/guidebook'
 * TOKEN_ROUTES entry (before that entry existed, every call here 307'd to
 * /login and this endpoint was dead).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Abuse limiter → fails OPEN: a Redis outage must not stop guests
  // redeeming offers. The broader per-IP enumeration ceiling for this surface
  // is proxy.ts's guidebookRatelimit; this one bounds redemption spam
  // specifically.
  const decision = await checkLimit(guidebookRedeemLimiter, extractClientIp(req) ?? 'unknown', {
    onError: 'allow',
    site:    'route.guidebook.redeem.POST',
  })
  if (!decision.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const body = await req.json().catch(() => null) as { sponsorId?: string; bookingToken?: string | null } | null
  if (!body?.sponsorId || typeof body.sponsorId !== 'string') {
    return NextResponse.json({ error: 'sponsorId is required' }, { status: 400 })
  }

  try {
    const supabase = createServiceClient({ publicSurface: 'api-guidebook-redeem' })

    const { data: sponsor } = await supabase
      .from('guidebook_sponsors')
      .select('id, org_id, status')
      .eq('id', body.sponsorId)
      .maybeSingle()

    if (!sponsor || sponsor.status !== 'active') {
      // Don't disclose sponsor existence on a public surface
      return NextResponse.json({ ok: true })
    }

    let bookingId: string | null = null
    if (body.bookingToken && typeof body.bookingToken === 'string') {
      const { data: booking } = await supabase
        .from('bookings')
        .select('id, org_id')
        .eq('guidebook_token', body.bookingToken)
        .maybeSingle()
      // Tenant isolation: only attach the booking if it belongs to the
      // sponsor's org — otherwise log anonymously.
      if (booking && booking.org_id === sponsor.org_id) bookingId = booking.id
    }

    const { error } = await supabase.from('guidebook_offer_redemptions').insert({
      org_id:     sponsor.org_id,
      sponsor_id: sponsor.id,
      booking_id: bookingId,
    })

    if (error) {
      // Redemption logging is best-effort — never fail the guest UX over it —
      // but it must not be SILENT either: without the code/message here, a
      // sustained failure on this table is indistinguishable from "no guest
      // redeemed anything" in the sponsor's reporting.
      console.error(`[guidebook-redeem] insert failed (non-fatal): ${error.code} ${error.message}`)
      reportError(new Error(error.message), { site: 'route.guidebook.redeem.insert' })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    // Same reasoning: the guest still gets their offer, but the failure is
    // reported rather than dissolved into a bare success response.
    console.error('[guidebook-redeem] unexpected error:', err)
    reportError(err, { site: 'route.guidebook.redeem.POST' })
    return NextResponse.json({ ok: true })
  }
}
