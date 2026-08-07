import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { guidebookRedeemLimiter, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import { reportError } from '@/lib/observability/report-error'
import { unwrap } from '@/lib/supabase/unwrap'
import { isUuid } from '@/lib/validation/uuid'

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

  // Shape-checked before it reaches a `uuid` column, not just type-checked.
  // `guidebook_sponsors.id` is a uuid, so a non-UUID string is Postgres 22P02
  // — which unwrap() below turns into a throw, and the catch turns into
  // `{ok:true}` PLUS a Sentry report. On a public, unauthenticated endpoint
  // that is a free way for anyone to burn the Sentry quota and bury this
  // route's real database failures in noise; the limiter bounds it only while
  // Redis is up, and this one deliberately fails OPEN. A malformed id is a bad
  // request, so say so.
  if (!isUuid(body?.sponsorId)) {
    return NextResponse.json({ error: 'sponsorId is required' }, { status: 400 })
  }

  try {
    const supabase = createServiceClient({ publicSurface: 'api-guidebook-redeem' })

    const sponsorRes = await supabase
      .from('guidebook_sponsors')
      .select('id, org_id, status')
      .eq('id', body.sponsorId)
      .maybeSingle()
    const sponsor = unwrap(sponsorRes, { site: 'route.guidebook.redeem.sponsor' })

    if (!sponsor || sponsor.status !== 'active') {
      // Don't disclose sponsor existence on a public surface
      return NextResponse.json({ ok: true })
    }

    let bookingId: string | null = null
    // isUuid, not just a truthy string check — and note this one SKIPS rather
    // than 400s. `bookings.guidebook_token` is also a uuid, so a malformed
    // token threw 22P02 out of unwrap(), escaped the try entirely, and landed
    // in the outer catch: the guest got `{ok:true}` and the redemption insert
    // below never ran at all. The stated intent two lines down is to fall back
    // to an ANONYMOUS redemption when the booking can't be attributed, so
    // that is what an unusable token should do — degrade attribution, not
    // discard the redemption.
    if (isUuid(body.bookingToken)) {
      const bookingRes = await supabase
        .from('bookings')
        .select('id, org_id')
        .eq('guidebook_token', body.bookingToken)
        .maybeSingle()
      const booking = unwrap(bookingRes, { site: 'route.guidebook.redeem.booking', orgId: sponsor.org_id })
      // Tenant isolation: only attach the booking if it belongs to the
      // sponsor's org — otherwise log anonymously.
      if (booking && booking.org_id === sponsor.org_id) bookingId = booking.id
    }

    // Insert-or-increment, as ONE statement (migration 20260807170000).
    //
    // The row is written when the guest opens the redemption pass — the coupon
    // they show at the counter — and opening it more than once is the NORMAL
    // case: look at the offer from the couch, close it, walk over, open it
    // again for staff. That gives two genuinely different numbers, and the
    // sponsor wants both: COUNT(*) is redemptions (deduped per booking per day
    // by uniq_guidebook_offer_redemptions_sponsor_booking_day), SUM(open_count)
    // is engagement.
    //
    // Per day, not per stay: a daily perk is legitimately redeemable on each
    // day of a booking, so collapsing the whole stay would under-count.
    //
    // An RPC rather than the JS client, for two reasons. The arbiter is a
    // PARTIAL EXPRESSION index (on the UTC date of opened_at) and PostgREST's
    // on_conflict takes only plain column names, so this upsert is not
    // expressible through the client at all. And read-then-write here would be
    // a TOCTOU — two taps racing would both read 1 and both write 2.
    //
    // Anonymous redemptions (bookingId null, from the property-level
    // /g/[slug] guidebook) fall outside the partial index by design — with no
    // guest identity there is nothing to dedupe on, and collapsing them by
    // (sponsor, day) would merge different guests into one. Each is its own
    // row at open_count = 1, so both aggregates still read correctly.
    // p_booking_id is OMITTED rather than passed as null for the anonymous
    // case — the function declares `DEFAULT NULL` precisely so this is
    // expressible. Supabase's type generator has no notion of a nullable
    // argument, so without the default the only ways to call this with a null
    // would be a cast or a second write path.
    const { error } = await supabase.rpc('record_guidebook_offer_open', {
      p_org_id:     sponsor.org_id,
      p_sponsor_id: sponsor.id,
      ...(bookingId ? { p_booking_id: bookingId } : {}),
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
