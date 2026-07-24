import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient }       from '@/lib/supabase/server'
import { stripe }                    from '@/lib/stripe/client'
import { vendorConnectRatelimit }    from '@/lib/rate-limit'
import { extractClientIp }           from '@/lib/integrations/webhook-verification'
import { logAuditEvent }             from '@/lib/audit'

/**
 * GET /api/vendor-connect/[token]/onboard
 *
 * Public endpoint. Generates a fresh Stripe Connect account link for the
 * vendor identified by their stripe_connect_token and redirects to it.
 *
 * If the vendor does not yet have a Connect account, creates one first.
 * Account links expire quickly — always generate fresh on each visit.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  if (!token || token.length < 10) {
    return NextResponse.json({ error: 'Invalid link' }, { status: 400 })
  }

  // Public, unauthenticated route that does two real Stripe API calls per
  // hit (account creation + account link) — rate limit by IP, not the
  // token, so a leaked/enumerated link can't drive unbounded Stripe cost.
  // Fail open on a Redis outage — a degraded rate limiter must never block
  // a vendor's legitimate onboarding.
  try {
    const ip = extractClientIp(request) ?? 'unknown'
    const { success } = await vendorConnectRatelimit.limit(`vendor-connect-onboard:${ip}`)
    if (!success) {
      return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
    }
  } catch (rlErr) {
    console.error('[vendor-connect/onboard] rate limit check failed', rlErr)
  }

  const supabase = createServiceClient({ publicSurface: 'api-vendor-connect--token--onboard' })

  const { data: vendor } = await supabase
    .from('vendors')
    .select('id, org_id, email, name, stripe_connect_account_id, stripe_connect_charges_enabled')
    .eq('stripe_connect_token', token)
    .eq('is_active', true)
    .single()

  if (!vendor) {
    return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
  }

  // Already fully onboarded — show confirmation page
  if (vendor.stripe_connect_charges_enabled) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/api/vendor-connect/${token}/return?already_onboarded=true`
    )
  }

  try {
    // ── Atomic claim: set sentinel before calling Stripe ──────────────────────
    // Prevents two concurrent tab opens from creating two Connect accounts.
    // Only the request that wins the UPDATE proceeds to create the account.
    // 'pending' is not a real Stripe account ID — it acts as a mutex.
    if (!vendor.stripe_connect_account_id) {
      const { data: claimed } = await supabase
        .from('vendors')
        .update({ stripe_connect_account_id: 'pending' })
        .eq('stripe_connect_token', token)
        .is('stripe_connect_account_id', null)   // only updates if still null
        .select('id')
        .single()

      if (!claimed) {
        // Another request already claimed it — redirect to status page
        // The other request will finish creating the real account
        return NextResponse.redirect(
          `${process.env.NEXT_PUBLIC_APP_URL}/vendor-connect/${token}/status`
        )
      }
    }

    let accountId = vendor.stripe_connect_account_id

    // Create account if it doesn't exist yet (e.g. vendor received WO before cron ran)
    if (!accountId || accountId === 'pending') {
      const account = await stripe.accounts.create({
        type:  'express',
        ...(vendor.email ? { email: vendor.email } : {}),
        metadata: {
          vendor_id: vendor.id,
          org_id:    vendor.org_id,
        },
        capabilities: {
          card_payments: { requested: true },
          transfers:     { requested: true },
        },
      })

      accountId = account.id

      await supabase
        .from('vendors')
        .update({
          stripe_connect_account_id:    accountId,
          stripe_connect_invite_sent_at: new Date().toISOString(),
        })
        .eq('id', vendor.id)
        .eq('org_id', vendor.org_id)

      await logAuditEvent({
        orgId:      vendor.org_id,
        action:     'vendor.stripe_connect.account_created',
        targetType: 'vendor',
        targetId:   vendor.id,
        // No actorId — unauthenticated vendor-token route
      })
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL!

    // Account links expire in minutes — always create fresh
    const accountLink = await stripe.accountLinks.create({
      account:     accountId,
      refresh_url: `${baseUrl}/api/vendor-connect/${token}/refresh`,
      return_url:  `${baseUrl}/api/vendor-connect/${token}/return`,
      type:        'account_onboarding',
    })

    return NextResponse.redirect(accountLink.url)
  } catch (err) {
    // If Stripe create failed after we set the sentinel, clear it so the
    // vendor can try again rather than being permanently stuck on 'pending'.
    if (vendor.stripe_connect_account_id === null) {
      void supabase
        .from('vendors')
        .update({ stripe_connect_account_id: null })
        .eq('stripe_connect_token', token)
        .eq('stripe_connect_account_id', 'pending')
    }
    console.error('[vendor-connect/onboard] Stripe error:', err)
    return NextResponse.json(
      { error: 'Could not generate onboarding link. Please try again.' },
      { status: 500 }
    )
  }
}
