'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { unwrap } from '@/lib/supabase/unwrap'
import { stripe } from '@/lib/stripe/client'
import { requireOrgRole } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { normalizePhoneToE164 } from '@/lib/sms/telnyx'
import { logAuditEvent } from '@/lib/audit'
import { MAX_FEATURED_AMENITIES } from '@/lib/guidebook/featured-amenities'
import type { GuidebookSlotType, GuidebookOfferType } from '@/types/database'
import { z } from 'zod'

import { reportError } from '@/lib/observability/report-error'
/**
 * Creates a Stripe Checkout Session for a sponsor slot.
 * The media kit page is unauthenticated (no PM session), so this is
 * invoked via /api/guidebook/sponsor-checkout rather than called
 * directly as a Server Action from a client component.
 */
/**
 * Sponsor states that still carry a LIVE Stripe subscription, so starting a
 * fresh checkout would create a second one billing the same business.
 *
 * `payment_failed` is the non-obvious member. It is set from
 * `invoice.payment_failed`, which does NOT end the subscription — Stripe keeps
 * it in dunning, and guidebook-sponsor-payment-recovered flips the row
 * straight back to 'active' when a retry succeeds. A sponsor who sees the
 * failure notice and re-opens their media-kit link was therefore able to buy a
 * SECOND subscription while the first was still being retried.
 *
 * 'cancelled' is deliberately absent: that subscription is gone, and buying
 * again is the whole point of keeping the media kit link alive.
 */
const SPONSOR_STATUSES_WITH_LIVE_SUBSCRIPTION = ['active', 'payment_failed'] as const

/**
 * Returns the URL of an already-created Checkout Session if it is still
 * payable, so a repeat click reuses it instead of minting another.
 *
 * Same helper the work-order invoice route has had all along
 * (app/api/invoices/[invoiceId]/checkout/route.ts, "Store the session ID for
 * potential reuse on duplicate clicks"). The sponsor path WROTE
 * checkout_session_id for exactly this purpose and then never read it back
 * from anywhere in the codebase — so every click, reload, or retry minted a
 * new session, each payable for 24 hours. Two of them paid means two
 * subscriptions, two checkout.session.completed webhooks with distinct event
 * ids (so the dedup table does not collapse them), and an activation handler
 * that overwrites stripe_subscription_id with whichever lands last — leaving
 * the other subscription billing monthly with nothing in FieldStay able to
 * cancel it.
 */
async function openSessionUrl(sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null
  try {
    const existing = await stripe.checkout.sessions.retrieve(sessionId)
    return existing.status === 'open' ? existing.url : null
  } catch {
    // Expired or not found — the caller mints a new one.
    return null
  }
}

export async function createSponsorCheckoutSession(
  mediaKitToken: string
): Promise<{ url: string } | { error: string }> {
  try {
    const supabase = createServiceClient({ publicSurface: 'guidebook-sponsor-media-kit' })

    // maybeSingle + unwrap, not `{ data }` off .single(): discarding the error
    // made an outage or an RLS regression indistinguishable from a bad token,
    // so a sponsor holding a perfectly valid link was told it was invalid.
    // Identical to the defect already fixed in optInGuestSms below — same
    // file, one function over.
    const sponsorRes = await supabase
      .from('guidebook_sponsors')
      .select('id, org_id, business_name, slot_type, status, checkout_session_id')
      .eq('media_kit_token', mediaKitToken)
      .maybeSingle()

    const sponsor = unwrap(sponsorRes, {
      site: 'serverAction.guidebook.createSponsorCheckoutSession.sponsor',
    })

    if (!sponsor) return { error: 'Invalid media kit link.' }

    if ((SPONSOR_STATUSES_WITH_LIVE_SUBSCRIPTION as readonly string[]).includes(sponsor.status)) {
      return { error: 'This sponsorship slot is already active.' }
    }

    const reusable = await openSessionUrl(sponsor.checkout_session_id)
    if (reusable) return { url: reusable }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'

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

    // Compare-and-swap on the value we read, not a blind overwrite. The reuse
    // check above closes the repeat-click case; this closes the concurrent one
    // — two requests that both saw no reusable session and both created one.
    // Whichever swap matches the value it read owns the slot; the loser expires
    // its own session and hands back the winner's, so only ONE payable session
    // for this sponsor exists at a time. A plain `if (already active)` before
    // the write is exactly the TOCTOU the audit checklist calls out: the
    // precondition has to be in the WHERE clause.
    const priorSessionId = sponsor.checkout_session_id
    const claim = supabase
      .from('guidebook_sponsors')
      .update({
        checkout_session_id: session.id,
        updated_at:          new Date().toISOString(),
      })
      .eq('id', sponsor.id)
      .eq('org_id', sponsor.org_id) // explicit tenant guard

    const claimRes = await (
      priorSessionId
        ? claim.eq('checkout_session_id', priorSessionId)
        : claim.is('checkout_session_id', null)
    )
      .select('id')
      .maybeSingle()

    const claimed = unwrap(claimRes, {
      site:  'serverAction.guidebook.createSponsorCheckoutSession.claim',
      orgId: sponsor.org_id,
    })

    if (!claimed) {
      // Lost the swap: a concurrent request stored its session after we read.
      // Expire ours so it can never be paid, and return theirs.
      await stripe.checkout.sessions.expire(session.id).catch((err: unknown) => {
        // Non-fatal, but it must not be silent — an un-expired orphan session
        // is precisely the double-subscription risk this block exists to close.
        reportError(err, {
          site:  'serverAction.guidebook.createSponsorCheckoutSession.expire-orphan',
          orgId: sponsor.org_id,
        })
      })

      const currentRes = await supabase
        .from('guidebook_sponsors')
        .select('checkout_session_id')
        .eq('id', sponsor.id)
        .eq('org_id', sponsor.org_id)
        .maybeSingle()

      const winnerUrl = await openSessionUrl(
        unwrap(currentRes, {
          site:  'serverAction.guidebook.createSponsorCheckoutSession.reread',
          orgId: sponsor.org_id,
        })?.checkout_session_id ?? null
      )

      if (winnerUrl) return { url: winnerUrl }
      return { error: 'Unable to start checkout. Please try again.' }
    }

    // Unauthenticated flow (media kit page has no PM session) — no actorId
    await logAuditEvent({
      orgId:      sponsor.org_id,
      action:     'guidebook.sponsor.checkout_started',
      targetType: 'guidebook_sponsor',
      targetId:   sponsor.id,
      metadata:   { slot_type: sponsor.slot_type },
    })

    return { url: session.url }
  } catch (err) {
    console.error('[createSponsorCheckoutSession]', err)
    reportError(err, { site: 'serverAction.guidebook.createSponsorCheckoutSession' })
    return { error: 'Unable to start checkout. Please try again.' }
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
  try {
    const { user, membership } = await requireOrgRole(['admin', 'manager'])
    const supabase        = createServiceClient({ authorizedBy: membership })

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
      .select('id, media_kit_token')
      .single()

    if (error) {
      console.error('[upsertSponsor]', error.message)
      return { error: 'Failed to save sponsor details. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'guidebook.sponsor.updated',
      targetType: 'guidebook_sponsor',
      targetId:   data.id,
      metadata:   { slot_number: input.slotNumber, slot_type: input.slotType },
    })

    return { mediaKitToken: data.media_kit_token }
  } catch (err) {
    console.error('[upsertSponsor]', err)
    reportError(err, { site: 'serverAction.guidebook.upsertSponsor' })
    return { error: 'Operation failed. Please try again.' }
  }
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
  heroPhotoStoragePath: string | null
  featuredAmenities:    string[]
  featuredAmenityNotes: string | null
}

/**
 * Saves per-property guidebook content (slug, wifi, check-in instructions).
 */
export async function upsertPropertyGuidebookConfig(
  input: UpsertPropertyGuidebookConfigInput
): Promise<{ error?: string }> {
  try {
    const { user, membership } = await requireOrgRole(['admin', 'manager'])
    const supabase        = createServiceClient({ authorizedBy: membership })

    const { data: property } = await supabase
      .from('properties')
      .select('id')
      .eq('id', input.propertyId)
      .eq('org_id', membership.org_id)
      .single()

    if (!property) return { error: 'Property not found.' }

    if (input.featuredAmenities.length > MAX_FEATURED_AMENITIES) {
      return { error: `Choose up to ${MAX_FEATURED_AMENITIES} featured amenities.` }
    }

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
          hero_photo_storage_path: input.heroPhotoStoragePath,
          featured_amenities:      input.featuredAmenities,
          featured_amenity_notes:  input.featuredAmenityNotes,
          updated_at:             new Date().toISOString(),
        },
        { onConflict: 'org_id,property_id' }
      )

    if (error) {
      console.error('[upsertPropertyGuidebookConfig]', error.message)
      return { error: 'Failed to save guidebook settings. Please try again.' }
    }

    // Never log wifi_password value itself — it's a guest-facing credential
    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'guidebook.configuration.updated',
      targetType: 'guidebook_property_config',
      targetId:   input.propertyId,
      metadata:   { is_published: input.isPublished },
    })

    return {}
  } catch (err) {
    console.error('[upsertPropertyGuidebookConfig]', err)
    reportError(err, { site: 'serverAction.guidebook.upsertPropertyGuidebookConfig' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export interface UpdateStayExtensionSettingsInput {
  enabled:          boolean
  gapThresholdDays: number
  discountPct:      number | null
  contactMethod:    'ownerrez_url' | 'email' | 'sms'
  ownerRezUrl:      string | null
  daysBefore:       number
}

/**
 * Not exported: this file is `'use server'`, where every export must be an
 * async action. Same constraint that keeps compareCodeUnits duplicated.
 */
const StayExtensionSettingsSchema = z.object({
  discountPct: z
    .number({ invalid_type_error: 'Discount must be a number.' })
    .finite('Discount must be a number.')
    .min(0, 'Discount must be between 0 and 100.')
    .max(100, 'Discount must be between 0 and 100.')
    .nullable(),
  gapThresholdDays: z
    .number({ invalid_type_error: 'Gap threshold must be a whole number of days.' })
    .int('Gap threshold must be a whole number of days.')
    .min(1, 'Gap threshold must be at least 1 day.')
    .max(365, 'Gap threshold must be 365 days or fewer.'),
  daysBefore: z
    .number({ invalid_type_error: 'Message timing must be a whole number of days.' })
    .int('Message timing must be a whole number of days.')
    .min(1, 'Message timing must be at least 1 day before checkout.')
    .max(365, 'Message timing must be 365 days or fewer.'),
})

/**
 * Saves the org-level "Gap Night" stay-extension messaging settings.
 */
export async function updateStayExtensionSettings(
  input: UpdateStayExtensionSettingsInput
): Promise<{ error?: string }> {
  try {
    const { user, membership } = await requireOrgRole(['admin', 'manager'])
    const supabase        = createServiceClient({ authorizedBy: membership })

    // Every bound below used to be a bare `<` / `>` comparison, which NaN
    // passes: `NaN < 1` and `NaN > 100` are both false. supabase-js then
    // JSON-serializes NaN to `null` and writes a real NULL to the column. The
    // schemas reject it because `.finite()` is what excludes NaN and ±Infinity
    // — a comparison operator never will.
    const settings = StayExtensionSettingsSchema.safeParse({
      discountPct:      input.discountPct,
      gapThresholdDays: input.gapThresholdDays,
      daysBefore:       input.daysBefore,
    })
    if (!settings.success) {
      return { error: settings.error.issues[0]?.message ?? 'Check the values and try again.' }
    }
    if (input.contactMethod === 'ownerrez_url' && !input.ownerRezUrl?.trim()) {
      return { error: 'Please enter your booking page URL.' }
    }

    const { data: updated, error } = await supabase
      .from('guidebook_configurations')
      .update({
        extension_messaging_enabled:   input.enabled,
        extension_gap_threshold_days:  settings.data.gapThresholdDays,
        extension_discount_pct:        settings.data.discountPct,
        extension_contact_method:      input.contactMethod,
        extension_ownerrez_url:        input.contactMethod === 'ownerrez_url' ? input.ownerRezUrl : null,
        extension_message_days_before: settings.data.daysBefore,
        updated_at:                    new Date().toISOString(),
      })
      .eq('org_id', membership.org_id)
      .select('org_id')
      .maybeSingle()

    if (error) {
      console.error('[updateStayExtensionSettings]', error.message)
      return { error: 'Failed to save stay extension settings. Please try again.' }
    }

    if (!updated) {
      // PostgREST answers a zero-row UPDATE with SUCCESS, not an error. An org
      // with no guidebook_configurations row yet — every org before the
      // guidebook is first set up — got a green toast, an audit event
      // recording a change that never happened, and settings that silently did
      // not save.
      return { error: 'Set up your guidebook before configuring gap-night messaging.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'guidebook.stay_extension_settings.updated',
      targetType: 'guidebook_configuration',
      targetId:   membership.org_id,
      metadata:   { enabled: input.enabled, gap_threshold_days: input.gapThresholdDays },
    })

    return {}
  } catch (err) {
    console.error('[updateStayExtensionSettings]', err)
    reportError(err, { site: 'serverAction.guidebook.updateStayExtensionSettings' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/**
 * How long after the original opt-in a guest may correct the number they
 * entered. Long enough to notice a typo and resubmit; far short of the span
 * over which a guidebook link circulates.
 *
 * Measured from guidebook_guest_sms_optins.created_at, which the upsert never
 * writes, rather than opted_in_at, which it refreshes on every submission.
 * From opted_in_at the window was not 15 minutes from the opt-in at all — it
 * was 15 minutes from the LAST submission, so resubmitting inside it restarted
 * the clock and the window could be walked forward without limit.
 */
const OPTIN_CORRECTION_WINDOW_MS = 15 * 60 * 1000

/**
 * Guest-facing SMS opt-in. Unauthenticated (no PM session) — org_id is
 * always derived server-side from the booking's guidebook_token, never
 * accepted from the client.
 */
export async function optInGuestSms(
  guidebookToken: string,
  rawPhone:       string
): Promise<{ success: true } | { error: string }> {
  try {
    const phoneE164 = normalizePhoneToE164(rawPhone)
    if (!phoneE164) return { error: 'Please enter a valid US or Canadian phone number.' }

    const supabase = createServiceClient({ publicSurface: 'guidebook-guest-sms-optin' })

    // Binds its error, like the two consent reads below it. Discarding it made
    // a transient failure indistinguishable from a bad token, so a guest
    // holding a perfectly valid link was told the link was invalid — with
    // nothing logged and nothing reported. The two reads that follow this one
    // both already failed closed with an explicit note about why; this was the
    // odd one out.
    const bookingRes = await supabase
      .from('bookings')
      .select('id, org_id, property_id')
      .eq('guidebook_token', guidebookToken)
      .maybeSingle()

    if (bookingRes.error) {
      console.error('[optInGuestSms] booking lookup', bookingRes.error.message)
      reportError(bookingRes.error, { site: 'serverAction.guidebook.optInGuestSms.booking' })
      return { error: 'Something went wrong. Please try again.' }
    }
    const booking = bookingRes.data
    if (!booking) return { error: 'Invalid guidebook link.' }

    // ── Consent gate 1: has this NUMBER revoked consent anywhere? ────────────
    //
    // STOP is applied globally by phone, across every org and booking
    // (app/api/webhooks/telnyx/route.ts). The opt-in row is scoped to a single
    // booking, so without this check an upsert writing `opted_out_at: null`
    // resurrects a number that opted out — from an unauthenticated form, with
    // nothing establishing that the submitter even owns the number.
    //
    // The sanctioned re-consent path is START/YES/UNSTOP from the handset,
    // which is the whole reason that branch exists in the webhook. This is
    // durable: guest-pii-retention deletes only rows with opted_out_at IS
    // NULL, so a revocation record is kept indefinitely on purpose.
    const revokedRes = await supabase
      .from('guidebook_guest_sms_optins')
      .select('id')
      .eq('phone_e164', phoneE164)
      .not('opted_out_at', 'is', null)
      .limit(1)
      .maybeSingle()

    if (revokedRes.error) {
      // Fail CLOSED. Consent is not something to assume on a degraded read —
      // unlike the abuse limiters, which deliberately fail open.
      console.error('[optInGuestSms] consent check', revokedRes.error.message)
      return { error: 'Something went wrong. Please try again.' }
    }
    if (revokedRes.data) {
      return { error: 'This number previously opted out. Text START to re-subscribe.' }
    }

    // ── Consent gate 2: is an existing opt-in being repointed? ───────────────
    //
    // The upsert conflicts on booking_id, so a second submission REPLACES
    // phone_e164 in place and every later message on the booking — nudges,
    // stay-extension offers — goes to the new number, with no notice to the
    // guest. (The door code specifically is safe: guidebook-guest-opted-in
    // claims with `.is('door_code_sent_at', null)` and this payload does not
    // reset it, so only the first submitter ever receives it.)
    //
    // A blanket refusal would trap a guest who mistyped their own number, so
    // corrections stay open for a short window after the original opt-in. That
    // covers the real case — a typo is noticed immediately — while refusing a
    // repoint days later, which is what a leaked link enables.
    // created_at, not opted_in_at. The upsert below REFRESHES opted_in_at on
    // every submission, so a window measured from it walks forward: repoint at
    // 14 minutes, and the 15-minute clock restarts from there, indefinitely.
    // created_at carries the original row's timestamp and the upsert never
    // names it, so it is the only immutable anchor here — and "how long after
    // the ORIGINAL opt-in" is what this window is documented to mean.
    const existingRes = await supabase
      .from('guidebook_guest_sms_optins')
      .select('id, phone_e164, created_at')
      .eq('booking_id', booking.id)
      .maybeSingle()

    if (existingRes.error) {
      console.error('[optInGuestSms] existing opt-in lookup', existingRes.error.message)
      return { error: 'Something went wrong. Please try again.' }
    }

    const existing = existingRes.data
    if (existing && existing.phone_e164 !== phoneE164) {
      const firstOptedInAt = existing.created_at ? new Date(existing.created_at).getTime() : 0
      if (Date.now() - firstOptedInAt > OPTIN_CORRECTION_WINDOW_MS) {
        // Never echo either number back — guest PII, and confirming which
        // number is on file would itself be a disclosure.
        return { error: 'A different number is already signed up for this stay. Contact your host to change it.' }
      }
    }

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
          opted_in_at: new Date().toISOString(),
          updated_at:  new Date().toISOString(),
        },
        { onConflict: 'booking_id' }
      )
      .select('id')
      .single()

    if (error) {
      // Never log phoneE164 or any part of rawPhone — guest PII.
      console.error('[optInGuestSms]', error.message)
      return { error: 'Something went wrong. Please try again.' }
    }

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
  } catch (err) {
    console.error('[optInGuestSms]', err)
    reportError(err, { site: 'serverAction.guidebook.optInGuestSms' })
    return { error: 'Something went wrong. Please try again.' }
  }
}
