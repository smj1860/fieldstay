import { NextResponse, type NextRequest } from 'next/server'
import { demoSecretMatches, isDemoSurfaceEnabled } from '@/lib/demo/config'
import { getDemoOrg } from '@/lib/demo/org'
import { adminFetch } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'

/**
 * Frictionless booth entry: scan a QR code, land in an authenticated demo
 * session. Nobody should watch a password get typed at a trade show.
 *
 * Authorization is demoSecretMatches() (constant-time, fails closed when
 * DEMO_ENTRY_SECRET is unset) — this route mints a session, so the secret
 * check IS the auth gate and must precede everything else.
 *
 * Every response is a 404, never a 401/403: the route should be
 * indistinguishable from a nonexistent path to anyone without the key.
 */

// The magic link is single-use and time-boxed by Supabase; never cache it.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!isDemoSurfaceEnabled()) return notFound()
  if (!demoSecretMatches(req.nextUrl.searchParams.get('key'))) return notFound()

  const demoUserEmail = process.env.DEMO_USER_EMAIL
  if (!demoUserEmail) {
    console.error('[demo enter] DEMO_USER_EMAIL is not set')
    return notFound()
  }

  const org = await getDemoOrg()
  if (!org) {
    console.error('[demo enter] demo org not found — run scripts/seed-demo-org.ts first')
    return NextResponse.json(
      { error: 'Demo org not seeded. Run scripts/seed-demo-org.ts.' },
      { status: 503 },
    )
  }

  // generateLink is a GoTrue admin operation the JS client exposes, but going
  // through adminFetch keeps this on the one sanctioned raw-admin path
  // (CLAUDE.md Critical Security Rule #1) and lets us read the redirect target
  // out of the response without constructing a full service client just to
  // mint a link.
  const res = await adminFetch('/auth/v1/admin/generate_link', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      type:  'magiclink',
      email: demoUserEmail,
      // Land on the dashboard, not the generic post-auth default — the first
      // thing the OwnerRez team sees should be a populated portfolio.
      redirect_to: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
    }),
  })

  if (!res.ok) {
    // Never surface the GoTrue body — it echoes the email address back.
    console.error('[demo enter] generate_link failed', { status: res.status })
    return NextResponse.json({ error: 'Could not create demo session' }, { status: 500 })
  }

  const link = (await res.json()) as { action_link?: string }
  if (!link.action_link) {
    console.error('[demo enter] generate_link returned no action_link')
    return NextResponse.json({ error: 'Could not create demo session' }, { status: 500 })
  }

  // Session minting on a public surface is exactly the class of event the
  // audit log exists for. No PII in metadata — the org id only.
  await logAuditEvent({
    orgId:    org.id,
    action:   'demo.session.minted',
    metadata: { surface: 'demo-enter' },
  })

  return NextResponse.redirect(link.action_link)
}
