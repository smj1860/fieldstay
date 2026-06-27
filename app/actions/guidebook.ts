'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { normalizePhoneToE164 } from '@/lib/sms/telnyx'
import type { GuidebookSlotType, GuidebookOfferType } from '@/types/database'

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

export interface UpsertSponsorInput {
  slotNumber:          number
  businessName:        string
  businessDescription: string | null
  businessPhone:       string | null
  businessWebsite:     string | null
  customOfferText:     string | null
  offerType:           GuidebookOfferType
  offerValue:          number | null
  offerItem:           string | null
  featuredItem:        string | null
  address:             string | null
  lat:                 number | null
  lng:                 number | null
  slotType:            GuidebookSlotType
  slotContext:         string | null
}

/**
 * Creates or updates a sponsor slot for the authenticated PM's org.
 * Returns the media_kit_token so the PM can immediately access their media kit.
 */
export async function upsertSponsor(
  input: UpsertSponsorInput
): Promise<{ mediaKitToken: string } | { error: string }> {
  const { membership } = await requireOrgMember()
  const supabase        = createServiceClient()

  if (input.slotNumber < 1 || input.slotNumber > 6) {
    return { error: 'Slot number must be between 1 and 6.' }
  }

  const { data, error } = await supabase
    .from('guidebook_sponsors')
    .upsert(
      {
        org_id:               membership.org_id,
        slot_number:          input.slotNumber,
        business_name:        input.businessName,
        business_description: input.businessDescription,
        business_phone:       input.businessPhone,
        business_website:     input.businessWebsite,
        custom_offer_text:    input.customOfferText,
        offer_type:           input.offerType,
        offer_value:          input.offerValue,
        offer_item:           input.offerItem,
        featured_item:        input.featuredItem,
        address:              input.address,
        lat:                  input.lat,
        lng:                  input.lng,
        slot_type:            input.slotType,
        slot_context:         input.slotContext,
        updated_at:           new Date().toISOString(),
      },
      { onConflict: 'org_id,slot_number' }
    )
    .select('media_kit_token')
    .single()

  if (error) return { error: error.message }
  return { mediaKitToken: data.media_kit_token }
}

export interface UpsertPropertyGuidebookConfigInput {
  propertyId:           string
  slug:                 string
  checkInInstructions:  string | null
  checkOutInstructions: string | null
  wifiNetwork:          string | null
  wifiPassword:         string | null
  houseRules:           string | null
  isPublished:          boolean
}

/**
 * Saves per-property guidebook content (slug, wifi, check-in instructions).
 */
export async function upsertPropertyGuidebookConfig(
  input: UpsertPropertyGuidebookConfigInput
): Promise<{ error?: string }> {
  const { membership } = await requireOrgMember()
  const supabase        = createServiceClient()

  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', input.propertyId)
    .eq('org_id', membership.org_id)
    .single()

  if (!property) return { error: 'Property not found.' }

  const { error } = await supabase
    .from('guidebook_property_configs')
    .upsert(
      {
        org_id:                 membership.org_id,
        property_id:            input.propertyId,
        slug:                   input.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        check_in_instructions:  input.checkInInstructions,
        check_out_instructions: input.checkOutInstructions,
        wifi_network:           input.wifiNetwork,
        wifi_password:          input.wifiPassword,
        house_rules:            input.houseRules,
        is_published:           input.isPublished,
        updated_at:             new Date().toISOString(),
      },
      { onConflict: 'org_id,property_id' }
    )

  if (error) return { error: error.message }
  return {}
}

/**
 * Guest-facing SMS opt-in. Unauthenticated (no PM session) — org_id is
 * always derived server-side from the booking's guidebook_token, never
 * accepted from the client.
 */
export async function optInGuestSms(
  guidebookToken: string,
  rawPhone:       string
): Promise<{ success: true } | { error: string }> {
  const phoneE164 = normalizePhoneToE164(rawPhone)
  if (!phoneE164) return { error: 'Please enter a valid US phone number.' }

  const supabase = createServiceClient()

  const { data: booking } = await supabase
    .from('bookings')
    .select('id, org_id, property_id')
    .eq('guidebook_token', guidebookToken)
    .maybeSingle()

  if (!booking) return { error: 'Invalid guidebook link.' }

  const { data: optin, error } = await supabase
    .from('guidebook_guest_sms_optins')
    .upsert(
      {
        org_id:      booking.org_id,
        property_id: booking.property_id,
        booking_id:  booking.id,
        phone_e164:  phoneE164,
        is_active:   true,
        opted_out_at: null,
        updated_at:  new Date().toISOString(),
      },
      { onConflict: 'booking_id' }
    )
    .select('id')
    .single()

  if (error) return { error: error.message }

  await inngest.send({
    name: 'guidebook/guest.opted.in',
    data: {
      optinId:    optin.id,
      bookingId:  booking.id,
      orgId:      booking.org_id,
      propertyId: booking.property_id,
      phoneE164,
    },
  })

  return { success: true }
}
