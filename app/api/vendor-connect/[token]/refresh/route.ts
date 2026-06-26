import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/vendor-connect/[token]/refresh
 *
 * Stripe redirects vendors here when the account link has expired before
 * they finished onboarding. We generate a fresh link by redirecting back
 * to the onboard route.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  return NextResponse.redirect(
    `${process.env.NEXT_PUBLIC_APP_URL}/api/vendor-connect/${token}/onboard`
  )
}
