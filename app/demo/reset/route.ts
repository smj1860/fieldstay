import { NextResponse, type NextRequest } from 'next/server'
import { demoSecretMatches, isDemoSurfaceEnabled } from '@/lib/demo/config'
import { seedDemoOrg } from '@/lib/demo/seed'
import { logAuditEvent } from '@/lib/audit'

/**
 * One-tap demo reset — bookmark this on a phone and fire it between booth
 * conversations so added bookings and work orders don't accumulate into a
 * confusing state by conversation number six.
 *
 * POST, not GET: this is destructive, and a GET would be fired by every link
 * prefetcher, chat unfurler, and QR scanner preview that touches the URL.
 *
 * Authorization is demoSecretMatches() (constant-time, fails closed when
 * DEMO_ENTRY_SECRET is unset). The seeder itself independently re-verifies
 * is_demo = true against the database before deleting anything, so a
 * compromised secret still cannot reach a real tenant's data.
 */

export const dynamic = 'force-dynamic'
// The wipe+reseed writes several thousand rows; the Vercel default would cut
// it off partway, leaving a half-seeded org.
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!isDemoSurfaceEnabled()) return notFound()
  if (!demoSecretMatches(req.nextUrl.searchParams.get('key'))) return notFound()

  try {
    const { orgId, counts } = await seedDemoOrg({ wipeFirst: true })

    await logAuditEvent({
      orgId,
      action:   'demo.org.reset',
      metadata: { counts },
    })

    return NextResponse.json({ ok: true, counts })
  } catch (err) {
    console.error('[demo reset] failed', err)
    // The seeder's refusal messages ("REFUSING TO WIPE: org ... is_demo =
    // false") are operator-facing and carry no tenant data, but the generic
    // failure path might, so only the message is surfaced and only to a
    // caller who already proved they hold the secret.
    return NextResponse.json(
      { error: 'Reset failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    )
  }
}
