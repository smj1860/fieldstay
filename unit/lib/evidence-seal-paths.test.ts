import { describe, it, expect } from 'vitest'
import { pathMatchesTarget, expectedPathPrefix, type CrewSealTarget } from '@/lib/evidence/seal-paths'
import { orgScopedStoragePath } from '@/lib/storage/object-path'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const TURNOVER = '33333333-3333-4333-8333-333333333333'
const ITEM = '55555555-5555-4555-8555-555555555555'
const PROP = '22222222-2222-4222-8222-222222222222'
const U = '66666666-6666-4666-8666-666666666666'

const item: CrewSealTarget = { table: 'checklist_instance_items', orgId: ORG, turnoverId: TURNOVER, itemId: ITEM }
const section: CrewSealTarget = { table: 'checklist_instances', orgId: ORG, turnoverId: TURNOVER }
const asset: CrewSealTarget = { table: 'property_assets', orgId: ORG, propertyId: PROP }

describe('pathMatchesTarget', () => {
  it('accepts exactly the paths the crew PWA writes (built with the same helper)', () => {
    expect(pathMatchesTarget(orgScopedStoragePath(ORG, `turnover-${TURNOVER}`, `${ITEM}-${U}.jpg`), item)).toBe(true)
    expect(pathMatchesTarget(orgScopedStoragePath(ORG, `turnover-${TURNOVER}`, `section-kitchen-${U}.jpg`), section)).toBe(true)
    expect(pathMatchesTarget(orgScopedStoragePath(ORG, 'asset-discovery', PROP, `hvac-${U}.jpg`), asset)).toBe(true)
  })

  it('rejects another item\'s photo, another turnover\'s, and a photo in another org', () => {
    const otherItem = '77777777-7777-4777-8777-777777777777'
    expect(pathMatchesTarget(orgScopedStoragePath(ORG, `turnover-${TURNOVER}`, `${otherItem}-${U}.jpg`), item)).toBe(false)
    expect(pathMatchesTarget(orgScopedStoragePath(ORG, 'turnover-99999999-0000-4000-8000-000000000000', `${ITEM}-${U}.jpg`), item)).toBe(false)
    expect(pathMatchesTarget(orgScopedStoragePath(OTHER_ORG, `turnover-${TURNOVER}`, `${ITEM}-${U}.jpg`), item)).toBe(false)
  })

  it('rejects a path of the wrong KIND for the target (a PM flag photo, a section path for an item)', () => {
    expect(pathMatchesTarget(orgScopedStoragePath(ORG, `turnover-${TURNOVER}`, `flag-${U}.jpg`), item)).toBe(false)
    expect(pathMatchesTarget(orgScopedStoragePath(ORG, `turnover-${TURNOVER}`, `section-x-${U}.jpg`), item)).toBe(false)
    expect(pathMatchesTarget(orgScopedStoragePath(ORG, `turnover-${TURNOVER}`, `${ITEM}-${U}.jpg`), section)).toBe(false)
    expect(pathMatchesTarget(orgScopedStoragePath(ORG, 'asset-discovery', '88888888-8888-4888-8888-888888888888', `hvac-${U}.jpg`), asset)).toBe(false)
  })

  it('rejects traversal and nested folders even when the prefix matches', () => {
    const prefix = `${ORG}/turnover-${TURNOVER}/${ITEM}-`
    expect(pathMatchesTarget(`${prefix}../../x.jpg`, item)).toBe(false)
    expect(pathMatchesTarget(`${prefix}a/b.jpg`, item)).toBe(false)
    expect(pathMatchesTarget(prefix, item)).toBe(false)
  })

  it('cannot derive a prefix without a turnover, so it rejects rather than guessing', () => {
    expect(expectedPathPrefix({ ...item, turnoverId: null })).toBeNull()
    expect(pathMatchesTarget(`${ORG}/turnover-null/${ITEM}-x.jpg`, { ...item, turnoverId: null })).toBe(false)
  })
})
