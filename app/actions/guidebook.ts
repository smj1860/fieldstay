'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { requireOrgMember } from '@/lib/auth'
import type { GuidebookSlotType } from '@/types/database'

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
