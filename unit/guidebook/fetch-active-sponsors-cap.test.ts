import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  resolveSponsorsForProperty,
  selectAutoSponsors,
  type ResolverSponsorRow,
} from '@/lib/guidebook/resolve-property-sponsors'
import { createSupabaseDouble } from '@/unit/stubs/supabase-query-double'
import { DEFAULT_PAGE_SIZE, SUPABASE_MAX_ROWS } from '@/lib/inngest/paginate'

// ============================================================================
// fetchActiveSponsors used to hard `.limit(64)` — generous headroom above the
// schema's real per-org ceiling (slot_number CHECK 1..6), but still a bound
// that silently truncated a guest-facing page's sponsor pool the moment the
// schema's ceiling was ever widened past it, with nothing to say so. It now
// paginates via fetchAllRows()/.range() instead, with no application-level
// cap — the query is bounded only by the org's real sponsor count.
//
// These tests prove the FULL result set is drained even past PostgREST's
// 1000-row max_rows, which the old .limit(64) never had to prove because it
// never asked for more than 64 rows in the first place.
// ============================================================================

function sponsorRow(id: string): ResolverSponsorRow {
  return {
    id, org_id: 'org_1', business_name: 'A Business', offer_type: 'none',
    offer_value: null, offer_item: null, custom_offer_text: null,
    lat: null, lng: null, slot_type: 'general', status: 'active',
    business_description: null, address: null, featured_item: null,
    business_phone: null, business_website: null, photo_storage_path: null,
  }
}

const AUTO_PROPERTY = { id: 'prop_1', lat: null, lng: null, sponsor_assignment_mode: 'auto' as const }

beforeEach(() => vi.clearAllMocks())

describe('fetchActiveSponsors — pagination instead of a hard cap', () => {
  it('drains every active sponsor even past PostgREST max_rows, with no application-level cap', async () => {
    // Comfortably past both the old 64-row cap and PostgREST's 1000-row
    // max_rows — a fixture only pagination, not a bigger .limit(), can pass.
    // Sized for three full DEFAULT_PAGE_SIZE (999) pages: two full pages plus
    // a short final one is what proves the drain doesn't stop after the
    // first max_rows-sized page.
    const total = SUPABASE_MAX_ROWS * 2 + 250
    const sponsors = Array.from({ length: total }, (_, i) => sponsorRow(`sp_${String(i).padStart(5, '0')}`))
    const supabase = createSupabaseDouble({ guidebook_sponsors: { data: sponsors, error: null } })

    const result = await resolveSponsorsForProperty(supabase as never, 'org_1', AUTO_PROPERTY)

    // selectAutoSponsors caps what's actually SHOWN on a property (four named
    // slots + filler), so this asserts against the pool it drew from rather
    // than the property's own result — the point here is the fetch, not the
    // per-property selection, which fetch-active-sponsors-cap never tested.
    expect(result.mode).toBe('auto')
    const rangeCalls = supabase.calls.filter((c) => c.table === 'guidebook_sponsors' && c.method === 'range')
    const P = DEFAULT_PAGE_SIZE
    expect(rangeCalls.map((c) => c.args)).toEqual([[0, P - 1], [P, 2 * P - 1], [2 * P, 3 * P - 1]])
  })

  it('still resolves normally for an ordinary org with well under 1000 sponsors', async () => {
    const sponsors = Array.from({ length: 5 }, (_, i) => sponsorRow(`sp_${i}`))
    const supabase = createSupabaseDouble({ guidebook_sponsors: { data: sponsors, error: null } })

    const result = await resolveSponsorsForProperty(supabase as never, 'org_1', AUTO_PROPERTY)

    expect(result.mode).toBe('auto')
  })

  it('selectAutoSponsors caps the PER-PROPERTY selection independent of the pool size fetched', () => {
    const pool = Array.from({ length: SUPABASE_MAX_ROWS + 10 }, (_, i) => sponsorRow(`sp_${i}`))
    const picked = selectAutoSponsors(pool, { lat: null, lng: null })

    expect(picked.length).toBeLessThanOrEqual(4)
  })

  it('paginates using .range() (real pagination), not .limit() (a fixed cap)', async () => {
    const sponsors = Array.from({ length: 10 }, (_, i) => sponsorRow(`sp_${i}`))
    const supabase = createSupabaseDouble({ guidebook_sponsors: { data: sponsors, error: null } })

    await resolveSponsorsForProperty(
      supabase as never, 'org_1', AUTO_PROPERTY,
    )

    expect(supabase.calls.some((c) => c.table === 'guidebook_sponsors' && c.method === 'limit')).toBe(false)
    expect(supabase.calls.some((c) => c.table === 'guidebook_sponsors' && c.method === 'range')).toBe(true)
  })
})
