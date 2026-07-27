import { NextRequest, NextResponse } from 'next/server'
import { createSponsorCheckoutSession } from '@/app/actions/guidebook'

import { reportError } from '@/lib/observability/report-error'
export async function POST(req: NextRequest): Promise<NextResponse> {
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
