import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// A provider that does not carry a room count must not overwrite one.
//
// THE DEFECT: upsertNormalizedProperties' documented policy is "the PMS is the
// source of truth, every field is overwritten on every sync". That is right
// for a field the PMS actually has — and wrong for one it invents. Hostex's
// /properties exposes no bedrooms, bathrooms or occupancy at all, so its
// mapper filled FieldStay's own defaults (1/1/2) and the writer re-asserted
// them on every re-sync. A PM who corrected a Hostex import to four bedrooms
// got one back on the next sync, along with the checklist and smart pars
// derived from it.
//
// The mapper now says null — "this PMS has no opinion" — and that is what
// these pin: null preserves, a real number still overwrites, and a brand-new
// row still lands on FieldStay's defaults rather than on NULL.
// ============================================================================

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
        // The post-upsert external_id -> id re-select.
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

function normalized(over: Partial<NormalizedProperty> = {}): NormalizedProperty {
  return {
    external_id: 'ext-1',
    name:        'Lake House',
    address:     null, city: null, state: null, zip: null,
    bedrooms:    null, bathrooms: null, max_guests: null,
    checkin_time: '15:00', checkout_time: '11:00', timezone: 'America/Chicago',
    amenities: null, smoking_allowed: null, pets_allowed: null, events_allowed: null,
    wifi_name: null, wifi_password: null, access_instructions: null, house_manual: null,
    ...over,
  } as NormalizedProperty
}

/** The room-count columns of the single properties row that was upserted. */
function upsertedCounts() {
  const call = upsertSpy.mock.calls.find((c) => c[0] === 'properties')
  const row  = (call?.[1] as Record<string, unknown>[])[0]
  return { bedrooms: row.bedrooms, bathrooms: row.bathrooms, max_guests: row.max_guests }
}

beforeEach(() => {
  vi.clearAllMocks()
  existingRows.length = 0
})

describe('upsertNormalizedProperties — room counts', () => {
  it('keeps the PM’s counts when the provider has none', async () => {
    // The Hostex re-sync, exactly: PM corrected 1 -> 4 bedrooms, Hostex still
    // reports nothing.
    existingRows.push({
      external_id: 'ext-1', wifi_name: null, wifi_password: null,
      access_instructions: null, house_manual: null,
      bedrooms: 4, bathrooms: 3, max_guests: 8,
    })

    await upsertNormalizedProperties('org-1', 'hostex', [normalized()])

    expect(upsertedCounts()).toEqual({ bedrooms: 4, bathrooms: 3, max_guests: 8 })
  })

  it('preserves a legitimate 0, which a falsy fallback would overwrite', async () => {
    // A studio really has 0 bedrooms. `||` would read that as unset and write
    // the default back over it on every sync.
    existingRows.push({
      external_id: 'ext-1', wifi_name: null, wifi_password: null,
      access_instructions: null, house_manual: null,
      bedrooms: 0, bathrooms: 0, max_guests: 0,
    })

    await upsertNormalizedProperties('org-1', 'hostex', [normalized()])

    expect(upsertedCounts()).toEqual({ bedrooms: 0, bathrooms: 0, max_guests: 0 })
  })

  it('still overwrites when the provider DOES report a count', async () => {
    // Hospitable's capacity block is real data — the source-of-truth policy is
    // unchanged for a field the PMS actually carries.
    existingRows.push({
      external_id: 'ext-1', wifi_name: null, wifi_password: null,
      access_instructions: null, house_manual: null,
      bedrooms: 4, bathrooms: 3, max_guests: 8,
    })

    await upsertNormalizedProperties('org-1', 'hospitable', [
      normalized({ bedrooms: 2, bathrooms: 1, max_guests: 5 }),
    ])

    expect(upsertedCounts()).toEqual({ bedrooms: 2, bathrooms: 1, max_guests: 5 })
  })

  it('falls back to FieldStay’s defaults for a property that does not exist yet', async () => {
    // No existing row to preserve. NULL here would leave composeSections with
    // no bedroom sections at all, so the default applies once, at creation.
    await upsertNormalizedProperties('org-1', 'hostex', [normalized()])

    expect(upsertedCounts()).toEqual({ bedrooms: 1, bathrooms: 1, max_guests: 2 })
  })
})

// ============================================================================
// THE PAUSE SELF-HEALS.
//
// A property paused by a 404 (20260823170441) is excluded from the calendar
// cron until something clears the marker. Clearing it HERE — on the ordinary
// upsert every sync already performs — is what makes a provider outage, or a
// listing that comes back, need no intervention and no cron of its own.
//
// Without it the pause is permanent: a property would go quiet after one bad
// morning and stay quiet, which is a worse failure than the daily 404 it
// replaced, because nothing would be reporting it any more.
// ============================================================================
describe('external_missing_since', () => {
  it('is cleared by the upsert, because the provider just listed the property', async () => {
    await upsertNormalizedProperties('org-1', 'hospitable', [normalized()])

    const call = upsertSpy.mock.calls.find((c) => c[0] === 'properties')
    const row  = (call?.[1] as Record<string, unknown>[])[0]
    expect(row).toHaveProperty('external_missing_since', null)
  })
})
