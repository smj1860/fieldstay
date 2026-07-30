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

  try {
    switch (event.type) {
      case 'account.updated':
        await handleAccountUpdated(supabase, event.data.object)
        break

      default:
        // Unhandled Connect event type — ignore
        break
    }
  } catch (err) {
    // The dedup row for this event was committed BEFORE the handler ran, so
    // without releasing it Stripe's retry (same event.id, at-least-once
    // delivery) hits the 23505 branch above and returns received:true without
    // processing — permanently discarding a real event. Release the claim so
    // the retry gets a genuine second attempt. Same pattern as
    // app/api/webhooks/stripe/route.ts and app/api/webhooks/[provider]/route.ts;
    // this third webhook route was missed when that fix was swept through.
    console.error(`[stripe-connect-webhook] Handler threw for event ${event.id} (${event.type}):`, err)
    reportError(err, {
      site:  'webhook.stripe-connect.handler',
      extra: { stripe_event_id: event.id, event_type: event.type },
    })

    const { error: releaseErr } = await supabase
      .from('stripe_processed_events')
      .delete()
      .eq('stripe_event_id', dedupKey)

    if (releaseErr) {
      console.error(`[stripe-connect-webhook] Failed to release dedup claim for ${event.id}:`, releaseErr.message)
      reportError(new Error(releaseErr.message), {
        site:  'webhook.stripe-connect.dedup_release',
        extra: { stripe_event_id: event.id },
      })
    }

    // Let Stripe see the failure and retry per its own schedule.
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}

type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * Throws on a failed write. That is deliberate: both vendors UPDATEs used to
 * discard their error, so a failure left the vendor with a stale
 * stripe_connect_charges_enabled — either an onboarded vendor who can never
 * be paid, or a vendor whose charges Stripe revoked but who still looks
 * payable. Throwing routes it into the caller's release-the-claim + 500
 * path so Stripe retries instead of the state silently diverging.
 */
async function handleAccountUpdated(
  supabase: ServiceClient,
  account:  { id: string; charges_enabled: boolean },
): Promise<void> {
  const chargesEnabled = account.charges_enabled

  // Find the vendor by their Connect account ID
  const { data: vendor } = await supabase
    .from('vendors')
    .select('id, org_id, stripe_connect_charges_enabled')
    .eq('stripe_connect_account_id', account.id)
    .single()

  // Could be a Connect account created outside FieldStay — ignore
  if (!vendor) return

  if (chargesEnabled && !vendor.stripe_connect_charges_enabled) {
    // First time charges_enabled — update, rotate, audit.
    //
    // M-5: rotating stripe_connect_token here retires the onboarding link
    // that was emailed to the vendor (and may have been forwarded onward) the
    // moment it has served its purpose. The BEFORE UPDATE trigger added by
    // 20260730500000_vendor_stripe_connect_token_expiry.sql nulls
    // stripe_connect_token_expires_at on any token change, so the fresh token
    // is inert until a new invite is actually sent with it.
    const { error: onboardedErr } = await supabase
      .from('vendors')
      .update({
        stripe_connect_charges_enabled: true,
        stripe_connect_onboarded_at:    new Date().toISOString(),
        stripe_connect_token:           crypto.randomUUID(),
      })
      .eq('id', vendor.id)
      .eq('org_id', vendor.org_id)

    if (onboardedErr) {
      throw new Error(`vendors update (charges_enabled=true) failed: ${onboardedErr.message}`)
    }

    await logAuditEvent({
      orgId:      vendor.org_id,
      action:     'vendor.stripe_connect.onboarded',
      targetType: 'vendor',
      targetId:   vendor.id,
      // No Stripe account ID or PII in metadata
      metadata:   { charges_enabled: true, token_rotated: true },
    })
    return
  }

  if (!chargesEnabled && vendor.stripe_connect_charges_enabled) {
    // Stripe revoked charges — mark as not enabled (rare but possible)
    const { error: disabledErr } = await supabase
      .from('vendors')
      .update({ stripe_connect_charges_enabled: false })
      .eq('id', vendor.id)
      .eq('org_id', vendor.org_id)

    if (disabledErr) {
      throw new Error(`vendors update (charges_enabled=false) failed: ${disabledErr.message}`)
    }

    await logAuditEvent({
      orgId:      vendor.org_id,
      action:     'vendor.stripe_connect.charges_disabled',
      targetType: 'vendor',
      targetId:   vendor.id,
      metadata:   { charges_enabled: false },
    })
  }
}
