import { describe, it, expect, vi, beforeEach } from 'vitest'

// A pin a PM set from a crew check-in (properties.location_pinned_at) must survive
// a provider sync. Hostaway and Hostex send lat/lng on every run; without this the
// ZIP-level pin comes back the next morning and every visit reads as away again.

const upsertSpy = vi.fn()
const existingRows: Array<Record<string, unknown>> = []

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      Object.assign(chain, {
        select: self, eq: self, in: self, order: self, limit: self, range: self, update: self,
        upsert: (rows: unknown, opts: unknown) => { upsertSpy(table, rows, opts); return chain },
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: existingRows.map((r) => ({ id: `id-${r.external_id}`, external_id: r.external_id })), error: null }),
      })
      return chain
    },
  }),
}))

vi.mock('@/lib/inngest/paginate', () => ({ fetchAllRows: vi.fn(async () => existingRows) }))
vi.mock('@/lib/geocoding', () => ({ geocodeZip: vi.fn(async () => null) }))
vi.mock('@/lib/audit', () => ({ logAuditEvents: vi.fn(async () => undefined) }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
import type { NormalizedProperty } from '@/lib/properties/normalize'

function normalized(external_id: string): NormalizedProperty {
  return {
    external_id, name: `Home ${external_id}`, lat: 36.0, lng: -86.0,
    address: null, city: null, state: null, zip: null,
    bedrooms: null, bathrooms: null, max_guests: null,
    checkin_time: '15:00', checkout_time: '11:00', timezone: 'America/Chicago',
    amenities: null, smoking_allowed: null, pets_allowed: null, events_allowed: null,
    wifi_name: null, wifi_password: null, access_instructions: null, house_manual: null,
  } as unknown as NormalizedProperty
}

function existing(external_id: string, location_pinned_at: string | null) {
  return {
    external_id, wifi_name: null, wifi_password: null, access_instructions: null, house_manual: null,
    bedrooms: 2, bathrooms: 1, max_guests: 4, location_pinned_at,
  }
}

const propertyBatches = () => upsertSpy.mock.calls.filter((c) => c[0] === 'properties').map((c) => c[1] as Record<string, unknown>[])

beforeEach(() => { vi.clearAllMocks(); existingRows.length = 0 })

describe('upsertNormalizedProperties: a PM-set pin', () => {
  it('does not write lat/lng for a pinned property, and still writes them for an unpinned one', async () => {
    existingRows.push(existing('pinned', '2026-10-17T12:00:00.000Z'), existing('auto', null))

    await upsertNormalizedProperties('org-1', 'hostex', [normalized('pinned'), normalized('auto')])

    const rows = propertyBatches().flat()
    const pinned = rows.find((r) => r.external_id === 'pinned')!
    const auto   = rows.find((r) => r.external_id === 'auto')!
    expect('lat' in pinned || 'lng' in pinned).toBe(false)
    expect(auto).toMatchObject({ lat: 36.0, lng: -86.0 })
  })

  it('writes provider coordinates for a brand-new property', async () => {
    await upsertNormalizedProperties('org-1', 'hostex', [normalized('new')])
    expect(propertyBatches().flat()[0]).toMatchObject({ lat: 36.0, lng: -86.0 })
  })
})
