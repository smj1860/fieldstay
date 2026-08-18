import { describe, it, expect } from 'vitest'
import {
  hostawayListingToNormalized,
  hostawayReservationToNormalized,
  mapHostawayStatus,
  mapHostawayChannel,
  extractHostawayActualTotal,
  hostawayReviewToNormalized,
} from '@/lib/integrations/providers/hostaway.mappers'
import type { HostawayListing, HostawayReservation, HostawayReview } from '@/lib/integrations/providers/hostaway'

// ============================================================================
// The Hostaway mappers carry every judgment call in that integration. The sync
// functions around them are wiring whose correctness tsc already enforces —
// these are the parts that can be quietly WRONG while compiling perfectly.
//
// This file replaced most of unit/inngest/hostaway-initial-sync.test.ts, whose
// header stated "there's no separate normalizer module to mock the way
// Hospitable has" and therefore drove the whole function through a stubbed
// Supabase chain. That premise stopped being true when the hand-rolled upserts
// were replaced with the shared writers.
// ============================================================================

function listing(over: Partial<HostawayListing> = {}): HostawayListing {
  return { id: 101, name: 'Internal name', ...over }
}

function reservation(over: Partial<HostawayReservation> = {}): HostawayReservation {
  return {
    id:            5001,
    listingId:     101,
    arrivalDate:   '2026-08-01',
    departureDate: '2026-08-05',
    status:        'confirmed',
    ...over,
  }
}

describe('hostawayListingToNormalized: room counts', () => {
  // THE regression this mapper exists for. The 2026-07-25 sync wrote
  // `bedrooms: listing.bedrooms ?? 1`, so a PM who corrected a 1-bedroom
  // default to four had it overwritten on every subsequent sync —
  // the provider's fabricated default beating the only real number in the
  // system. upsert-normalized reads null as "this PMS has no opinion".
  it('maps an absent count to null, NEVER a guessed default', () => {
    const n = hostawayListingToNormalized(listing())
    expect(n.bedrooms).toBeNull()
    expect(n.bathrooms).toBeNull()
    expect(n.max_guests).toBeNull()
  })

  it('passes a real count through', () => {
    const n = hostawayListingToNormalized(listing({ bedrooms: 4, bathrooms: 2.5, maxGuests: 8 }))
    expect(n.bedrooms).toBe(4)
    expect(n.bathrooms).toBe(2.5)
    expect(n.max_guests).toBe(8)
  })

  it('preserves a genuine zero — a studio has 0 bedrooms', () => {
    // Distinct from absence on purpose: `?? 1` and a truthiness check both
    // corrupt this one, in opposite directions.
    expect(hostawayListingToNormalized(listing({ bedrooms: 0 })).bedrooms).toBe(0)
  })

  it('rejects a nonsense count rather than storing it', () => {
    const n = hostawayListingToNormalized(listing({ bedrooms: -1, bathrooms: Number.NaN }))
    expect(n.bedrooms).toBeNull()
    expect(n.bathrooms).toBeNull()
  })
})

describe('hostawayListingToNormalized: coordinates', () => {
  it('passes Hostaway lat/lng straight through, skipping the ZIP geocode', () => {
    // Hostaway is the only one of the three PMS providers that returns
    // coordinates AND structured address fields. This matters beyond tidiness:
    // auto-assign-turnover.ts scores crew proximity only when both the
    // property and the crew member have coordinates.
    const n = hostawayListingToNormalized(listing({ lat: 32.8, lng: -85.9 }))
    expect(n.lat).toBe(32.8)
    expect(n.lng).toBe(-85.9)
  })

  it('treats a 0/0 coordinate as absent', () => {
    // Null Island is in the Gulf of Guinea. A property there is a serialized
    // zero, not a location, and storing it would put every crew-distance
    // calculation for that property thousands of miles off.
    const n = hostawayListingToNormalized(listing({ lat: 0, lng: 0 }))
    expect(n.lat).toBeNull()
    expect(n.lng).toBeNull()
  })

  it('leaves coordinates null when Hostaway omits them, for the geocode fallback', () => {
    const n = hostawayListingToNormalized(listing({ zipcode: '36853' }))
    expect(n.lat).toBeNull()
    expect(n.lng).toBeNull()
    expect(n.zip).toBe('36853')
  })
})

describe('hostawayListingToNormalized: naming and blank handling', () => {
  it('prefers the guest-facing externalListingName over the internal name', () => {
    const n = hostawayListingToNormalized(
      listing({ name: 'Internal name', externalListingName: 'Lakefront Cabin' }),
    )
    expect(n.name).toBe('Lakefront Cabin')
  })

  it('falls back to the internal name, then to a stable placeholder', () => {
    expect(hostawayListingToNormalized(listing({ externalListingName: '   ' })).name).toBe('Internal name')
    expect(hostawayListingToNormalized(listing({ name: '', externalListingName: '' })).name)
      .toBe('Hostaway listing 101')
  })

  it('normalizes blank address fields to null rather than empty strings', () => {
    // '' would defeat upsert-normalized's null checks and be written as a real
    // value, overwriting whatever the PM entered.
    const n = hostawayListingToNormalized(listing({ address: '  ', city: '', state: undefined }))
    expect(n.address).toBeNull()
    expect(n.city).toBeNull()
    expect(n.state).toBeNull()
  })

  it('never asserts PM-editable content, so a PM entry survives every sync', () => {
    const n = hostawayListingToNormalized(listing())
    expect(n.wifi_name).toBeNull()
    expect(n.wifi_password).toBeNull()
    expect(n.access_instructions).toBeNull()
    expect(n.house_manual).toBeNull()
    // Not {} — an empty amenity map would read as "confirmed to have none" to
    // anything that later seeds assets from it.
    expect(n.amenities).toBeNull()
  })
})

describe('mapHostawayStatus', () => {
  it('treats only accepted stays as confirmed', () => {
    expect(mapHostawayStatus('confirmed')).toBe('confirmed')
    // 'modified' is an accepted reservation that was later changed, not a
    // pending one.
    expect(mapHostawayStatus('modified')).toBe('confirmed')
  })

  it('holds uncommitted stays at tentative so no cleaner is dispatched', () => {
    for (const s of ['new', 'inquiry', 'tentative']) {
      expect(mapHostawayStatus(s)).toBe('tentative')
    }
  })

  it('maps cancelled, and defaults an unknown status to tentative', () => {
    expect(mapHostawayStatus('cancelled')).toBe('cancelled')
    // Fails safe: an unforeseen status must not create work.
    expect(mapHostawayStatus('some_new_hostaway_status')).toBe('tentative')
  })
})

describe('mapHostawayChannel', () => {
  it.each([
    ['Airbnb',          'airbnb'],
    ['airbnbOfficial',  'airbnb'],
    ['Vrbo',            'vrbo'],
    ['HomeAway',        'vrbo'],
    ['booking.com',     'booking_com'],
    ['bookingEngine',   'booking_com'],
    ['direct',          'direct'],
    ['manual',          'direct'],
  ])('maps %s to %s', (channel, expected) => {
    expect(mapHostawayChannel(channel)).toBe(expected)
  })

  it('lands channels with no enum member on other', () => {
    // Wider than booking_source by design — 'other' is what the enum has it
    // for, not a mapping failure.
    for (const c of ['agoda', 'expedia', 'tripadvisor', 'marriott', undefined, null, '']) {
      expect(mapHostawayChannel(c)).toBe('other')
    }
  })
})

describe('extractHostawayActualTotal', () => {
  it('returns totalPrice when Hostaway reports one', () => {
    expect(extractHostawayActualTotal(reservation({ totalPrice: 1250.5 }))).toBe(1250.5)
  })

  it('returns null rather than a fabricated number', () => {
    // booking-events.ts already has a documented nights * avg_nightly_rate
    // estimate for the unknown case; inventing 0 here would post a real
    // owner_transactions row for zero revenue instead.
    expect(extractHostawayActualTotal(reservation())).toBeNull()
    expect(extractHostawayActualTotal(reservation({ totalPrice: 0 }))).toBeNull()
    expect(extractHostawayActualTotal(reservation({ totalPrice: -5 }))).toBeNull()
    expect(extractHostawayActualTotal(reservation({ totalPrice: Number.NaN }))).toBeNull()
  })

  it('is GROSS — documented, and asserted so the caveat cannot be lost silently', () => {
    // totalPrice is what the guest pays. Hostex's equivalent returns
    // total_rate MINUS total_commission because the owner-facing figure is the
    // payout; the Hostaway shape typed in hostaway.ts carries no commission or
    // payout field to net against. This assertion exists so that when someone
    // DOES type that field, this test fails and forces the caveat in
    // events.ts's booking/confirmed comment to be updated with it.
    const gross = 1000
    expect(extractHostawayActualTotal(reservation({ totalPrice: gross }))).toBe(gross)
  })
})

describe('hostawayReservationToNormalized', () => {
  it('stringifies both ids for the property map lookup', () => {
    const n = hostawayReservationToNormalized(reservation({ id: 5001, listingId: 101 }))
    expect(n.external_id).toBe('5001')
    expect(n.property_external_id).toBe('101')
  })

  it('maps dates, guest and channel', () => {
    const n = hostawayReservationToNormalized(reservation({
      guestName: 'Jane', guestEmail: 'jane@example.com', channelName: 'Airbnb',
    }))
    expect(n.checkin_date).toBe('2026-08-01')
    expect(n.checkout_date).toBe('2026-08-05')
    expect(n.guest_name).toBe('Jane')
    expect(n.guest_email).toBe('jane@example.com')
    expect(n.source).toBe('airbnb')
    expect(n.status).toBe('confirmed')
  })

  it('leaves per-stay times null so the property times govern', () => {
    const n = hostawayReservationToNormalized(reservation())
    expect(n.checkin_time).toBeNull()
    expect(n.checkout_time).toBeNull()
  })

  it('reports every stay as a guest stay with no block', () => {
    // Hostaway has no owner-stay concept, and manually-blocked owner time does
    // not surface through /reservations at all — it lives on the calendar
    // endpoints, which this phase does not sync. Same position Hostex shipped
    // with. The previous mapping carried a "⚠️ Unconfirmed" comment saying
    // this less precisely.
    const n = hostawayReservationToNormalized(reservation())
    expect(n.is_block).toBe(false)
    expect(n.stay_type).toBe('guest_stay')
  })

  it('blanks an empty guest name rather than storing an empty string', () => {
    const n = hostawayReservationToNormalized(reservation({ guestName: '  ', guestEmail: '' }))
    expect(n.guest_name).toBeNull()
    expect(n.guest_email).toBeNull()
  })
})

// ── Reviews ──────────────────────────────────────────────────────────────────

function review(over: Partial<HostawayReview> = {}): HostawayReview {
  return {
    id:               77,
    listingMapId:     101,
    type:             'guest-to-host',
    status:           'published',
    rating:           5,
    publicReview:     'Spotless and easy check-in.',
    revieweeResponse: null,
    departureDate:    '2026-05-11 22:00:00',
    guestName:        'Andrew Peterson',
    ...over,
  }
}

describe('hostawayReviewToNormalized: what is NOT storable', () => {
  // reviews.rating and reviews.review_text are both NOT NULL, and Hostaway
  // returns a row from the moment a review is SCHEDULED — rating and
  // publicReview both null. Storing those needs invented values, and a
  // fabricated 0-star review with empty text then gets handed to RepuGuard to
  // draft a public reply to.
  it('drops a scheduled review that has no rating or text yet', () => {
    expect(hostawayReviewToNormalized(review({ status: 'awaiting', rating: null, publicReview: null }))).toBeNull()
    expect(hostawayReviewToNormalized(review({ rating: null }))).toBeNull()
    expect(hostawayReviewToNormalized(review({ publicReview: null }))).toBeNull()
    expect(hostawayReviewToNormalized(review({ publicReview: '   ' }))).toBeNull()
  })

  it('guards on CONTENT rather than on the status name', () => {
    // A status allowlist would have to be guessed, and would silently start
    // dropping real reviews the first time Hostaway added a status. Anything
    // carrying a rating and a body is storable whatever it is called.
    const odd = hostawayReviewToNormalized(review({ status: 'expired' as never }))
    expect(odd).not.toBeNull()
    expect(odd!.review_text).toBe('Spotless and easy check-in.')
  })

  it('drops our own reviews of the guest', () => {
    // host-to-guest is us reviewing them. Importing it would put our words in
    // the reviews table and ask RepuGuard to reply to ourselves.
    expect(hostawayReviewToNormalized(review({ type: 'host-to-guest' }))).toBeNull()
  })

  it('drops a cancelled review', () => {
    expect(hostawayReviewToNormalized(review({ isCancelled: 1 }))).toBeNull()
  })
})

describe('hostawayReviewToNormalized: mapping', () => {
  it('keys on the review id and the listing it is about', () => {
    const n = hostawayReviewToNormalized(review({ id: 77, listingMapId: 101 }))!
    expect(n.external_id).toBe('77')
    // reviews say listingMapId where reservations say listingId; both are the
    // listing id that properties.external_id was written from.
    expect(n.property_external_id).toBe('101')
    expect(n.external_source).toBe('hostaway')
  })

  it("treats the host's reply as already-answered", () => {
    // Keeps RepuGuard from drafting over a reply that already exists.
    expect(hostawayReviewToNormalized(review())!.response_status).toBe('pending')
    expect(hostawayReviewToNormalized(review({ revieweeResponse: 'Thanks!' }))!.response_status).toBe('posted')
    expect(hostawayReviewToNormalized(review({ revieweeResponse: '  ' }))!.response_status).toBe('pending')
  })

  it("converts Hostaway's offset-less datetime to an ISO timestamp", () => {
    const n = hostawayReviewToNormalized(review({ departureDate: '2026-05-11 22:00:00' }))!
    expect(n.review_date).toBe('2026-05-11T22:00:00.000Z')
  })

  it('survives a missing or unparseable date rather than dropping the review', () => {
    expect(hostawayReviewToNormalized(review({ departureDate: null }))!.review_date).toBeNull()
    expect(hostawayReviewToNormalized(review({ departureDate: 'not a date' }))!.review_date).toBeNull()
  })

  it('never fabricates a review URL', () => {
    // Hostaway has no confirmed per-review URL. A synthesised one would be a
    // dead link in the reviews list.
    expect(hostawayReviewToNormalized(review())!.external_url).toBeNull()
  })

  it('rounds a fractional rating, since reviews.rating is an integer column', () => {
    expect(hostawayReviewToNormalized(review({ rating: 4.6 }))!.rating).toBe(5)
  })
})
