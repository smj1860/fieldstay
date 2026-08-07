import { NextRequest, NextResponse } from 'next/server'
import { createSponsorCheckoutSession } from '@/app/actions/guidebook'
import { guidebookSponsorCheckoutLimiter, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import { reportError } from '@/lib/observability/report-error'
import { isUuid } from '@/lib/validation/uuid'

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

    // Shape-checked, not just type-checked. guidebook_sponsors.media_kit_token
    // is a `uuid`, so a malformed token reaches `.eq()` as Postgres 22P02,
    // throws out of the action's unwrap(), and lands in its catch — which
    // reports to Sentry and tells the sponsor "Unable to start checkout.
    // Please try again." for a link that will never work no matter how many
    // times they try. On a public unauthenticated endpoint that is also a free
    // way to burn the Sentry quota. An unusable token is an invalid link, and
    // gets the same message a nonexistent one does.
    if (!isUuid(body.mediaKitToken)) {
      return NextResponse.json(
        { error: 'Invalid media kit link.' },
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
