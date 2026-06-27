'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'

/**
 * Creates a Stripe Checkout Session for a sponsor slot.
 * The media kit page is unauthenticated (no PM session), so this is
 * invoked via /api/guidebook/sponsor-checkout rather than called
 * directly as a Server Action from a client component.
 */
export async function createSponsorCheckoutSession(
  mediaKitToken: string
): Promise<{ url: string } | { error: string }> {
  const supabase = createServiceClient()

  const { data: sponsor } = await supabase
    .from('guidebook_sponsors')
    .select('id, org_id, business_name, slot_type, status')
    .eq('media_kit_token', mediaKitToken)
    .single()

  if (!sponsor)                    return { error: 'Invalid media kit link.' }
  if (sponsor.status === 'active') return { error: 'This sponsorship slot is already active.' }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        { price: process.env.STRIPE_PRICE_SPONSOR_MONTHLY!, quantity: 1 },
      ],
      metadata: {
        guidebook_sponsor_id: sponsor.id,
        org_id:               sponsor.org_id,
        feature:              'guidebook_sponsor',
      },
      subscription_data: {
        metadata: {
          guidebook_sponsor_id: sponsor.id,
          org_id:               sponsor.org_id,
          feature:              'guidebook_sponsor',
        },
      },
      success_url: `${appUrl}/g/kit/${mediaKitToken}?success=true`,
      cancel_url:  `${appUrl}/g/kit/${mediaKitToken}?cancelled=true`,
    })

    if (!session.url) return { error: 'Stripe did not return a checkout URL.' }

    await supabase
      .from('guidebook_sponsors')
      .update({
        checkout_session_id: session.id,
        updated_at:          new Date().toISOString(),
      })
      .eq('id', sponsor.id)
      .eq('org_id', sponsor.org_id) // explicit tenant guard

    return { url: session.url }
  } catch (err) {
    console.error('[createSponsorCheckoutSession]', err)
    return { error: err instanceof Error ? err.message : 'Unknown Stripe error' }
  }
}
