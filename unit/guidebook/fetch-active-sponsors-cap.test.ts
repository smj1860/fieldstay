import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { resolveSponsorsForProperty, MAX_ACTIVE_SPONSORS_PER_ORG } from '@/lib/guidebook/resolve-property-sponsors'
import { reportError } from '@/lib/observability/report-error'

// ============================================================================
// fetchActiveSponsors' .limit(MAX_ACTIVE_SPONSORS_PER_ORG) is generous
// headroom above the schema's real per-org ceiling (slot_number CHECK 1..6),
// not the literal 6 — chosen so a modest widening of that constraint does not
// immediately start silently truncating here. But a hardcoded bound is still
// a bound: if the schema's ceiling is EVER raised past it, the query would
// quietly return a short list on a page that decides which sponsors a guest
// actually sees, with nothing to say so. This proves the truncation-detection
// signal fires exactly when the result set fills the cap.
// ============================================================================

type Row = { data?: unknown; error?: unknown }

function makeSupabase(sponsorRows: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sponsorsChain: any = {}
  for (const m of ['select', 'eq', 'order', 'limit']) {
    sponsorsChain[m] = vi.fn(() => sponsorsChain)
  }
  sponsorsChain.then = (resolve: (v: Row) => unknown) =>
    Promise.resolve({ data: sponsorRows, error: null }).then(resolve)

  return { from: vi.fn(() => sponsorsChain) }
}

function sponsorRow(id: string) {
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

describe('fetchActiveSponsors — cap-hit detection', () => {
  it('does NOT report when the org has fewer sponsors than the cap', async () => {
    const sponsors = Array.from({ length: 10 }, (_, i) => sponsorRow(`sp_${i}`))
    const supabase = makeSupabase(sponsors)

    await resolveSponsorsForProperty(supabase as never, 'org_1', AUTO_PROPERTY)

    expect(reportError).not.toHaveBeenCalled()
  })

  it('REPORTS a warning when the result set exactly fills the cap — likely truncation', async () => {
    const sponsors = Array.from({ length: MAX_ACTIVE_SPONSORS_PER_ORG }, (_, i) => sponsorRow(`sp_${i}`))
    const supabase = makeSupabase(sponsors)

    await resolveSponsorsForProperty(supabase as never, 'org_1', AUTO_PROPERTY)

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ orgId: 'org_1', level: 'warning' }),
    )
    const [err] = vi.mocked(reportError).mock.calls[0]!
    expect((err as Error).message).toContain(String(MAX_ACTIVE_SPONSORS_PER_ORG))
  })

  it('still resolves sponsors normally even when it reports the cap warning', async () => {
    // The warning is a signal, not a failure mode — the page must still
    // render with whatever the (possibly truncated) result set contains.
    const sponsors = Array.from({ length: MAX_ACTIVE_SPONSORS_PER_ORG }, (_, i) =>
      sponsorRow(`sp_${i}`))
    const supabase = makeSupabase(sponsors)

    const result = await resolveSponsorsForProperty(supabase as never, 'org_1', AUTO_PROPERTY)

    expect(result.mode).toBe('auto')
  })
})
