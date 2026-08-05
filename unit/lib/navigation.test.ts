import { describe, it, expect } from 'vitest'
import { ALL_NAV_ITEMS, getVisibleNavItems } from '@/lib/navigation'
import type { MemberRole } from '@/types/database'

describe('getVisibleNavItems', () => {
  it('returns only items whose roles include the given role', () => {
    const items = getVisibleNavItems('crew')
    // crew role is not listed on any ALL_NAV_ITEMS entry
    expect(items).toEqual([])
  })

  it('returns viewer-visible items for the viewer role', () => {
    const items = getVisibleNavItems('viewer')
    expect(items.map((i) => i.id)).toEqual(
      expect.arrayContaining(['ops', 'bookings', 'turnovers', 'properties', 'help']),
    )
    // viewer-excluded items should not appear
    expect(items.some((i) => i.id === 'settings')).toBe(false)
    expect(items.some((i) => i.id === 'maintenance')).toBe(false)
  })

  it('treats the owner role identically to admin', () => {
    const ownerItems = getVisibleNavItems('owner')
    const adminItems = getVisibleNavItems('admin')
    expect(ownerItems.map((i) => i.id)).toEqual(adminItems.map((i) => i.id))
  })

  it('includes admin-only items (e.g. settings) for admin but not manager', () => {
    const adminItems = getVisibleNavItems('admin')
    const managerItems = getVisibleNavItems('manager')
    expect(adminItems.some((i) => i.id === 'settings')).toBe(true)
    expect(managerItems.some((i) => i.id === 'settings')).toBe(false)
  })

  // Reviews used to carry condition:'repuguard' and was hidden unless
  // organizations.repuguard_status was 'active'. RepuGuard is included in
  // every plan now, and that column DEFAULTed to 'inactive' with only the
  // OwnerRez sync ever flipping it — so the nav item was hidden from any org
  // that never connected OwnerRez. The condition is gone entirely rather than
  // pinned permanently true.
  it('shows Reviews to every admin, with no feature condition', () => {
    const items = getVisibleNavItems('admin')
    expect(items.some((i) => i.id === 'reviews')).toBe(true)
  })

  it('excludes condition:"staff" items by default', () => {
    const items = getVisibleNavItems('admin')
    expect(items.some((i) => i.id === 'support-inbox')).toBe(false)
  })

  it('includes condition:"staff" items when isStaff is true', () => {
    const items = getVisibleNavItems('admin', { isStaff: true })
    expect(items.some((i) => i.id === 'support-inbox')).toBe(true)
  })

  it('respects the staff condition alongside unconditional items', () => {
    const items = getVisibleNavItems('admin', { isStaff: true })
    expect(items.some((i) => i.id === 'reviews')).toBe(true)
    expect(items.some((i) => i.id === 'support-inbox')).toBe(true)
  })

  it('preserves ALL_NAV_ITEMS declaration order in the filtered result', () => {
    const items = getVisibleNavItems('admin', { isStaff: true })
    const expectedOrder = ALL_NAV_ITEMS.filter((i) => items.some((v) => v.id === i.id)).map((i) => i.id)
    expect(items.map((i) => i.id)).toEqual(expectedOrder)
  })

  it('every declared role in ALL_NAV_ITEMS is a valid MemberRole', () => {
    const validRoles: MemberRole[] = ['owner', 'admin', 'manager', 'crew', 'viewer']
    for (const item of ALL_NAV_ITEMS) {
      for (const role of item.roles) {
        expect(validRoles).toContain(role)
      }
    }
  })
})
