import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/vendor-connect/[token]/return
 *
 * Stripe redirects vendors here after completing (or partially completing)
 * Connect onboarding. Stripe does not guarantee that onboarding is complete
 * on this redirect — charges_enabled is set asynchronously via webhook.
 *
 * Render a branded holding page. The `account.updated` webhook will fire
 * when Stripe has verified everything and charges_enabled becomes true.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token }       = await params
  const alreadyDone     = request.nextUrl.searchParams.get('already_onboarded') === 'true'

  // Redirect to the vendor connect status page (built in CLAUDE_58_1)
  const url = new URL(`/vendor-connect/${token}/status`, process.env.NEXT_PUBLIC_APP_URL)
  if (alreadyDone) url.searchParams.set('already_onboarded', 'true')
  return NextResponse.redirect(url.toString())
}
