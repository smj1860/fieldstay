import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { demoSecretMatches, isDemoSurfaceEnabled } from '@/lib/demo/config'
import { RepuGuardSandboxClient } from './repuguard-sandbox-client'

export const metadata: Metadata = {
  title: 'RepuGuard Sandbox — FieldStay',
  // Belt and braces alongside the secret gate: this surface should never be
  // indexed even if the URL leaks.
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

/**
 * Booth sandbox for RepuGuard. Gated on DEMO_ENTRY_SECRET like the rest of
 * /demo/*, and notFound() rather than a 403 so it is indistinguishable from
 * a nonexistent path without the key.
 *
 * No database access and no model call — the page renders canned scenarios
 * from lib/demo/repuguard-sandbox.ts and the reveal happens entirely in the
 * browser, so once this page has loaded the demo survives losing the network.
 */
export default async function RepuGuardSandboxPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ key?: string }> }>) {
  if (!isDemoSurfaceEnabled()) notFound()

  const { key } = await searchParams
  if (!demoSecretMatches(key)) notFound()

  return <RepuGuardSandboxClient />
}
