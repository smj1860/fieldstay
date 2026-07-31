import { describe, it, expect } from 'vitest'
import { isStaleCrewDbName } from '@/lib/dexie/schema'

// Kept in its own file: the shadow/prune suite mocks @/lib/dexie/schema
// wholesale, which would replace the very function under test here.

describe('stale IndexedDB cleanup scoping', () => {
  const ME = '11111111-1111-1111-1111-111111111111'
  const OTHER = '22222222-2222-2222-2222-222222222222'

  it('deletes another crew user\'s cache and photo store', () => {
    expect(isStaleCrewDbName(`fieldstay-crew-${OTHER}`, ME)).toBe(true)
    expect(isStaleCrewDbName(`fieldstay-photo-queue-${OTHER}`, ME)).toBe(true)
  })

  it('never deletes the active user\'s own databases', () => {
    expect(isStaleCrewDbName(`fieldstay-crew-${ME}`, ME)).toBe(false)
    expect(isStaleCrewDbName(`fieldstay-photo-queue-${ME}`, ME)).toBe(false)
  })

  it('never touches a vendor outbox on a shared device', () => {
    // A vendor link token is not a user id, so the old `fieldstay-` prefix +
    // `includes(userId)` test destroyed queued vendor work-order completions
    // the moment any crew member logged in on the same device.
    expect(isStaleCrewDbName('fieldstay-vendor-wo-abc123token', ME)).toBe(false)
    expect(isStaleCrewDbName('fieldstay-vendor-wo-photos-abc123', ME)).toBe(false)
    expect(isStaleCrewDbName('some-other-app-db', ME)).toBe(false)
  })
})
