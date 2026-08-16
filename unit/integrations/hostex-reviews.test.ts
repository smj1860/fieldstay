import { describe, it, expect } from 'vitest'

// ============================================================================
// Hostex reviews.
//
// Two Hostex-specific traps, both confirmed against the published OpenAPI:
//
//   1. A /reviews date range must be UNDER 180 days ("Less than 180 days from
//      start_check_out_date"). A 12-month backfill is therefore several
//      requests. Send one wide range and Hostex rejects it — which, since
//      every v3 error arrives as HTTP 200, would surface as an empty review
//      list rather than a failure.
//
//   2. One record per RESERVATION, carrying up to three things: the guest
//      reviewing the stay, the HOST reviewing the GUEST, and the host's reply.
//      Only the first is a review of the property. Importing host_review would
//      pollute a property's rating average with scores that are not about the
//      property.
// ============================================================================

import { hostexReviewWindows } from '@/lib/integrations/providers/hostex-api'
import { hostexReviewToNormalized } from '@/lib/integrations/providers/hostex.mappers'
import type { HostexReview } from '@/lib/integrations/providers/hostex.types'

function review(overrides: Partial<HostexReview> = {}): HostexReview {
  return {
    reservation_code: 'HX-1',
    property_id:      4242,
    channel_type:     'airbnb',
    listing_id:       'L1',
    check_in_date:    '2026-07-01',
    check_out_date:   '2026-07-05',
    ...overrides,
  }
}

const GUEST = { score: 4.5, content: 'Lovely place, spotless.', created_at: '2026-07-06T10:00:00+00:00' }

describe('hostexReviewWindows', () => {
  const NOW = new Date('2026-08-16T00:00:00Z')

  it('never emits a window of 180 days or more', () => {
    // The whole reason this function exists.
    for (const w of hostexReviewWindows(12, NOW)) {
      const days = (Date.parse(w.endCheckOutDate) - Date.parse(w.startCheckOutDate)) / 86_400_000
      expect(days).toBeGreaterThan(0)
      expect(days).toBeLessThan(180)
    }
  })

  it('covers the requested history with no gap between windows', () => {
    const windows = hostexReviewWindows(12, NOW)
    expect(windows.length).toBeGreaterThan(1)

    // Newest first; each window starts the day after the previous one ended.
    for (let i = 1; i < windows.length; i++) {
      const gap = (Date.parse(windows[i - 1]!.startCheckOutDate) - Date.parse(windows[i]!.endCheckOutDate)) / 86_400_000
      expect(gap).toBe(1)
    }
  })

  it('runs newest-first so a partial backfill keeps the most useful reviews', () => {
    const windows = hostexReviewWindows(12, NOW)
    expect(windows[0]!.endCheckOutDate).toBe('2026-08-16')
  })

  it('does not reach further back than asked', () => {
    const windows = hostexReviewWindows(12, NOW)
    expect(windows.at(-1)!.startCheckOutDate >= '2025-08-16').toBe(true)
  })

  it('emits a single window for a short history', () => {
    expect(hostexReviewWindows(1, NOW)).toHaveLength(1)
  })
})

describe('hostexReviewToNormalized', () => {
  it('maps a guest review onto the reviews row', () => {
    const n = hostexReviewToNormalized(review({ guest_review: GUEST }))!
    expect(n.external_id).toBe('HX-1')      // the reservation IS the identity
    expect(n.external_source).toBe('hostex')
    expect(n.property_external_id).toBe('4242')
    expect(n.rating).toBe(4.5)
    expect(n.review_text).toBe('Lovely place, spotless.')
    expect(n.review_date).toBe('2026-07-06T10:00:00+00:00')
  })

  it('IGNORES a host review of the guest — that is not a property review', () => {
    // Storing it would corrupt the property's rating average with a score
    // that is about the guest.
    const n = hostexReviewToNormalized(review({
      host_review: { score: 1, content: 'Guest left a mess.', created_at: '2026-07-06T10:00:00+00:00' },
    }))
    expect(n).toBeNull()
  })

  it('keeps the guest review when both directions are present', () => {
    const n = hostexReviewToNormalized(review({
      guest_review: GUEST,
      host_review:  { score: 1, content: 'Guest left a mess.', created_at: '2026-07-06T10:00:00+00:00' },
    }))!
    expect(n.rating).toBe(4.5)
    expect(n.review_text).toBe('Lovely place, spotless.')
  })

  it("marks a review the PM already answered inside Hostex as 'posted'", () => {
    // Otherwise FieldStay's queue nags them to reply a second time.
    const n = hostexReviewToNormalized(review({
      guest_review: GUEST,
      host_reply:   { content: 'Thank you!', created_at: '2026-07-07T10:00:00+00:00' },
    }))!
    expect(n.response_status).toBe('posted')
  })

  it("marks an unanswered review 'pending'", () => {
    expect(hostexReviewToNormalized(review({ guest_review: GUEST }))!.response_status).toBe('pending')
  })

  it('skips a record with no guest review at all', () => {
    // A pending_guest_review reservation has no content and no rating, and
    // reviews.rating/review_text are both NOT NULL.
    expect(hostexReviewToNormalized(review())).toBeNull()
  })

  it('skips a non-numeric score rather than writing a fabricated zero', () => {
    const n = hostexReviewToNormalized(review({
      guest_review: { ...GUEST, score: undefined as unknown as number },
    }))
    expect(n).toBeNull()
  })

  it('tolerates an empty comment — a rating-only review is still a review', () => {
    const n = hostexReviewToNormalized(review({
      guest_review: { ...GUEST, content: undefined as unknown as string },
    }))!
    expect(n.rating).toBe(4.5)
    expect(n.review_text).toBe('')
  })
})
