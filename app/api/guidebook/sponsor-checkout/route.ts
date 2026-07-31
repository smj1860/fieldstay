import { NextRequest, NextResponse } from 'next/server'
import { createSponsorCheckoutSession } from '@/app/actions/guidebook'
import { guidebookSponsorCheckoutLimiter, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import { reportError } from '@/lib/observability/report-error'

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Throttle BEFORE the token is read, so a guessing attack is capped by the
  // limiter rather than by token entropy alone (CLAUDE.md audit checklist →
  // "Rate limiting on unauthenticated/token-guessable routes"). Sponsors are
  // never logged in, so this route is reachable via proxy.ts's
  // '/api/guidebook' TOKEN_ROUTES entry, which also applies the broader
  // per-IP guidebookRatelimit; this tighter inline limiter exists because
  // each call creates a real Stripe Checkout Session.
  //
  // Abuse limiter → fails OPEN. Deliberately kept outside the try/catch below
  // so a limiter fault can never be misread as a 500: previously the outer try
  // swallowed it into an "Internal server error" response, i.e. a Redis
  // outage silently fail-CLOSED this route by accident.
  const decision = await checkLimit(guidebookSponsorCheckoutLimiter, extractClientIp(req) ?? 'unknown', {
    onError: 'allow',
    site:    'route.guidebook.sponsor-checkout.POST',
  })
  if (!decision.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429 }
    )
  }

  try {
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
