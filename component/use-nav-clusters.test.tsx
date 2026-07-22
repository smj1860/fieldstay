import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { Building2 } from 'lucide-react'
import type { NavItem } from '@/lib/navigation'
import type { useNavClusters as UseNavClusters } from '@/lib/hooks/use-nav-clusters'

const STORAGE_KEY = 'fs-nav-clusters'

function makeNavItem(overrides: Partial<NavItem> = {}): NavItem {
  return {
    id: 'assets',
    href: '/assets',
    label: 'Assets',
    icon: Building2,
    roles: ['admin'],
    tier: 'management',
    category: 'Portfolio',
    ...overrides,
  }
}

// The hook's `clusterSnapshot` is a module-level variable read from
// localStorage exactly once at import time, so persisted-on-load behavior
// can only be observed by re-importing the module fresh (after seeding
// localStorage) rather than just clearing localStorage between tests.
async function loadHook(): Promise<typeof UseNavClusters> {
  vi.resetModules()
  const mod = await import('@/lib/hooks/use-nav-clusters')
  return mod.useNavClusters
}

describe('useNavClusters', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('defaults every category to expanded when nothing is persisted', async () => {
    const useNavClusters = await loadHook()
    const mgmtNav = [makeNavItem()]

    const { result } = renderHook(() => useNavClusters(mgmtNav, '/somewhere-else'))

    expect(result.current.isClusterExpanded('Portfolio')).toBe(true)
  })

  it('toggleCluster collapses an expanded category and persists the change', async () => {
    const useNavClusters = await loadHook()
    const mgmtNav = [makeNavItem()]

    const { result } = renderHook(() => useNavClusters(mgmtNav, '/somewhere-else'))
    expect(result.current.isClusterExpanded('Portfolio')).toBe(true)

    act(() => {
      result.current.toggleCluster('Portfolio')
    })

    expect(result.current.isClusterExpanded('Portfolio')).toBe(false)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ Portfolio: false })
  })

  it('toggleCluster flips back to expanded on a second call', async () => {
    const useNavClusters = await loadHook()
    const mgmtNav = [makeNavItem()]

    const { result } = renderHook(() => useNavClusters(mgmtNav, '/somewhere-else'))

    act(() => {
      result.current.toggleCluster('Portfolio')
    })
    expect(result.current.isClusterExpanded('Portfolio')).toBe(false)

    act(() => {
      result.current.toggleCluster('Portfolio')
    })
    expect(result.current.isClusterExpanded('Portfolio')).toBe(true)
  })

  it('forces a category expanded when the current path matches one of its items, even if collapsed', async () => {
    const useNavClusters = await loadHook()
    const mgmtNav = [makeNavItem({ href: '/assets' })]

    const { result } = renderHook(() => useNavClusters(mgmtNav, '/assets/123'))

    act(() => {
      result.current.toggleCluster('Portfolio')
    })

    // Collapsed in storage, but the active item forces it open anyway.
    expect(result.current.isClusterExpanded('Portfolio')).toBe(true)
  })

  it('matches the active path only on an exact href or a href/ prefix, not a loose prefix', async () => {
    const useNavClusters = await loadHook()
    const mgmtNav = [makeNavItem({ href: '/assets' })]

    const { result } = renderHook(() => useNavClusters(mgmtNav, '/assets-report'))
    act(() => {
      result.current.toggleCluster('Portfolio')
    })

    // '/assets-report' should NOT match '/assets' as an active item.
    expect(result.current.isClusterExpanded('Portfolio')).toBe(false)
  })

  it('loads a persisted collapsed state from localStorage on first mount', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ Portfolio: false }))
    const useNavClusters = await loadHook()
    const mgmtNav = [makeNavItem()]

    const { result } = renderHook(() => useNavClusters(mgmtNav, '/somewhere-else'))

    expect(result.current.isClusterExpanded('Portfolio')).toBe(false)
  })

  it('keeps multiple hook instances in sync when one toggles (module-level listener fan-out)', async () => {
    const useNavClusters = await loadHook()
    const mgmtNav = [makeNavItem()]

    const { result: a } = renderHook(() => useNavClusters(mgmtNav, '/somewhere-else'))
    const { result: b } = renderHook(() => useNavClusters(mgmtNav, '/somewhere-else'))

    act(() => {
      a.current.toggleCluster('Portfolio')
    })

    expect(a.current.isClusterExpanded('Portfolio')).toBe(false)
    expect(b.current.isClusterExpanded('Portfolio')).toBe(false)
  })

  it('unsubscribes on unmount without breaking remaining subscribers (no leaked listener)', async () => {
    const useNavClusters = await loadHook()
    const mgmtNav = [makeNavItem()]

    const { unmount: unmountA } = renderHook(() => useNavClusters(mgmtNav, '/somewhere-else'))
    const { result: b } = renderHook(() => useNavClusters(mgmtNav, '/somewhere-else'))

    unmountA()

    expect(() => {
      act(() => {
        b.current.toggleCluster('Portfolio')
      })
    }).not.toThrow()
    expect(b.current.isClusterExpanded('Portfolio')).toBe(false)
  })

  it('falls back to an empty (all-expanded) state when localStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage disabled')
    })
    const useNavClusters = await loadHook()
    const mgmtNav = [makeNavItem()]

    const { result } = renderHook(() => useNavClusters(mgmtNav, '/somewhere-else'))

    expect(result.current.isClusterExpanded('Portfolio')).toBe(true)
  })

  it('does not throw when localStorage.setItem is unavailable', async () => {
    const useNavClusters = await loadHook()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const mgmtNav = [makeNavItem()]

    const { result } = renderHook(() => useNavClusters(mgmtNav, '/somewhere-else'))

    expect(() => {
      act(() => {
        result.current.toggleCluster('Portfolio')
      })
    }).not.toThrow()
    // In-memory snapshot still updates even though persistence failed.
    expect(result.current.isClusterExpanded('Portfolio')).toBe(false)
  })
})
