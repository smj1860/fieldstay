import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const { reportErrorMock } = vi.hoisted(() => ({ reportErrorMock: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: reportErrorMock }))

import { resolvePortalScope, type PortalTokenRow } from '@/lib/owner-portal/token'

// ============================================================================
// resolvePortalScope() is the owner portal's ENTIRE tenant boundary — there is
// no signed-in user, only this opaque token. When a multi-property token's
// property_ids all resolve to zero live properties (every id since deleted or
// reassigned out of the org — properties do get deleted/re-org'd), the
// function has always fallen back to the single `primary` property so the
// portal never hard-fails. The bug this test guards against is that the
// fallback was SILENT: nothing signalled that an owner who should see several
// properties on a combined statement link just got narrowed to one, which is
// indistinguishable in the UI from "this owner genuinely has one property."
// ============================================================================

const ORG = 'org-1'

const primary = { id: 'prop-1', name: 'Lake House', address: null, city: null, state: null, zip: null }

function token(over: Partial<PortalTokenRow> = {}): PortalTokenRow {
  return {
    id: 'tok-1', expires_at: null, revoked_at: null, last_accessed_at: null,
    is_multi: true,
    property_ids: ['prop-1', 'prop-2', 'prop-3'],
    property_owners: {
      org_id: ORG, name: 'Jamie Owner',
      properties: primary,
    },
    ...over,
  }
}

function fakeSupabase(propsResult: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'in', 'eq', 'order', 'limit']) builder[m] = () => builder
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(propsResult).then(resolve)
  return { from: () => builder } as never
}

beforeEach(() => { reportErrorMock.mockClear() })

describe('resolvePortalScope', () => {
  it('resolves the full multi-property set when the query succeeds', async () => {
    const props = [
      { id: 'prop-1', name: 'Lake House', address: null, city: null, state: null, zip: null },
      { id: 'prop-2', name: 'Cabin', address: null, city: null, state: null, zip: null },
      { id: 'prop-3', name: 'Cottage', address: null, city: null, state: null, zip: null },
    ]
    const scope = await resolvePortalScope(fakeSupabase({ data: props, error: null }), token())

    expect(scope?.propertyIds).toEqual(['prop-1', 'prop-2', 'prop-3'])
    expect(reportErrorMock).not.toHaveBeenCalled()
  })

  it('falls back to the single primary property AND reports the collapse when the query returns zero rows', async () => {
    // Every id in property_ids was since deleted/reassigned — a real,
    // reachable state, not a query error.
    const scope = await resolvePortalScope(fakeSupabase({ data: [], error: null }), token())

    expect(scope?.propertyIds).toEqual(['prop-1'])
    expect(scope?.properties).toEqual([primary])
    // The signal the fix adds: this must NOT be indistinguishable from a
    // single-property owner.
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'owner-portal.resolvePortalScope', orgId: ORG }),
    )
  })

  it('does not report anything for an ordinary single-property token', async () => {
    const scope = await resolvePortalScope(
      fakeSupabase({ data: [], error: null }),
      token({ is_multi: false, property_ids: null }),
    )

    expect(scope?.propertyIds).toEqual(['prop-1'])
    expect(reportErrorMock).not.toHaveBeenCalled()
  })
})
