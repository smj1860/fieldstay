import { stripe }              from '@/lib/stripe/client'
import { resend, FROM }        from '@/lib/resend/client'
import { createServiceClient } from '@/lib/supabase/server'
import { renderVendorConnectInviteEmail } from '@/lib/resend/emails/vendor-connect-invite'

export interface EnsureVendorConnectInvitedParams {
  vendorId:           string
  orgId:              string
  vendorEmail:        string
  vendorName:         string | null
  vendorConnectToken: string
  orgName:            string
  pmName?:            string | null
  woNumber?:          string | null
}

/**
 * Creates a Stripe Express account and sends the Connect onboarding invite
 * email for a vendor who doesn't have one yet. Shared by the nightly
 * vendor-connect-onboarding cron and the work-order-dispatch handler
 * (CLAUDE_62_0) — both onboarding triggers need identical account-creation
 * and invite-email logic, just fired on different events.
 *
 * Always re-reads the vendor row fresh before acting — the caller's own
 * copy may be stale by the time this runs (e.g. the cron re-fetches
 * per-vendor for the same reason), and this is the only reliable guard
 * against sending two invites / creating two Connect accounts for one
 * vendor when the cron and a dispatch fire close together.
 */
export async function ensureVendorConnectInvited(
  params: EnsureVendorConnectInvitedParams
): Promise<{ invited: boolean }> {
  const supabase = createServiceClient()

  const { data: fresh } = await supabase
    .from('vendors')
    .select('id, stripe_connect_account_id, stripe_connect_invite_sent_at')
    .eq('id', params.vendorId)
    .eq('org_id', params.orgId)
    .single()

  // stripe_connect_invite_sent_at is the only true "done" signal.
  // stripe_connect_account_id can be set WITHOUT it if a prior call created
  // the Stripe account but failed before the email send below completed —
  // in that case we reuse the existing account rather than creating (and
  // orphaning) a second one.
  if (!fresh || fresh.stripe_connect_invite_sent_at) {
    return { invited: false }
  }

  let accountId = fresh.stripe_connect_account_id

  if (!accountId) {
    const account = await stripe.accounts.create({
      type:  'express',
      email: params.vendorEmail,
      metadata: {
        vendor_id: params.vendorId,
        org_id:    params.orgId,
      },
      capabilities: {
        card_payments: { requested: true },
        transfers:     { requested: true },
      },
    })
    accountId = account.id

    // Persisted immediately — independent of whether the email send below
    // succeeds — so a retry after a Resend failure reuses this account
    // instead of creating a second, untracked one.
    await supabase
      .from('vendors')
      .update({ stripe_connect_account_id: accountId })
      .eq('id', params.vendorId)
      .eq('org_id', params.orgId)
  }

  const onboardingUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/vendor-connect/${params.vendorConnectToken}/onboard`

  await resend.emails.send({
    from:    FROM,
    to:      params.vendorEmail,
    subject: `${params.orgName} pays invoices via Stripe Connect — set up your payout account`,
    html:    await renderVendorConnectInviteEmail({
      vendorName:    params.vendorName,
      orgName:       params.orgName,
      pmName:        params.pmName ?? null,
      woNumber:      params.woNumber ?? null,
      onboardingUrl,
    }),
  })

  await supabase
    .from('vendors')
    .update({ stripe_connect_invite_sent_at: new Date().toISOString() })
    .eq('id', params.vendorId)
    .eq('org_id', params.orgId)

  return { invited: true }
}

export interface ResendVendorConnectInviteParams {
  vendorId:                string
  orgId:                   string
  vendorEmail:             string
  vendorName:              string | null
  vendorConnectToken:      string
  existingStripeAccountId: string | null
  orgName:                 string
}

/**
 * PM-initiated resend from the vendor detail page — unlike
 * ensureVendorConnectInvited(), this intentionally ignores the
 * stripe_connect_invite_sent_at guard so a lost or ignored invite can be
 * re-sent on demand. Reuses the vendor's existing Stripe Express account
 * if one was already created rather than creating a second one.
 */
export async function resendVendorConnectInvite(
  params: ResendVendorConnectInviteParams
): Promise<void> {
  const supabase = createServiceClient()

  let accountId = params.existingStripeAccountId

  if (!accountId) {
    const account = await stripe.accounts.create({
      type:  'express',
      email: params.vendorEmail,
      metadata: {
        vendor_id: params.vendorId,
        org_id:    params.orgId,
      },
      capabilities: {
        card_payments: { requested: true },
        transfers:     { requested: true },
      },
    })
    accountId = account.id
  }

  const onboardingUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/vendor-connect/${params.vendorConnectToken}/onboard`

  await resend.emails.send({
    from:    FROM,
    to:      params.vendorEmail,
    subject: `Reminder: set up your Stripe payout account for ${params.orgName}`,
    html:    await renderVendorConnectInviteEmail({
      vendorName: params.vendorName,
      orgName:    params.orgName,
      pmName:     null,
      woNumber:   null,
      onboardingUrl,
    }),
  })

  await supabase
    .from('vendors')
    .update({
      stripe_connect_account_id:     accountId,
      stripe_connect_invite_sent_at: new Date().toISOString(),
    })
    .eq('id', params.vendorId)
    .eq('org_id', params.orgId)
}
