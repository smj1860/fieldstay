import { NextRequest, NextResponse } from 'next/server'
import { createSponsorCheckoutSession } from '@/app/actions/guidebook'
import { guidebookSponsorCheckoutLimiter } from '@/lib/rate-limit'
import { reportError } from '@/lib/observability/report-error'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Throttle BEFORE the token is read, so a guessing attack is capped by the
    // limiter rather than by token entropy alone (CLAUDE.md audit checklist →
    // "Rate limiting on unauthenticated/token-guessable routes"). This route
    // sits under /api/guidebook/, which proxy.ts's TOKEN_ROUTES does not cover
    // — only /g/ is listed — so the limiter has to be inline, exactly as the
    // sibling /api/guidebook/redeem route does it.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    const { success } = await guidebookSponsorCheckoutLimiter.limit(ip)
    if (!success) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429 }
      )
    }

    const body = await req.json() as { mediaKitToken?: string }

    if (!body.mediaKitToken || typeof body.mediaKitToken !== 'string') {
      return NextResponse.json(
        { error: 'mediaKitToken is required' },
        { status: 400 }
      )
    }

    const result = await createSponsorCheckoutSession(body.mediaKitToken)

    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json({ url: result.url })
  } catch (err) {
    console.error('[sponsor-checkout] unexpected error:', err)
    reportError(err, { site: 'route.guidebook.sponsor-checkout.POST' })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
