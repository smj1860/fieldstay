import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgRole: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: { checkout: { sessions: { create: vi.fn() } } },
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/sms/telnyx', () => ({
  normalizePhoneToE164: vi.fn(),
}))

import { requireOrgRole } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { normalizePhoneToE164 } from '@/lib/sms/telnyx'
import {
  createSponsorCheckoutSession,
  upsertSponsor,
  upsertPropertyGuidebookConfig,
  updateStayExtensionSettings,
  optInGuestSms,
} from '@/app/actions/guidebook'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'order', 'limit']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

describe('actions/guidebook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createSponsorCheckoutSession — unauthenticated, media-kit-token gated', () => {
    it('creates a Stripe checkout session for a valid, inactive sponsor slot', async () => {
      const supabase = makeSupabase({
        guidebook_sponsors: [
          { data: { id: 'sponsor_1', org_id: 'org_1', business_name: 'Lakeside Grill', slot_type: 'restaurant', status: 'pending' } },
        ],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)
      vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({
        id: 'cs_1', url: 'https://checkout.stripe.com/cs_1',
      } as never)

      const result = await createSponsorCheckoutSession('kit_token_abc')

      expect(result).toEqual({ url: 'https://checkout.stripe.com/cs_1' })
      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ guidebook_sponsor_id: 'sponsor_1', org_id: 'org_1' }),
      }))
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        orgId: 'org_1', action: 'guidebook.sponsor.checkout_started', targetId: 'sponsor_1',
      }))
    })

    it('rejects an invalid media kit token before calling Stripe', async () => {
      const supabase = makeSupabase({ guidebook_sponsors: [{ data: null }] })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await createSponsorCheckoutSession('bad-token')

      expect(result).toEqual({ error: 'Invalid media kit link.' })
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
    })

    it('rejects a slot that is already active', async () => {
      const supabase = makeSupabase({
        guidebook_sponsors: [
          { data: { id: 'sponsor_1', org_id: 'org_1', business_name: 'Lakeside Grill', slot_type: 'restaurant', status: 'active' } },
        ],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await createSponsorCheckoutSession('kit_token_abc')

      expect(result).toEqual({ error: 'This sponsorship slot is already active.' })
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
    })

    it('returns a generic error when Stripe fails', async () => {
      const supabase = makeSupabase({
        guidebook_sponsors: [
          { data: { id: 'sponsor_1', org_id: 'org_1', business_name: 'Lakeside Grill', slot_type: 'restaurant', status: 'pending' } },
        ],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)
      vi.mocked(stripe.checkout.sessions.create).mockRejectedValue(new Error('stripe down'))

      const result = await createSponsorCheckoutSession('kit_token_abc')

      expect(result).toEqual({ error: 'Unable to start checkout. Please try again.' })
    })
  })

  describe('upsertSponsor', () => {
    it('saves sponsor details scoped to the caller org', async () => {
      const supabase = makeSupabase({
        guidebook_sponsors: [{ data: { id: 'sponsor_1', media_kit_token: 'kit_abc' }, error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await upsertSponsor({
        slotNumber: 1, businessName: 'Lakeside Grill', businessDescription: null,
        businessPhone: null, businessWebsite: null, customOfferText: null,
        offerType: 'percentage', offerValue: 10, offerItem: null, featuredItem: null,
        address: null, lat: null, lng: null, slotType: 'morning_brew', slotContext: null,
      })

      expect(result).toEqual({ mediaKitToken: 'kit_abc' })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        orgId: 'org_1', action: 'guidebook.sponsor.updated',
      }))
    })

    it('rejects a slot number out of range before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await upsertSponsor({
        slotNumber: 7, businessName: 'Lakeside Grill', businessDescription: null,
        businessPhone: null, businessWebsite: null, customOfferText: null,
        offerType: 'percentage', offerValue: 10, offerItem: null, featuredItem: null,
        address: null, lat: null, lng: null, slotType: 'morning_brew', slotContext: null,
      })

      expect(result).toEqual({ error: 'Slot number must be between 1 and 6.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller lacks the required role', async () => {
      vi.mocked(requireOrgRole).mockRejectedValue(new Error('You do not have permission to perform this action.'))

      const result = await upsertSponsor({
        slotNumber: 1, businessName: 'Lakeside Grill', businessDescription: null,
        businessPhone: null, businessWebsite: null, customOfferText: null,
        offerType: 'percentage', offerValue: 10, offerItem: null, featuredItem: null,
        address: null, lat: null, lng: null, slotType: 'morning_brew', slotContext: null,
      })

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(createServiceClient).not.toHaveBeenCalled()
    })
  })

  describe('upsertPropertyGuidebookConfig', () => {
    it('saves config when the property belongs to the caller org', async () => {
      const supabase = makeSupabase({
        properties:                 [{ data: { id: 'prop_1' } }],
        guidebook_property_configs: [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await upsertPropertyGuidebookConfig({
        propertyId: 'prop_1', slug: 'lakeview-cabin', checkInInstructions: null,
        checkOutInstructions: null, wifiNetwork: null, wifiPassword: null,
        houseRules: null, isPublished: true,
      })

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        orgId: 'org_1', action: 'guidebook.configuration.updated', targetId: 'prop_1',
      }))
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await upsertPropertyGuidebookConfig({
        propertyId: 'other-orgs-property', slug: 'lakeview-cabin', checkInInstructions: null,
        checkOutInstructions: null, wifiNetwork: null, wifiPassword: null,
        houseRules: null, isPublished: true,
      })

      expect(result).toEqual({ error: 'Property not found.' })
      expect(supabase.from).not.toHaveBeenCalledWith('guidebook_property_configs')
    })

    it('returns a generic error and never touches the DB when the caller lacks the required role', async () => {
      vi.mocked(requireOrgRole).mockRejectedValue(new Error('You do not have permission to perform this action.'))

      const result = await upsertPropertyGuidebookConfig({
        propertyId: 'prop_1', slug: 'lakeview-cabin', checkInInstructions: null,
        checkOutInstructions: null, wifiNetwork: null, wifiPassword: null,
        houseRules: null, isPublished: true,
      })

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(createServiceClient).not.toHaveBeenCalled()
    })
  })

  describe('updateStayExtensionSettings', () => {
    function validInput() {
      return {
        enabled: true, gapThresholdDays: 3, discountPct: 10,
        contactMethod: 'email' as const, ownerRezUrl: null, daysBefore: 2,
      }
    }

    it('saves settings scoped to the caller org', async () => {
      const supabase = makeSupabase({ guidebook_configurations: [{ error: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await updateStayExtensionSettings(validInput())

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        orgId: 'org_1', action: 'guidebook.stay_extension_settings.updated', targetId: 'org_1',
      }))
    })

    it('rejects an out-of-range discount before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await updateStayExtensionSettings({ ...validInput(), discountPct: 150 })

      expect(result).toEqual({ error: 'Discount must be between 0 and 100.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('requires an OwnerRez URL when contact method is ownerrez_url', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateStayExtensionSettings({
        ...validInput(), contactMethod: 'ownerrez_url', ownerRezUrl: '   ',
      })

      expect(result).toEqual({ error: 'Please enter your OwnerRez booking page URL.' })
    })

    it('returns a generic error and never touches the DB when the caller lacks the required role', async () => {
      vi.mocked(requireOrgRole).mockRejectedValue(new Error('You do not have permission to perform this action.'))

      const result = await updateStayExtensionSettings(validInput())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(createServiceClient).not.toHaveBeenCalled()
    })
  })

  describe('optInGuestSms — unauthenticated, guidebook-token gated', () => {
    it('derives org_id/property_id server-side from the booking behind the token, never from client input', async () => {
      vi.mocked(normalizePhoneToE164).mockReturnValue('+12065551234')
      const supabase = makeSupabase({
        bookings:                    [{ data: { id: 'booking_1', org_id: 'org_1', property_id: 'prop_1' } }],
        guidebook_guest_sms_optins:  [{ data: { id: 'optin_1' }, error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await optInGuestSms('valid-guidebook-token', '(206) 555-1234')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'guidebook/guest.opted.in',
        data: {
          optinId: 'optin_1', bookingId: 'booking_1', orgId: 'org_1',
          propertyId: 'prop_1', phoneE164: '+12065551234',
        },
      })
    })

    it('rejects an invalid/unrecognized guidebook token before writing anything (IDOR/token check)', async () => {
      vi.mocked(normalizePhoneToE164).mockReturnValue('+12065551234')
      const supabase = makeSupabase({ bookings: [{ data: null }] })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await optInGuestSms('bogus-token', '(206) 555-1234')

      expect(result).toEqual({ error: 'Invalid guidebook link.' })
      expect(supabase.from).not.toHaveBeenCalledWith('guidebook_guest_sms_optins')
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('rejects an unparsable phone number before any DB lookup', async () => {
      vi.mocked(normalizePhoneToE164).mockReturnValue(null)
      const supabase = makeSupabase({})
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await optInGuestSms('valid-guidebook-token', 'not-a-phone')

      expect(result).toEqual({ error: 'Please enter a valid US or Canadian phone number.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a generic error and does not fire the event when the upsert fails', async () => {
      vi.mocked(normalizePhoneToE164).mockReturnValue('+12065551234')
      const supabase = makeSupabase({
        bookings:                   [{ data: { id: 'booking_1', org_id: 'org_1', property_id: 'prop_1' } }],
        guidebook_guest_sms_optins: [{ data: null, error: { message: 'db error' } }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await optInGuestSms('valid-guidebook-token', '(206) 555-1234')

      expect(result).toEqual({ error: 'Something went wrong. Please try again.' })
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })
})
