import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/app/actions/sponsor-assignments', () => ({
  setSponsorProperties:    vi.fn(async () => ({ success: true })),
  setPropertySponsors:     vi.fn(async () => ({ success: true })),
  resetPropertyToAutomatic: vi.fn(async () => ({ success: true })),
}))

// distanceMiles is a pure haversine calculation — spying on it (rather than
// stubbing a fixed value) is what lets the memoization test below assert the
// call COUNT, which is the actual defect under test.
vi.mock('@/lib/geocoding', async () => {
  const actual = await vi.importActual<typeof import('@/lib/geocoding')>('@/lib/geocoding')
  return { ...actual, distanceMiles: vi.fn(actual.distanceMiles) }
})

import { distanceMiles } from '@/lib/geocoding'
import { SponsorPropertiesDialog, type AssignmentProperty } from '@/app/(dashboard)/guidebook/sponsor-assignment'
import type { GuidebookSponsor } from '@/types/database'

// ============================================================================
// SponsorPropertiesDialog renders one row per property in the ORG — up to
// MAX_SELF_SERVE_PROPERTIES (150) — with a distance computed against the
// sponsor for every row. Two findings from the scalability audit:
//   1. That distance computation was recomputed on every render (every toggle,
//      every keystroke), not memoized against the (sponsor, properties) pair.
//   2. The full list rendered unpaginated, with no windowing at all.
// ============================================================================

function makeSponsor(over: Partial<GuidebookSponsor> = {}): GuidebookSponsor {
  return {
    id: 'sponsor_1', org_id: 'org_1', business_name: 'The Grill House',
    lat: 32.5, lng: -85.9, slot_number: 1, slot_type: 'dinner_pints',
    status: 'active', business_description: null, business_phone: null,
    business_website: null, custom_offer_text: null, offer_type: 'none',
    offer_value: null, offer_item: null, featured_item: null, address: null,
    photo_storage_path: null, media_kit_token: 'tok', checkout_session_id: null,
    stripe_subscription_id: null, stripe_customer_id: null, activated_at: null,
    deactivated_at: null, slot_context: null, created_at: '', updated_at: '',
    ...over,
  } as GuidebookSponsor
}

// lat/lng default to null (not a nearby coordinate) so a row's <label> renders
// ONLY the property name — no distance span — which keeps its accessible name
// an exact match for getByLabelText. Tests that need a real distance override
// lat/lng explicitly and look up that row's checkbox by its DOM id instead.
function makeProperty(id: string, over: Partial<AssignmentProperty> = {}): AssignmentProperty {
  return {
    id, name: `Property ${id}`, lat: null, lng: null,
    mode: 'auto', sponsors: [],
    ...over,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('SponsorPropertiesDialog — pagination', () => {
  it('renders only the first page of properties, with a Show more control for the rest', () => {
    const properties = Array.from({ length: 120 }, (_, i) => makeProperty(String(i)))
    render(
      <SponsorPropertiesDialog sponsor={makeSponsor()} properties={properties} onClose={vi.fn()} />,
    )

    expect(screen.getByText('Property 0')).toBeInTheDocument()
    expect(screen.getByText('Property 49')).toBeInTheDocument()
    expect(screen.queryByText('Property 50')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show 50 more \(70 remaining\)/i })).toBeInTheDocument()
  })

  it('reveals more rows on click without losing existing selections off-page', async () => {
    const user = userEvent.setup()
    const properties = Array.from({ length: 60 }, (_, i) => makeProperty(String(i)))
    render(
      <SponsorPropertiesDialog sponsor={makeSponsor()} properties={properties} onClose={vi.fn()} />,
    )

    // Select a property that's on the FIRST page.
    await user.click(screen.getByLabelText('Property 0'))
    await user.click(screen.getByRole('button', { name: /show 10 more/i }))

    expect(screen.getByText('Property 59')).toBeInTheDocument()
    expect((screen.getByLabelText('Property 0') as HTMLInputElement).checked).toBe(true)
  })

  it('renders every property with no Show more control when under the page size', () => {
    const properties = Array.from({ length: 5 }, (_, i) => makeProperty(String(i)))
    render(
      <SponsorPropertiesDialog sponsor={makeSponsor()} properties={properties} onClose={vi.fn()} />,
    )

    expect(screen.queryByRole('button', { name: /show.*more/i })).not.toBeInTheDocument()
  })

  it('"select nearby" still applies across the WHOLE org, not just the visible page', async () => {
    const user = userEvent.setup()
    // 60 properties, all at the same coordinates as the sponsor — every one
    // is "nearby" — with the page size (50) smaller than the total.
    const properties = Array.from({ length: 60 }, (_, i) =>
      makeProperty(String(i), { lat: 32.5, lng: -85.9 }))
    render(
      <SponsorPropertiesDialog sponsor={makeSponsor({ lat: 32.5, lng: -85.9 })} properties={properties} onClose={vi.fn()} />,
    )

    expect(screen.getByRole('button', { name: /select all within 10 miles \(60\)/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /select all within 10 miles \(60\)/i }))
    await user.click(screen.getByRole('button', { name: /show 10 more/i }))

    // A property beyond the original page, selected only by the bulk action.
    // Looked up by DOM id, not label text: these rows carry real coordinates,
    // so their <label> also renders a distance span.
    const checkbox = document.getElementById('sponsor-prop-55') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })
})

describe('SponsorPropertiesDialog — distance memoization', () => {
  it('does not recompute distances on a re-render that changes neither the sponsor nor the property list', async () => {
    const user = userEvent.setup()
    // Real coordinates on every property — otherwise distanceMiles is never
    // called at all (the null check short-circuits it), which would make this
    // test pass trivially regardless of whether memoization works.
    const properties = Array.from({ length: 20 }, (_, i) =>
      makeProperty(String(i), { lat: 32.5 + i * 0.01, lng: -85.9 }))
    render(
      <SponsorPropertiesDialog sponsor={makeSponsor()} properties={properties} onClose={vi.fn()} />,
    )

    const callsAfterMount = vi.mocked(distanceMiles).mock.calls.length
    expect(callsAfterMount).toBeGreaterThan(0)

    // Toggling checkboxes re-renders the whole list (selection state lives in
    // this component) but changes neither `sponsor` nor `properties` — the
    // memoized distance map must not be recomputed. Looked up by DOM id since
    // these rows carry real coordinates and so render a distance span too.
    const checkbox0 = document.getElementById('sponsor-prop-0') as HTMLInputElement
    const checkbox1 = document.getElementById('sponsor-prop-1') as HTMLInputElement
    await user.click(checkbox0)
    await user.click(checkbox1)

    expect(distanceMiles).toHaveBeenCalledTimes(callsAfterMount)
  })
})
