import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { guidebookRedeemLimiter } from '@/lib/rate-limit'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    const { success } = await guidebookRedeemLimiter.limit(ip)
    if (!success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const body = await req.json() as { sponsorId?: string; bookingToken?: string | null }
    if (!body.sponsorId || typeof body.sponsorId !== 'string') {
      return NextResponse.json({ error: 'sponsorId is required' }, { status: 400 })
    }

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
      // Table may not exist until the local migration is applied post-reconcile.
      // Redemption logging is best-effort — never fail the guest UX.
      console.error('[guidebook-redeem] insert failed (non-fatal)')
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: true })
  }
}
