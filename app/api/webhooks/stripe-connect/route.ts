import { NextRequest, NextResponse }  from 'next/server'
import { stripe }                     from '@/lib/stripe/client'
import { createServiceClient }        from '@/lib/supabase/server'
import { logAuditEvent }              from '@/lib/audit'
import { reportError }                from '@/lib/observability/report-error'

/**
 * POST /api/webhooks/stripe-connect
 *
 * Handles Connect account lifecycle events from Stripe.
 * Configured separately from the platform webhook in the Stripe Dashboard:
 *   Dashboard → Connect → Webhooks → Add endpoint
 *   Events to listen for: account.updated
 *
 * Uses STRIPE_CONNECT_WEBHOOK_SECRET (different from STRIPE_WEBHOOK_SECRET).
 */
export async function POST(request: NextRequest) {
  const body      = await request.text()
  const signature = request.headers.get('stripe-signature')

  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  let event
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET!
    )
  } catch (err) {
    console.error('[stripe-connect-webhook] signature verification failed:', err)
    reportError(err, { site: 'webhook.stripe-connect.signature_verification' })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const supabase = createServiceClient({ publicSurface: 'api-webhooks-stripe-connect' })

  // Dedup — reuse the same stripe_processed_events table
  const dedupKey = `connect:${event.id}`
  const { error: dedupErr } = await supabase
    .from('stripe_processed_events')
    .insert({ stripe_event_id: dedupKey })

  if (dedupErr) {
    if (dedupErr.code === '23505') {
      return NextResponse.json({ received: true })
    }
    console.error('[stripe-connect-webhook] dedup insert failed (non-fatal):', dedupErr.message)
    reportError(new Error(dedupErr.message), { site: 'webhook.stripe-connect.dedup_insert', extra: { stripe_event_id: event.id } })
  }

  switch (event.type) {

    case 'account.updated': {
      const account     = event.data.object
      const accountId   = account.id
      const chargesEnabled = account.charges_enabled

      // Find the vendor by their Connect account ID
      const { data: vendor } = await supabase
        .from('vendors')
        .select('id, org_id, stripe_connect_charges_enabled')
        .eq('stripe_connect_account_id', accountId)
        .single()

      if (!vendor) {
        // Could be a Connect account created outside FieldStay — ignore
        break
      }

      if (chargesEnabled && !vendor.stripe_connect_charges_enabled) {
        // First time charges_enabled — update and audit
        await supabase
          .from('vendors')
          .update({
            stripe_connect_charges_enabled: true,
            stripe_connect_onboarded_at:    new Date().toISOString(),
          })
          .eq('id', vendor.id)
          .eq('org_id', vendor.org_id)

        await logAuditEvent({
          orgId:      vendor.org_id,
          action:     'vendor.stripe_connect.onboarded',
          targetType: 'vendor',
          targetId:   vendor.id,
          // No Stripe account ID or PII in metadata
          metadata:   { charges_enabled: true },
        })
      } else if (!chargesEnabled && vendor.stripe_connect_charges_enabled) {
        // Stripe revoked charges — mark as not enabled (rare but possible)
        await supabase
          .from('vendors')
          .update({ stripe_connect_charges_enabled: false })
          .eq('id', vendor.id)
          .eq('org_id', vendor.org_id)

        await logAuditEvent({
          orgId:      vendor.org_id,
          action:     'vendor.stripe_connect.charges_disabled',
          targetType: 'vendor',
          targetId:   vendor.id,
          metadata:   { charges_enabled: false },
        })
      }
      break
    }

    default:
      // Unhandled Connect event type — ignore
      break
  }

  return NextResponse.json({ received: true })
}
