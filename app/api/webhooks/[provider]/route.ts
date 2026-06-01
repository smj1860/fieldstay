/**
 * POST /api/webhooks/[provider]
 *
 * Receives provider webhook POSTs authenticated via HTTP Basic Auth.
 * Always returns 200 immediately; processing is offloaded to Inngest.
 */

import { NextRequest, NextResponse }   from 'next/server'
import { getProvider }                 from '@/lib/integrations/registry'
import { createServiceClient }         from '@/lib/supabase/server'
import { inngest }                     from '@/lib/inngest/client'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: providerId } = await params

  const provider = getProvider(providerId)
  if (!provider) return NextResponse.json({ received: true })

  // ── Verify Basic Auth ──────────────────────────────────────────────────────

  const authHeader = request.headers.get('Authorization')
  if (!provider.verifyWebhookAuth(authHeader)) {
    // Return 200 so OwnerRez doesn't retry — we don't want to leak info
    console.error(`[webhook:${providerId}] Auth failed`)
    return NextResponse.json({ received: true })
  }

  // ── Parse body ─────────────────────────────────────────────────────────────

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ received: true })
  }

  let event
  try {
    event = provider.parseWebhookEvent(body)
  } catch {
    return NextResponse.json({ received: true })
  }

  // ── Dispatch to Inngest ────────────────────────────────────────────────────

  const supabase = createServiceClient()

  if (event.event_type === 'application_authorization_revoked') {
    // Find the connection by external_user_id if available
    const externalUserId = String(event.user_id ?? '')
    if (externalUserId) {
      await supabase
        .from('integration_connections')
        .update({ status: 'revoked' })
        .eq('provider_id', providerId)
        .eq('external_user_id', externalUserId)
    }
  } else {
    // Entity-change event — trigger incremental sync for all active connections
    await inngest.send({
      name: 'integration/ownerrez.sync.requested',
      data: {
        provider_id:  providerId,
        event_type:   event.event_type,
        entity_type:  event.entity_type ?? '',
        entity_id:    String(event.entity_id ?? ''),
        triggered_at: new Date().toISOString(),
      },
    })
  }

  return NextResponse.json({ received: true })
}
